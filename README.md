# koishi-plugin-share-links-analysis

# 视频链接解析插件说明 📺✨

本插件为用户提供便捷的分享链接链接解析服务，让聊天体验更加丰富多彩。

---

## 鸣谢 💖

本插件的解析能力与稳定运行，离不开以下开源项目及社区文档的强大支撑。特此向这些项目及其维护者致以最诚挚的感谢：

- [koishi-plugin-bilibili-videolink-analysis](https://github.com/shangxueink/koishi-shangxue-apps/tree/main/plugins/bilibili-videolink-analysis)
- [koishi-plugin-bili-parser](https://github.com/summonhim/koishi-plugin-bili-parser)
- [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)
- [koishi-plugin-xiaohongshu](https://www.npmjs.com/package/koishi-plugin-xiaohongshu)
以及解析方式原作者：[@MuJie](https://mu-jie.cc/)
- [BetterTwitFix](https://github.com/dylanpdx/BetterTwitFix)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)

---

## 🚀 YouTube 解析后端部署指南 (必看)

由于 YouTube 引入了极其严苛的反爬机制，传统的直连解析已全部失效。为了保证解析的稳定，本插件采用了 **“前端 Koishi + 后端 Python 微服务”** 的分离架构。

Python 后端利用 `yt-dlp` 的最新特性，通过调用本地 Node.js 实时计算 YouTube 签名，并已内置自动热更新。

### 部署环境要求
- **Python 3.8+**
- **Node.js** (⚠️ 必须安装！`yt-dlp` 需要调用 Node 环境来执行 JS 脚本破解签名)
- **一个能够正常访问 YouTube 的网络代理** (强烈建议使用流媒体解锁节点)

### 部署步骤

**1. 下载后端脚本**
将本仓库内的 `yt_server.py` 下载到你的服务器上：
```bash
wget https://raw.githubusercontent.com/furryaxw/share-links-analysis/Master/yt_server.py
```

**2. 安装 Python 依赖**
```bash
pip install httpx fastapi uvicorn yt-dlp
```

**3. 配置网络代理 (重要)**
请使用编辑器（如 vim 或 nano）打开 `yt_server.py`，在文件顶部找到代理配置区域，**将地址修改为你自己的真实代理**：
```python
# =====================================
# 配置代理
proxy = "http://127.0.0.1:7890" # 👈 在这里填入你的代理IP和端口
# =====================================
```

**4. 启动微服务**
```bash
python yt_server.py
```
*(注：由于脚本内置了自动更新热重启逻辑，强烈建议直接使用上述命令启动，或者使用 `pm2 start yt_server.py --name yt-api --interpreter python3` 进行后台进程守护。)*

**5. 在 Koishi 中配置**
确保 Python 服务成功运行（默认监听 `12001` 端口）后，回到 Koishi 控制台的本插件配置页。
在 `youtube_pythonApiUrl` 配置项中填入你的后端地址：
```text
http://127.0.0.1:12001/api/parse
```
*(如果你的 Python 服务部署在其他服务器上，请将 `127.0.0.1` 替换为对应的服务器 IP)*

🎉 配置完成！现在你可以尽情享受丝滑的 YouTube 视频与 Shorts 解析了！
