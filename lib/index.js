"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.apply = exports.usage = exports.Config = exports.name = exports.inject = void 0;
const koishi_1 = require("koishi");
const { Schema, Logger, h } = require("koishi");
const logger = new Logger('bilibili-videolink-analysis');
exports.name = 'bilibili-videolink-analysis';
exports.inject = {
    optional: ['puppeteer'],
    required: ['BiliBiliVideo']
}
exports.usage = `

<h1>→ <a href="https://www.npmjs.com/package/koishi-plugin-bilibili-videolink-analysis" target="_blank">可以点击这里查看详细的文档说明✨</a></h1>

✨ 只需开启插件，就可以解析B站视频的链接啦~ ✨

向bot发送B站视频链接吧~

会返回视频信息与视频哦

---

#### ⚠️ **如果你使用不了本项目，请优先检查：** ⚠️
####   若无注册的指令，请关开一下[command插件](/market?keyword=commands+email:shigma10826@gmail.com)（没有指令也不影响解析别人的链接）
####   视频内容是否为B站的大会员专属视频/付费视频/充电专属视频
####   是否正确配置并启动了[bilibili-login插件](/market?keyword=bilibili-login)  （启动即可，不是必须登录）
####   接入方法是否支持获取网址链接/小程序卡片消息
####   接入方法是否支持视频元素的发送
####   发送视频超时/其他网络问题
####   视频内容被平台屏蔽/其他平台因素

---

###  注意，点播功能需要使用 puppeteer 服务

点播功能是为了方便群友一起刷B站哦~

比如：搜索 “遠い空へ” 的第二页，并且结果以语音格式返回

示例：\`点播 遠い空へ -a  -p 2\`  


---

### 特别鸣谢 💖

特别鸣谢以下项目的支持：

- [@summonhim/koishi-plugin-bili-parser](/market?keyword=bili-parser)
- [koishi-plugin-iirose-media-request](/market?keyword=iirose-media-request)

---

`;

