# yt_server.py

import asyncio
import logging
import os
import subprocess
import sys
from contextlib import asynccontextmanager

import yt_dlp
from fastapi import FastAPI, HTTPException
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
def parse_youtube(req: ParseRequest):
    ydl_opts = {
        "proxy": proxy,
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

            formats = info.get("formats", [])
            # 过滤：找 https 协议、带视频轨、带音频轨的 mp4 直链 (排除 m3u8)
            direct_formats = [
                f for f in formats
                if f.get("ext") == "mp4"
                   and f.get("vcodec") != "none"
                   and f.get("acodec") != "none"
                   and f.get("protocol") in ["https", "http"]
            ]

            # 排序：按分辨率从小到大
            direct_formats.sort(key=lambda x: x.get("height", 0))

            selected_format = None
            if direct_formats:
                if req.clarity_priority == "2":  # 高画质优先
                    selected_format = direct_formats[-1]
                else:  # 低画质优先 (寻找最接近 720p 的)
                    selected_format = next((f for f in reversed(direct_formats) if f.get("height", 0) >= 720),
                                           direct_formats[-1])
            else:
                # 实在找不到封装好的，找最高画质的混合流兜底
                video_only = [f for f in formats if
                              f.get("vcodec") != "none" and f.get("protocol") in ["https", "http"]]
                if video_only:
                    video_only.sort(key=lambda x: x.get("height", 0))
                    selected_format = video_only[-1]

            if not selected_format:
                raise ValueError("未能找到可用的视频直链")

            # 返回给 Koishi 数据结构
            return {
                "success": True,
                "title": info.get("title", "未知标题"),
                "author": info.get("uploader", info.get("channel", "未知作者")),
                "description": info.get("description", ""),
                "cover": info.get("thumbnail", ""),
                "views": info.get("view_count", 0),
                "likes": info.get("like_count", 0),
                "comments": info.get("comment_count", 0),
                "direct_url": selected_format.get("url")
            }

    except Exception as e:
        logging.error(f"解析失败: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=12001)
