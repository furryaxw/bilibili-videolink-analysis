# yt_server.py

import asyncio
import logging
import os
import subprocess
import sys
import urllib.parse
from contextlib import asynccontextmanager

import httpx
import yt_dlp
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# =====================================
# 配置代理
proxy = "http://127.0.0.1:7890"
# =====================================


logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


# ================= 自动更新模块 =================
def check_and_update_ytdlp():
    logging.info("开始检测 yt-dlp 是否有新版本...")
    try:
        # 调用 pip 升级命令
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", "-U", "yt-dlp"],
            capture_output=True, text=True
        )
        # 检查输出中是否包含更新成功的关键字
        if "Successfully installed" in result.stdout:
            logging.info(f"yt-dlp 更新成功！\n{result.stdout.strip()}")
            logging.warning("检测到核心库变更，正在热重启微服务以加载新版本...")
            # 核心黑科技：用新的进程替换掉旧的进程，实现无缝热重启
            os.execv(sys.executable, [sys.executable] + sys.argv)
        else:
            logging.info("当前 yt-dlp 已是最新版本，无需更新。")
    except Exception as e:
        logging.error(f"自动更新检测失败: {e}")


async def auto_update_loop():
    while True:
        # 每 12 小时 (43200秒) 自动检测一次更新
        await asyncio.sleep(43200)
        check_and_update_ytdlp()


# 生命周期管理：服务启动时和运行期间的行为
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1. 启动服务前先强行拉取一次最新版
    check_and_update_ytdlp()
    # 2. 挂载后台定时更新任务
    update_task = asyncio.create_task(auto_update_loop())
    yield
    # 3. 服务关闭时清理任务
    update_task.cancel()


# ================= 接口业务模块 =================
app = FastAPI(lifespan=lifespan)


class ParseRequest(BaseModel):
    url: str
    clarity_priority: str = "1"  # "1"低画质优先, "2"高画质优先


@app.post("/api/parse")
async def parse_youtube(req: ParseRequest, request: Request):
    if req.clarity_priority == "2":
        # 高画质优先：寻找原生包含音视频的最高画质 MP4 (通常最高为 720p)
        format_selection = "best[ext=mp4]/best"
    else:
        # 低画质优先：限制最高不超过 480p 的预封装 MP4，兼顾节省带宽与基本可看性
        # 如果没有 480p 及其以下的，则回退到最差的画质兜底
        format_selection = "best[height<=480][ext=mp4]/worst[ext=mp4]/worst"

    ydl_opts = {
        "proxy": proxy,
        "format": format_selection,
        "js_runtimes": {"node": {}},
        "remote_components": ["ejs:github"],
        "http_headers": {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
        "extractor_args": {"youtube": {"client": ["android", "ios", "tv"]}},
        "quiet": True,
        "no_warnings": True,
        # "cookiefile": "cookies.txt",
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            # 只提取信息，不下载实体文件
            info = ydl.extract_info(req.url, download=False)

            raw_url = info.get("url")
            if not raw_url:
                raise ValueError("未能找到可用的音视频直链")

            # 构造流式代理 URL，提供给 Koishi
            base_url = str(request.base_url)
            encoded_raw_url = urllib.parse.quote(raw_url, safe="")

            # 拼接流式透传通道的地址
            stream_url = f"{base_url}api/stream?video_url={encoded_raw_url}"

            return {
                "success": True,
                "title": info.get("title", "未知标题"),
                "author": info.get("uploader", info.get("channel", "未知作者")),
                "description": info.get("description", ""),
                "cover": info.get("thumbnail", ""),
                "views": info.get("view_count", 0),
                "likes": info.get("like_count", 0),
                "comments": info.get("comment_count", 0),
                "direct_url": stream_url
            }

    except Exception as e:
        logging.error(f"解析失败: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))


@app.api_route("/api/stream", methods=["GET", "HEAD"])
async def proxy_stream(request: Request, video_url: str):
    """
    核心代理流式传输管道。
    负责响应 Koishi 发来的 HEAD 请求 (大小探测) 和 GET 请求 (实际下载)。
    """
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

    # 无缝透传 Koishi 发来的 Range 头，支持断点续传或探测请求
    if "range" in request.headers:
        headers["Range"] = request.headers["range"]

    client = httpx.AsyncClient(proxy=proxy, verify=False, follow_redirects=True)

    try:
        # 如果是 Koishi 的 getFileSize 探测请求
        if request.method == "HEAD":
            resp = await client.head(video_url, headers=headers)
            return Response(
                status_code=resp.status_code,
                headers={
                    "Content-Length": resp.headers.get("Content-Length", ""),
                    "Accept-Ranges": resp.headers.get("Accept-Ranges", "bytes"),
                    "Content-Type": resp.headers.get("Content-Type", "video/mp4")
                }
            )

        # 如果是正式下载请求，建立流式通道
        req = client.build_request("GET", video_url, headers=headers)
        resp = await client.send(req, stream=True)

        # 保留必要的响应头回传给 Koishi
        resp_headers = {
            "Content-Length": resp.headers.get("Content-Length", ""),
            "Content-Range": resp.headers.get("Content-Range", ""),
            "Accept-Ranges": resp.headers.get("Accept-Ranges", "bytes"),
            "Content-Type": resp.headers.get("Content-Type", "video/mp4")
        }
        resp_headers = {k: v for k, v in resp_headers.items() if v}

        # 启动流式响应返回数据，结束时自动关闭连接释放内存
        return StreamingResponse(
            resp.aiter_bytes(chunk_size=1024 * 1024), # 每次透传 1MB 数据块
            status_code=resp.status_code,
            headers=resp_headers,
            background=client.aclose
        )
    except Exception as e:
        await client.aclose()
        logging.error(f"流媒体代理中断: {str(e)}")
        raise HTTPException(status_code=500, detail="视频流传输中断")

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=12001)