exports.Config = Schema.intersect([
    Schema.object({
        timeout: Schema.number().role('slider').min(1).max(300).step(1).default(60).description('指定播放视频的输入时限。`单位 秒`'),
        point: Schema.tuple([Number, Number]).description('序号标注位置。分别表示`距离顶部 距离左侧`的百分比').default([50, 50]),
        enable: Schema.boolean().description('是否开启自动解析`选择对应视频 会自动解析视频内容`').default(true),
    }).description('点播设置（需要puppeteer服务）'),

    Schema.object({
        waitTip_Switch: Schema.union([
            Schema.const().description('不返回文字提示'),
            Schema.string().description('返回文字提示（请在右侧填写文字内容）'),
        ]).description("是否返回等待提示。开启后，会发送`等待提示语`"),
        linktextParsing: Schema.boolean().default(true).description("是否返回 视频图文数据 `开启后，才发送视频数据的图文解析。`"),
        VideoParsing_ToLink: Schema.union([
            Schema.const('1').description('不返回视频/视频直链'),
            Schema.const('2').description('仅返回视频'),
            Schema.const('3').description('仅返回视频直链'),
            Schema.const('4').description('返回视频和视频直链'),
            Schema.const('5').description('返回视频，仅在日志记录视频直链'),
        ]).role('radio').default('2').description("是否返回` 视频/视频直链 `"),
        Video_ClarityPriority: Schema.union([
            Schema.const('1').description('低清晰度优先（低清晰度的视频发得快一点）'),
            Schema.const('2').description('高清晰度优先（清晰的还是去B站看吧）'),
        ]).role('radio').default('1').description("发送的视频清晰度优先策略"),
        BVnumberParsing: Schema.boolean().default(true).description("是否允许根据`独立的BV号`解析视频 `开启后，可以通过视频的BV号解析视频。` <br>  [触发说明见README](https://www.npmjs.com/package/koishi-plugin-bilibili-videolink-analysis)"),
        Maximumduration: Schema.number().default(25).description("允许解析的视频最大时长（分钟）`超过这个时长 就不会发视频`").min(1),
        Maximumduration_tip: Schema.union([
            Schema.const('不返回文字提示').description('不返回文字提示'),
            Schema.string().description('返回文字提示（请在右侧填写文字内容）').default('视频太长啦！还是去B站看吧~'),
        ]).description("对过长视频的文字提示内容").default('视频太长啦！还是去B站看吧~'),
        MinimumTimeInterval: Schema.number().default(180).description("若干`秒`内 不再处理相同链接 `防止多bot互相触发 导致的刷屏/性能浪费`").min(1),
    }).description("基础设置"),

    Schema.object({
        parseLimit: Schema.number().default(3).description("单对话多链接解析上限").hidden(),
        useNumeral: Schema.boolean().default(true).description("使用格式化数字").hidden(),
        showError: Schema.boolean().default(false).description("当链接不正确时提醒发送者").hidden(),
        bVideoIDPreference: Schema.union([
            Schema.const("bv").description("BV 号"),
            Schema.const("av").description("AV 号"),
        ]).default("bv").description("ID 偏好").hidden(),
        bVideoImage: Schema.boolean().default(true).description("显示封面"),
        bVideoOwner: Schema.boolean().default(true).description("显示 UP 主"),
        bVideoDesc: Schema.boolean().default(false).description("显示简介`有的简介真的很长`"),
        bVideoStat: Schema.boolean().default(true).description("显示状态（*三连数据*）"),
        bVideoExtraStat: Schema.boolean().default(true).description("显示额外状态（*弹幕&观看*）"),
        bVideoShowLink: Schema.boolean().default(false).description("显示视频链接`开启可能会导致其他bot循环解析`"),
    }).description("链接的图文解析设置"),

    Schema.object({
        userAgent: Schema.string().description("所有 API 请求所用的 User-Agent").default("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
        loggerinfo: Schema.boolean().default(false).description("日志调试输出 `日常使用无需开启`"),
    }).description("调试设置"),
]);

function apply(ctx, config) {
    const bilibiliVideo = ctx.BiliBiliVideo;
    ctx.middleware(async (session, next) => {
        // 如果允许解析 BV 号，则进行解析
        if (config.BVnumberParsing) {
            const bvUrls = convertBVToUrl(session.content);
            if (bvUrls.length > 0) {
                session.content += '\n' + bvUrls.join('\n');
            }
        }
        const links = await isProcessLinks(session, config, ctx, lastProcessedUrls, logger); // 判断是否需要解析
        if (links) {
            const ret = await extractLinks(session, config, ctx, lastProcessedUrls, logger); // 提取链接
            if (ret && !isLinkProcessedRecently(ret, lastProcessedUrls, config, logger)) {
                await processVideoFromLink(session, config, ctx, lastProcessedUrls, logger, ret); // 解析视频并返回
            }
        }
        return next();
    });

    ctx.command('点播 [keyword]', '点播B站视频')
        .option('video', '-v 解析返回视频')
        .option('audio', '-a 解析返回语音')
        .option('link', '-l 解析返回链接')
        .option('page', '-p <page:number> 指定页数', { fallback: '1' })
        .example('点播   遠い空へ  -v')
        .action(async ({ options, session }, keyword) => {
            if (!keyword) {
                await session.execute('点播 -h')
                return '没输入keyword'
            }


            const url = `https://search.bilibili.com/video?keyword=${encodeURIComponent(keyword)}&page=${options.page}&o=30`
            const page = await ctx.puppeteer.page()

            await page.goto(url, {
                waitUntil: 'networkidle2'
            })

            await page.addStyleTag({
                content: `
          div.bili-header, 
          div.login-tip, 
          div.v-popover, 
          div.right-entry__outside {
            display: none !important;
          }
        `
            })
            // 获取视频列表并为每个视频元素添加序号
            const videos = await page.evaluate((point) => {
                const items = Array.from(document.querySelectorAll('.video-list-item:not([style*="display: none"])'))
                return items.map((item, index) => {
                    const link = item.querySelector('a')
                    const href = link?.getAttribute('href') || ''
                    const idMatch = href.match(/\/video\/(BV\w+)\//)
                    const id = idMatch ? idMatch[1] : ''

                    if (!id) {
                        // 如果没有提取到视频ID，隐藏这个元素
                        //const htmlElement = item as HTMLElement
                        const htmlElement = item
                        htmlElement.style.display = 'none'
                    } else {
                        // 创建一个包含序号的元素，并将其插入到视频元素的正中央
                        const overlay = document.createElement('div')
                        overlay.style.position = 'absolute'
                        overlay.style.top = `${point[0]}%`
                        overlay.style.left = `${point[1]}%`
                        overlay.style.transform = 'translate(-50%, -50%)'
                        overlay.style.fontSize = '48px'
                        overlay.style.fontWeight = 'bold'
                        overlay.style.color = 'black'
                        overlay.style.zIndex = '10'
                        overlay.style.backgroundColor = 'rgba(255, 255, 255, 0.7)'  // 半透明白色背景，确保数字清晰可见
                        overlay.style.padding = '10px'
                        overlay.style.borderRadius = '8px'
                        overlay.textContent = `${index + 1}` // 序号

                        // 确保父元素有 `position: relative` 以正确定位
                        //const videoElement = item as HTMLElement
                        const videoElement = item
                        videoElement.style.position = 'relative'
                        videoElement.appendChild(overlay)
                    }

                    return { id }
                }).filter(video => video.id)
            }, config.point) // 传递配置的 point 参数

            // 如果开启了日志调试模式，打印获取到的视频信息
            if (config.loggerinfo) {
                ctx.logger.info(options)
                ctx.logger.info(`共找到 ${videos.length} 个视频:`)
                videos.forEach((video, index) => {
                    ctx.logger.info(`序号 ${index + 1}: ID - ${video.id}`)
                })
            }

            if (videos.length === 0) {
                await page.close()
                return '未找到相关视频。'
            }

            // 动态调整窗口大小以适应视频数量
            const viewportHeight = 200 + videos.length * 100
            await page.setViewport({
                width: 1440,
                height: viewportHeight
            })
            let msg;
            // 截图
            const videoListElement = await page.$('.video-list.row')
            if (videoListElement) {
                const imgBuf = await videoListElement.screenshot({
                    captureBeyondViewport: false
                })
                msg = h.image(imgBuf, 'image/png')
            }

            await page.close()

            // 发送截图
            await session.send(msg)

            // 提示用户输入
            await session.send(`请选择视频的序号：`)

            // 等待用户输入
            const userChoice = await session.prompt(config.timeout * 1000)
            const choiceIndex = parseInt(userChoice) - 1
            if (isNaN(choiceIndex) || choiceIndex < 0 || choiceIndex >= videos.length) {
                return '输入无效，请输入正确的序号。'
            }

            // 返回用户选择的视频ID
            const chosenVideo = videos[choiceIndex]

            // 如果开启了日志调试模式，打印用户选择的视频信息
            if (config.loggerinfo) {
                ctx.logger.info(`渲染序号设置\noverlay.style.top = ${config.point[0]}% \noverlay.style.left = ${config.point[1]}80%`)
                ctx.logger.info(`用户选择了序号 ${choiceIndex + 1}: ID - ${chosenVideo.id}`)
            }

            if (config.enable) { // 开启自动解析了
                session.content = `https://www.bilibili.com/video/${chosenVideo.id}`
                const ret = await extractLinks(session, config, ctx, lastProcessedUrls, logger); // 提取链接
                if (ret && !isLinkProcessedRecently(ret, lastProcessedUrls, config, logger)) {
                    await processVideoFromLink(session, config, ctx, lastProcessedUrls, logger, ret, options); // 解析视频并返回
                }
            }
        })


    //判断是否需要解析
    async function isProcessLinks(session, config, ctx, lastProcessedUrls, logger) {
        // 解析内容中的链接
        const links = link_type_parser(session.content);
        if (links.length === 0) {
            return false; // 如果没有找到链接，返回 false
        }

        return links; // 返回解析出的链接
    }

    //提取链接 
    async function extractLinks(session, config, ctx, lastProcessedUrls, logger) {
        const links = link_type_parser(session.content);
        let ret = "";
        ret += [(0, h)("quote", { id: session.messageId })];
        let countLink = 0;
        let tp_ret;

        // 循环检测链接类型
        for (const element of links) {
            if (countLink >= 1) ret += "\n";
            if (countLink >= config.parseLimit) {
                ret += "已达到解析上限…";
                break;
            }
            tp_ret = await (0, type_processer)(ctx, config, element);
            if (tp_ret == "") {
                if (config.showError)
                    ret = "无法解析链接信息。可能是 ID 不存在，或该类型可能暂不支持。";
                else
                    ret = null;
            } else {
                ret += tp_ret;
            }
            countLink++;
        }
        return ret;
    }

    //判断链接是否已经处理过
    function isLinkProcessedRecently(ret, lastProcessedUrls, config, logger) {
        const lastretUrl = extractLastUrl(ret); // 提取 ret 最后一个 http 链接作为解析目标
        const currentTime = Date.now();

        if (lastProcessedUrls[lastretUrl] && (currentTime - lastProcessedUrls[lastretUrl] < config.MinimumTimeInterval * 1000)) {
            if (config.loggerinfo) {
                logger.info(`重复出现，略过处理：\n ${lastretUrl}`);
            }
            return true; // 已经处理过
        }

        // 更新该链接的最后处理时间
        lastProcessedUrls[lastretUrl] = currentTime;
        return false; // 没有处理过
    }

    //解析视频并返回 
    async function processVideoFromLink(session, config, ctx, lastProcessedUrls, logger, ret, options = { video: true }) {
        const lastretUrl = extractLastUrl(ret);
        let bilibilimediaDataURL = '';
        let mediaData = '';

        if (config.waitTip_Switch) {
            // 等候的提示文字
            await session.send(config.waitTip_Switch);
        }

        if (config.linktextParsing) {
            if (config.bVideoShowLink) {
                await session.send(ret); // 发送完整信息
            } else {
                // 去掉最后一个链接
                const retWithoutLastLink = ret.replace(lastretUrl, '');
                await session.send(retWithoutLastLink);
            }
        }

        if (config.VideoParsing_ToLink) {
            const mediaDataString = JSON.stringify(await handleBilibiliMedia(bilibiliVideo, lastretUrl, config));
            mediaData = JSON.parse(mediaDataString);
            bilibilimediaDataURL = mediaData[0].url;
            const videoDuration = mediaData[0].duration; // 提取视频时长，单位为秒

            if (videoDuration > config.Maximumduration * 60) {
                if (config.Maximumduration_tip) {
                    await session.send(config.Maximumduration_tip);
                }
                return;
            }
            if (options.link) { // 发送链接
                await session.send(h.text(bilibilimediaDataURL));
                return;
            } else if (options.audio) { // 发送语音
                await session.send(h.audio(bilibilimediaDataURL));
                return;
            } else {  //  默认发送视频
                // 根据配置的值来决定发送的内容
                switch (config.VideoParsing_ToLink) {
                    case '1': // 不返回视频/视频直链
                        break;
                    case '2': // 仅返回视频
                        await session.send(h.video(bilibilimediaDataURL)); // 发送视频
                        break;
                    case '3': // 仅返回视频直链
                        await session.send(h.text(bilibilimediaDataURL)); // 发送视频直链
                        break;
                    case '4': // 返回视频和视频直链
                        await session.send(h.text(bilibilimediaDataURL)); // 先发送视频直链
                        await session.send(h.video(bilibilimediaDataURL)); // 发送视频
                        break;
                    case '5': // 返回视频，记录视频链接
                        await logger.info(bilibilimediaDataURL); // 先记录日志
                        await session.send(h.video(bilibilimediaDataURL)); // 发送视频
                        break;
                    default:
                        // 处理默认情况或者错误配置
                        break;
                }
            }
        }

        if (config.loggerinfo) {
            logger.info(`视频信息内容：\n ${JSON.stringify(mediaData)}`);
            logger.info(`机器人发送完整消息为：\n ${ret}`);
        }
        return;
    }


    // 提取最后一个URL
    function extractLastUrl(text) {
        const urlPattern = /https?:\/\/[^\s]+/g;
        const urls = text.match(urlPattern);
        return urls ? urls.pop() : null;
    }

    // 检测BV号并转换为URL
    function convertBVToUrl(text) {
        const bvPattern = /(?:^|\s)(BV\w{10})(?:\s|$)/g;
        const bvMatches = [];
        let match;
        while ((match = bvPattern.exec(text)) !== null) {
            bvMatches.push(match[1]);
        }
        return bvMatches.length ? bvMatches.map(bv => `https://www.bilibili.com/video/${bv}`) : [];
    }

    // 记录上次处理链接的时间
    const lastProcessedUrls = {};

    /////////////////////////////////////////////////////////////////////////////////////////////////////////

    function numeral(number, config) {
        if (config.useNumeral) {
            if (number >= 10000 && number < 100000000) {
                return (number / 10000).toFixed(1) + "万";
            }
            else if (number >= 100000000) {
                return (number / 100000000).toFixed(1) + "亿";
            }
            else {
                return number.toString();
            }
        }
        else {
            return number;
        }
    }

    class Bili_Video {
        ctx;
        config;
        constructor(ctx, config) {
            this.ctx = ctx;
            this.config = config;
        }
        /**
         * 解析 ID 类型
         * @param id 视频 ID
         * @returns type: ID 类型, id: 视频 ID
         */
        vid_type_parse(id) {
            var idRegex = [
                {
                    pattern: /av([0-9]+)/i,
                    type: "av",
                },
                {
                    pattern: /bv([0-9a-zA-Z]+)/i,
                    type: "bv",
                },
            ];
            for (const rule of idRegex) {
                var match = id.match(rule.pattern);
                if (match) {
                    return {
                        type: rule.type,
                        id: match[1],
                    };
                }
            }
            return {
                type: null,
                id: null,
            };
        }
        /**
         * 根据视频 ID 查找视频信息
         * @param id 视频 ID
         * @returns 视频信息 Json
         */
        async fetch_video_info(id) {
            var ret;
            const vid = this.vid_type_parse(id);
            switch (vid["type"]) {
                case "av":
                    ret = await this.ctx.http.get("https://api.bilibili.com/x/web-interface/view?aid=" + vid["id"], {
                        headers: {
                            "User-Agent": this.config.userAgent,
                        },
                    });
                    break;
                case "bv":
                    ret = await this.ctx.http.get("https://api.bilibili.com/x/web-interface/view?bvid=" + vid["id"], {
                        headers: {
                            "User-Agent": this.config.userAgent,
                        },
                    });
                    break;
                default:
                    ret = null;
                    break;
            }
            return ret;
        }
        /**
         * 生成视频信息
         * @param id 视频 ID
         * @returns 文字视频信息
         */
        async gen_context(id) {
            const info = await this.fetch_video_info(id);
            if (!info || !info["data"])
                return null;
            var ret = `${info["data"]["title"]}\n`;
            this.config.bVideoImage
                ? (ret += `<img src=\"${info["data"]["pic"]}\"/>\n`)
                : null;
            this.config.bVideoOwner
                ? (ret += `UP主： ${info["data"]["owner"]["name"]}\n`)
                : null;
            this.config.bVideoDesc ? (ret += `${info["data"]["desc"]}\n`) : null;
            this.config.bVideoStat
                ? (ret += `点赞：${(0, numeral)(info["data"]["stat"]["like"], this.config)}\t\t投币：${(0, numeral)(info["data"]["stat"]["coin"], this.config)}\n`)
                : null;
            this.config.bVideoStat
                ? (ret += `收藏：${(0, numeral)(info["data"]["stat"]["favorite"], this.config)}\t\t转发：${(0, numeral)(info["data"]["stat"]["share"], this.config)}\n`)
                : null;
            this.config.bVideoExtraStat
                ? (ret += `观看：${(0, numeral)(info["data"]["stat"]["view"], this.config)}\t\t弹幕：${(0, numeral)(info["data"]["stat"]["danmaku"], this.config)}\n`)
                : null;
            switch (this.config.bVideoIDPreference) {
                case "bv":
                    ret += `https://www.bilibili.com/video/${info["data"]["bvid"]}\n`;
                    break;
                case "av":
                    ret += `https://www.bilibili.com/video/av${info["data"]["aid"]}\n`;
                    break;
                default:
                    break;
            }
            return ret;
        }
    }

    /**
     * 链接类型解析
     * @param content 传入消息
     * @returns type: "链接类型", id :"内容ID"
     */
    function link_type_parser(content) {
        var linkRegex = [
            {
                pattern: /bilibili\.com\/video\/([ab]v[0-9a-zA-Z]+)/gim,
                type: "Video",
            },
            {
                pattern: /live\.bilibili\.com(?:\/h5)?\/(\d+)/gim,
                type: "Live",
            },
            {
                pattern: /bilibili\.com\/bangumi\/play\/((ep|ss)(\d+))/gim,
                type: "Bangumi",
            },
            {
                pattern: /bilibili\.com\/bangumi\/media\/(md(\d+))/gim,
                type: "Bangumi",
            },
            {
                pattern: /bilibili\.com\/read\/cv(\d+)/gim,
                type: "Article",
            },
            {
                pattern: /bilibili\.com\/read\/mobile(?:\?id=|\/)(\d+)/gim,
                type: "Article",
            },
            {
                pattern: /bilibili\.com\/audio\/au(\d+)/gim,
                type: "Audio",
            },
            {
                pattern: /bilibili\.com\/opus\/(\d+)/gim,
                type: "Opus",
            },
            // {
            //   pattern: /space\.bilibili\.com\/(\d+)/gim,
            //   type: "Space",
            // },
            {
                pattern: /b23\.tv(?:\\)?\/([0-9a-zA-Z]+)/gim,
                type: "Short",
            },
            {
                pattern: /bili2233\.cn(?:\\)?\/([0-9a-zA-Z]+)/gim,
                type: "Short",
            },
        ];
        var ret = [];
        for (const rule of linkRegex) {
            var match;
            let lastID;
            while ((match = rule.pattern.exec(content)) !== null) {
                if (lastID == match[1])
                    continue;
                ret.push({
                    type: rule.type,
                    id: match[1],
                });
                lastID = match[1];
            }
        }
        return ret;
    }

    /**
     * 类型执行器
     * @param ctx Context
     * @param config Config
     * @param element 链接列表
     * @returns 解析来的文本
     */
    async function type_processer(ctx, config, element) {
        var ret = "";
        switch (element["type"]) {
            case "Video":
                const bili_video = new Bili_Video(ctx, config);
                const video_info = await bili_video.gen_context(element["id"]);
                if (video_info != null)
                    ret += video_info;
                break;

            case "Short":
                const bili_short = new Bili_Short(ctx, config);
                const typed_link = link_type_parser(await bili_short.get_redir_url(element["id"]));
                for (const element of typed_link) {
                    const final_info = await type_processer(ctx, config, element);
                    if (final_info != null)
                        ret += final_info;
                    break;
                }
                break;
        }
        return ret;
    }

    class Bili_Short {
        ctx;
        config;
        constructor(ctx, config) {
            this.ctx = ctx;
            this.config = config;
        }
        /**
         * 根据短链接重定向获取正常链接
         * @param id 短链接 ID
         * @returns 正常链接
         */
        async get_redir_url(id) {
            var data = await this.ctx.http.get("https://b23.tv/" + id, {
                redirect: "manual",
                headers: {
                    "User-Agent": this.config.userAgent,
                },
            });
            const match = data.match(/<a\s+(?:[^>]*?\s+)?href="([^"]*)"/i);
            if (match)
                return match[1];
            else
                return null;
        }
    }
    /////////////////////////////////////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////////////////////////////////////
    /**
     * 检查看看一个url是否返回403，或者无法访问，主要用在通过bilibili官方api拿到的视频流
     * @param url  链接
     * @returns boolean
     */
    async function checkResponseStatus(url) {
        try {
            const response = await ctx.http(url, {
                method: 'GET',
                headers: {
                    'Referer': 'no-referrer',
                    'Range': 'bytes=0-10000'
                }
            });
            //尝试打印一下看看response
            //await logger.info(response);

            if (response.status === 403 || response.status === 410) {
                return false;
            }
            else if (response.status === 200 || response.status === 206) {
                return true;
            }
            else {
                return false;
            }
        }
        catch (error) {
            return false;
        }
    }

    async function handleBilibiliMedia(bilibiliVideo, originUrl) {
        const GetVideoStream = async (h5videoStream, pcvideoStream, cid) => {
            if (!h5videoStream.data ||
                !pcvideoStream.data ||
                !h5videoStream.data.accept_quality ||
                !pcvideoStream.data.accept_quality ||
                !h5videoStream.data.accept_format ||
                !pcvideoStream.data.accept_format)
                throw new Error('无法获取清晰度信息, 可能该视频为大会员专享或者该视频为付费视频/充电专属视频！或者账号被风控。');
            const h5Quality = h5videoStream.data.accept_quality;
            const pcQuality = pcvideoStream.data.accept_quality;
            if (config.loggerinfo) {
                logger.info(`h5Quality清晰度：  ` + h5Quality)
                logger.info(`pcQuality清晰度：  ` + pcQuality)
            }
            const CombinedQualityInfo = h5Quality
                .filter((item, index) => !(h5videoStream.data?.accept_format?.includes('flv') && h5videoStream.data.accept_format.split(',')[index].includes('flv')))
                .map(item => ['html5', item])
                .concat(pcQuality
                    .filter((item, index) => !(pcvideoStream.data?.accept_format?.includes('flv') && pcvideoStream.data.accept_format.split(',')[index].includes('flv')))
                    .map(item => ['pc', item]));
            CombinedQualityInfo.sort((a, b) => {
                if (b[1] === a[1]) {
                    // 如果两者数字相等
                    if (a[0] === 'html5') {
                        // html5排在前面
                        return -1;
                    }
                    else if (b[0] === 'html5') {
                        // pc排在前面
                        return 1;
                    }
                    else {
                        // 如果都是相同类型，则按照原顺序
                        return 0;
                    }
                }
                else {
                    // 根据配置决定排序顺序
                    switch (config.Video_ClarityPriority) {
                        case '1':
                            //logger.info(`低清晰度优先排序，a[1]: ${a[1]}, b[1]: ${b[1]}`);
                            return a[1] - b[1]; // 从低到高排序（低清晰度优先）
                        case '2':
                            //logger.info(`高清晰度优先排序，a[1]: ${a[1]}, b[1]: ${b[1]}`);
                            return b[1] - a[1]; // 从高到低排序（高清晰度优先）
                        default:
                            //logger.warn(`未知的视频清晰度优先级配置: ${config.Video_ClarityPriority}`);
                            return 0; // 默认保持原顺序
                    }
                }
            });
            outerLoop: for (const [index, item] of CombinedQualityInfo.entries()) {

                videoStream = await bilibiliVideo.getBilibiliVideoStream(avid, bvid, cid, item[1], item[0], 1);

                if (!videoStream || !videoStream.data || !videoStream.data.durl) {
                    continue;
                }
                if (await checkResponseStatus(videoStream.data.durl[0].url) === true) {
                    break outerLoop;
                }
                const isLastItem = index === CombinedQualityInfo.length - 1;
                if (isLastItem) {
                    throw new Error('在尝试了全部清晰度和平台后，无法获取流媒体');
                }
            }
            return videoStream;
        };
        const duration = [];
        const cids = [];
        const cover = [];
        const name = [];
        const type = [];
        const singer = [];
        const link = [];
        const origin = [];
        const bitRate = [];
        const url = [];
        let bvid;
        if (originUrl.includes('http') && originUrl.includes('video')) {
            originUrl = originUrl.replace(/\?/g, '/');
            bvid = originUrl.split('/video/')[1].split('/')[0];
        }
        else if (originUrl.includes('BV') || originUrl.includes('bv')) {
            bvid = originUrl;
        }
        else {
            const mediaData = returnErrorMediaData(['暂不支持']);
            return mediaData;
        }
        const videoInfo = await bilibiliVideo.getBilibiliVideoDetail(null, bvid);
        if (!videoInfo || !videoInfo.data) {
            const mediaData = returnErrorMediaData(['这个不是正确的bv号']);
            return mediaData;
        }
        videoInfo.data.pages.forEach((page) => {
            if (!videoInfo.data)
                return;
            cids.push(page.cid);
            cover.push(videoInfo.data.pic);
            type.push('video');
            singer.push(videoInfo.data.owner.name);
            link.push(`https://www.bilibili.com/video/${bvid}`);
            duration.push(page.duration + 1 || videoInfo.data.duration + 1);
            origin.push('bilibili');
            if (videoInfo.data.pages.length <= 1) {
                name.push(videoInfo.data.title);
            }
            else {
                name.push(`${videoInfo.data.title} - P${page.part}`);
            }
        });
        const avid = videoInfo.data.aid;
        let videoStream;

        const h5videoStream = await bilibiliVideo.getBilibiliVideoStream(avid, bvid, cids[0], 112, 'html5', 1);
        const pcvideoStream = await bilibiliVideo.getBilibiliVideoStream(avid, bvid, cids[0], 112, 'pc', 1);
        if (!h5videoStream || !pcvideoStream)
            return returnErrorMediaData(['无法获取B站视频流']);

        const cid = cids[0];
        videoStream = await GetVideoStream(h5videoStream, pcvideoStream, cid);
        if (!videoStream || !videoStream.data || !videoStream.data.quality || !videoStream.data.durl)
            return returnErrorMediaData(['无法获取videoStream信息']);
        bitRate.push(videoStream.data.quality);
        url.push(videoStream.data.durl[0].url);
        /*
        for (const cid of cids) {
            videoStream = await GetVideoStream(h5videoStream, pcvideoStream, cid);
            if (!videoStream || !videoStream.data || !videoStream.data.quality || !videoStream.data.durl)
                return returnErrorMediaData(['无法获取videoStream信息']);
            bitRate.push(videoStream.data.quality);
            url.push(videoStream.data.durl[0].url);
        }
        */
        const mediaData = returnCompleteMediaData(type, name, singer, cover, url, duration, bitRate, [], origin, link);
        return mediaData;
    }

    /**
     * 返回包含错误信息的mediaData
     * @param errorMsg 错误信息
     * @return mediaData
     */
    function returnErrorMediaData(errorMsgs) {
        const errorMediaDataArray = [];
        for (const errorMsg of errorMsgs) {
            const mediaData = {
                type: 'music',
                name: '0',
                signer: '0',
                cover: '0',
                link: '0',
                url: '0',
                duration: 0,
                bitRate: 0,
                lyrics: null,
                origin: null,
                error: errorMsg,
            };
            errorMediaDataArray.push(mediaData);
        }
        return errorMediaDataArray;
    }

    /**
     * 返回完整的mediaData
     * @param type 类型
     * @param name 标题
     * @param signer 创作者
     * @param cover 封面图url
     * @param url 链接
     * @param duration 时长
     * @param bitRate 比特率
     * @return mediaData
     */
    function returnCompleteMediaData(typeList, nameList, signerList, coverList, urlList, durationList, bitRateList, lyricsList = [], origin = [], linkList = [], commentList) {
        const mediaDataArray = [];
        for (let i = 0; i < urlList.length; i++) {
            const mediaData = {
                type: typeList[i],
                name: nameList[i],
                signer: signerList[i],
                cover: coverList[i],
                link: linkList[i] || urlList[i],
                url: urlList[i],
                duration: durationList[i],
                bitRate: bitRateList[i],
                lyrics: lyricsList[i] || null,
                origin: origin[i] || null,
                comment: commentList?.[i] || undefined,
                error: null,
            };

            mediaDataArray.push(mediaData);
        }
        return mediaDataArray;
    }

}
exports.apply = apply;