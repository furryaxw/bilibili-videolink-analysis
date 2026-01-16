// src/parsers/bilibili.ts

import {Context, h, Session} from 'koishi';
import {BilibiliVideoInfo, FileInfo, Link, ParsedInfo, PluginConfig} from '../types';
import {escapeHtml, numeral} from '../utils';

export const name = "bilibili";

// --- AV/BV 转换常量与算法 ---
const TABLE = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';
const MAX_AVID = 1n << 51n;
const BASE = 58n;
const BVID_LEN = 12n;
const XOR = 23442827791579n;

function avToBv(avid: string | number): string {
    let cleanAvid: string;
    if (typeof avid === 'string') {
        cleanAvid = avid.replace(/^av/i, '');
    } else {
        cleanAvid = avid.toString();
    }

    const avidBigInt = BigInt(cleanAvid);
    if (avidBigInt <= 0n || avidBigInt >= MAX_AVID) {
        return avid.toString();
    }

    const result = ['B', 'V', '1', '', '', '', '', '', '', '', '', ''];
    let idx = BVID_LEN - 1n;
    let temp = (MAX_AVID | avidBigInt) ^ XOR;

    while (temp !== 0n) {
        result[Number(idx)] = TABLE[Number(temp % BASE)];
        temp /= BASE;
        idx -= 1n;
    }

    [result[3], result[9]] = [result[9], result[3]];
    [result[4], result[7]] = [result[7], result[4]];

    return result.join('');
}

// --- 链接匹配规则 ---
const linkRules = [
    // Video: 匹配 BV/av 号
    {
        pattern: /(?:https?:\/\/)?(?:www|m)?\.bilibili\.com\/video\/([ab]v[0-9a-zA-Z]+)/gi,
        type: "video" as const,
    },
    // Live: 直播
    {
        pattern: /(?:https?:\/\/)?live\.bilibili\.com(?:\/h5)?\/(\d+)/gi,
        type: "live" as const,
    },
    // 动态和专栏解析有非常严重的问题，无法使用
    // // Article: 专栏 (cv号)
    // {
    //     pattern: /(?:https?:\/\/)?(?:www|m)\.bilibili\.com\/read\/cv(\d+)/gi,
    //     type: "article" as const,
    // },
    // // Opus / Dynamic / t.bilibili: 动态与新版专栏
    // // 覆盖: m.bilibili.com/dynamic/, www.bilibili.com/opus/, t.bilibili.com/
    // {
    //     pattern: /(?:https?:\/\/)?(?:(?:www|m)\.bilibili\.com\/(?:opus|dynamic)\/|t\.bilibili\.com\/)(\d+)/gi,
    //     type: "opus" as const,
    // },
    // Space: 个人空间 (支持 space.bilibili.com 和 bilibili.com/space)
    {
        pattern: /(?:https?:\/\/)?space\.bilibili\.com\/(\d+)/gi,
        type: "space" as const,
    },
    {
        pattern: /(?:https?:\/\/)?(?:www|m)\.bilibili\.com\/space\/(\d+)/gi,
        type: "space" as const,
    },
    // Audio: 音乐 (au)
    {
        pattern: /(?:https?:\/\/)?(?:www|m)\.bilibili\.com\/audio\/au(\d+)/gi,
        type: "audio" as const,
    },
    // AudioMenu: 歌单 (am)
    {
        pattern: /(?:https?:\/\/)?(?:www|m)\.bilibili\.com\/audio\/am(\d+)/gi,
        type: "audio_menu" as const,
    },
    // Bangumi EP: 番剧单集
    {
        pattern: /(?:https?:\/\/)?(?:www|m)\.bilibili\.com\/bangumi\/play\/ep(\d+)/gi,
        type: "bangumi_ep" as const,
    },
    // Bangumi SS: 番剧 Season
    {
        pattern: /(?:https?:\/\/)?(?:www|m)\.bilibili\.com\/bangumi\/play\/ss(\d+)/gi,
        type: "bangumi_ss" as const,
    },
    // Bangumi MD: 媒体 ID
    {
        pattern: /(?:https?:\/\/)?(?:www|m)\.bilibili\.com\/bangumi\/media\/md(\d+)/gi,
        type: "bangumi_md" as const,
    },
    // Short: 短链接 (b23.tv)
    {
        pattern: /(?:https?:\/\/)?b23\.tv\/([0-9a-zA-Z]+)/gi,
        type: "short" as const,
    },
];

// 匹配独立的 BV 号 regex
const bvPattern = /(?<![a-zA-Z0-9/])(BV[1-9A-HJ-NP-Za-km-z]{10})(?![a-zA-Z0-9])/gi;

/**
 * 在文本中匹配B站链接
 * @param content 消息内容
 * @returns 匹配到的链接对象数组
 */
export function match(content: string): Link[] {
    const results: Link[] = [];
    const seen = new Set<string>();

    for (const {pattern, type} of linkRules) {
        let match;
        // 重置 regex lastIndex
        pattern.lastIndex = 0;
        while ((match = pattern.exec(content)) !== null) {
            let id = match[1];
            if (!id) continue;

            // 如果是视频类型且是av号，转换为BV号
            if (type === 'video' && id.toLowerCase().startsWith('av')) {
                try {
                    id = avToBv(id);
                } catch (e) {
                    // 转换失败则保持原样
                }
            }

            // 构造标准 URL
            let url = match[0];
            if (type === 'video') {
                // 视频类型统一使用 BV 号 URL，以便去重
                url = `https://www.bilibili.com/video/${id}`;
            } else {
                if (!url.startsWith('http')) {
                    url = `https://${url}`;
                }
            }

            if (seen.has(url)) continue;
            seen.add(url);

            results.push({
                platform: name,
                type,
                id,
                url,
            });
        }
    }

    // 匹配独立的 BV 号（不包含在链接中）
    let bvMatch;
    while ((bvMatch = bvPattern.exec(content)) !== null) {
        const videoId = bvMatch[1];
        const url = `https://www.bilibili.com/video/${videoId}`;

        if (seen.has(url)) continue;
        seen.add(url);

        results.push({
            platform: name,
            type: 'video',
            id: videoId,
            url,
        });
    }

    return results;
}

/**
 * 处理单个B站链接
 * @param ctx Koishi Context
 * @param config 插件配置
 * @param link 匹配到的链接对象
 * @param session
 * @returns 处理后的标准格式对象
 */
export async function process(ctx: Context, config: PluginConfig, link: Link, session: Session): Promise<ParsedInfo | null> {
    const logger = ctx.logger(`share-links-analysis:${name}`);
    let currentLink = link;

    // --- 1. 短链接解析 ---
    if (currentLink.type === 'short') {
        let finalUrl = '';
        // 尝试 HTTP HEAD/GET 获取跳转
        try {
            const response = await ctx.http(currentLink.url, {
                method: 'GET', // 部分短链接需要 GET 才能拿到 location
                headers: {'User-Agent': config.userAgent},
                redirect: 'manual',
            });
            const locationHeader = response.headers.get('location');
            if (locationHeader) finalUrl = locationHeader;
        } catch (e: any) {
            const locationHeader = e.response?.headers?.location;
            if (locationHeader) finalUrl = locationHeader;
            if (!finalUrl) logger.debug(`HTTP解析短链接失败: ${e.message}`);
        }

        // 检查解析结果是否依然是短链接或无效
        if (finalUrl && (finalUrl.includes('b23.tv') || (finalUrl.includes('bilibili.com') && finalUrl.length < 30))) {
            finalUrl = ''; // 视为解析未彻底完成
        }

        // Puppeteer 后备方案
        if (!finalUrl && ctx.puppeteer) {
            logger.info(`切换至Puppeteer解析短链接: ${currentLink.url}`);
            let page = null;
            try {
                page = await ctx.puppeteer.page();
                await page.setUserAgent(config.userAgent);
                await page.goto(currentLink.url, {waitUntil: 'domcontentloaded'});
                finalUrl = page.url();
            } catch (e: any) {
                logger.error(`Puppeteer解析失败: ${e.message}`);
            } finally {
                if (page) await page.close();
            }
        }

        if (finalUrl) {
            logger.debug(`短链接指向: ${finalUrl}`);
            const matchedLinks = match(finalUrl);
            if (matchedLinks.length > 0) {
                // 更新当前链接信息为解析后的真实链接
                currentLink = matchedLinks[0];
            } else {
                logger.warn(`在跳转链接中未识别到支持的B站内容: ${finalUrl}`);
                return null;
            }
        } else {
            logger.error('短链接解析失败');
            return null;
        }
    }

    // --- 2. 根据类型分发处理逻辑 ---

    // === Video (视频) ===
    if (currentLink.type === 'video') {
        return await processVideo(ctx, config, currentLink, logger);
    }
    // === Live (直播) ===
    else if (currentLink.type === 'live') {
        return await processLive(ctx, config, currentLink, logger);
    }
    // === Article (专栏) ===
    else if (currentLink.type === 'article') {
        return await processArticle(ctx, config, currentLink, logger);
    }
    // === Opus (动态) ===
    else if (currentLink.type === 'opus') {
        return await processOpus(ctx, config, currentLink, logger);
    }
    // === Space (空间) ===
    else if (currentLink.type === 'space') {
        return await processSpace(ctx, config, currentLink, logger);
    }
    // === Audio (音乐) ===
    else if (currentLink.type === 'audio') {
        return await processAudio(ctx, config, currentLink, logger);
    }
    // === AudioMenu (音乐目录) ===
    else if (currentLink.type === 'audio_menu') {
        return await processAudioMenu(ctx, config, currentLink, logger);
    }
    // === Bangumi (番剧) ===
    else if (currentLink.type.startsWith('bangumi_')) {
        return await processBangumi(ctx, config, currentLink, logger);
    }

    return null;
}

// --------------------------------------------------------------------------
// 子处理函数
// --------------------------------------------------------------------------

async function processVideo(ctx: Context, config: PluginConfig, link: Link, logger: any): Promise<ParsedInfo | null> {
    const videoId = link.id;
    const idType = videoId.startsWith('BV') ? 'bvid' : 'aid';
    const infoUrl = `https://api.bilibili.com/x/web-interface/view?${idType}=${videoId}`;

    try {
        const info = await ctx.http.get<BilibiliVideoInfo>(infoUrl, {
            headers: {'User-Agent': config.userAgent}
        });

        if (!info || !info.data) {
            logger.warn(`B站API未返回有效视频数据，ID: ${videoId}`);
            return null;
        }
        const data = info.data;

        // 获取视频流直链
        let videoUrl: string | null = null;
        try {
            // 优先使用插件提供的 BiliBiliVideo 服务 (需确保依赖存在)
            if (ctx.BiliBiliVideo) {
                const qn = config.Video_ClarityPriority === '1' ? 32 : 80;
                const videoStream = await ctx.BiliBiliVideo.getBilibiliVideoStream(data.aid, data.bvid, data.pages[0].cid, qn, 'html5', 1);
                if (videoStream?.data?.durl?.[0]?.url) {
                    videoUrl = videoStream.data.durl[0].url;
                }
            }
        } catch (e: any) {
            logger.error(`获取视频流失败: ${e.message}`);
        }

        const statsString = `播放: ${numeral(data.stat.view, config)} | 弹幕: ${numeral(data.stat.danmaku, config)}\n` +
                            `点赞: ${numeral(data.stat.like, config)} | 硬币: ${numeral(data.stat.coin, config)} | 收藏: ${numeral(data.stat.favorite, config)}`;

        const files: FileInfo[] = videoUrl ? [{type: "video", url: videoUrl}] : [];

        return {
            platform: name,
            title: data.title,
            authorName: data.owner.name,
            mainbody: escapeHtml(data.desc),
            coverUrl: data.pic,
            files: files,
            sourceUrl: `https://www.bilibili.com/video/${data.bvid}`,
            stats: statsString,
        };
    } catch (e: any) {
        logger.error(`视频解析异常: ${e.message}`);
        return null;
    }
}

async function processLive(ctx: Context, config: PluginConfig, link: Link, logger: any): Promise<ParsedInfo | null> {
    const roomId = link.id;
    const apiUrl = `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`;

    try {
        const res = await ctx.http.get(apiUrl, {
            headers: {'User-Agent': config.userAgent, 'Host': 'api.live.bilibili.com'}
        });

        if (res.code !== 0 || !res.data) throw new Error(res.msg || 'API Error');
        const data = res.data;

        const statusMap: Record<number, string> = { 0: '未开播', 1: '直播中', 2: '轮播中' };
        const statusText = statusMap[data.live_status] || '未知状态';

        const statsString = `状态: ${statusText} | 观看: ${numeral(data.online, config)} | 关注: ${numeral(data.attention, config)}`;

        // 构造 mainbody
        const mainbody = `${escapeHtml(data.description || '')}\n\n[${statusText}] ${data.area_name || ''}`;

        return {
            platform: name,
            title: data.title,
            authorName: `Live Room ${roomId}`, // API 中可能不直接包含用户名，需额外调用或忽略
            mainbody: mainbody,
            coverUrl: data.user_cover, // 或者 data.keyframe
            files: [],
            sourceUrl: `https://live.bilibili.com/${roomId}`,
            stats: statsString,
        };
    } catch (e: any) {
        logger.error(`直播解析异常: ${e.message}`);
        return null;
    }
}

async function processArticle(ctx: Context, config: PluginConfig, link: Link, logger: any): Promise<ParsedInfo | null> {
    const cvId = link.id;
    const apiUrl = `https://api.bilibili.com/x/article/viewinfo?id=${cvId}`;

    try {
        const res = await ctx.http.get(apiUrl, {
            headers: {'User-Agent': config.userAgent, 'Host': 'api.bilibili.com'}
        });

        if (res.code !== 0 || !res.data) throw new Error(res.message || 'API Error');
        const data = res.data;

        const statsString = `阅读: ${numeral(data.stats.view, config)} | 点赞: ${numeral(data.stats.like, config)} | 硬币: ${numeral(data.stats.coin, config)}`;

        // 提取图片（如果 banner_url 存在）
        let mainbody = escapeHtml(data.summary || '');
        if (data.image_urls && data.image_urls.length > 0) {
            // 添加第一张图作为正文配图
             mainbody += `\n` + h.image(data.image_urls[0]).toString();
        }

        return {
            platform: name,
            title: data.title,
            authorName: data.author_name,
            mainbody: mainbody,
            coverUrl: data.banner_url || data.image_urls?.[0],
            files: [],
            sourceUrl: `https://www.bilibili.com/read/cv${cvId}`,
            stats: statsString,
        };
    } catch (e: any) {
        logger.error(`专栏解析异常: ${e.message}`);
        return null;
    }
}

async function processOpus(ctx: Context, config: PluginConfig, link: Link, logger: any): Promise<ParsedInfo | null> {
    const opusId = link.id;
    const apiUrl = `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${opusId}`;

    console.log(apiUrl);

    try {
        const res = await ctx.http.get(apiUrl, {
            headers: {'User-Agent': config.userAgent, 'Host': 'api.bilibili.com'}
        });

        if (res.code !== 0 || !res.data?.item) throw new Error(res.message || 'API Error');
        const item = res.data.item;
        const modules = item.modules;

        const author = modules.module_author;
        const dynamic = modules.module_dynamic;
        const stat = modules.module_stat;

        // 检测是否为专栏文章类型的 Opus
        const isArticle = !!dynamic?.major?.article;

        let title = `${author?.name} 的动态`;
        let text = dynamic?.desc?.text || '';
        let coverUrl = author?.face;

        // 如果是专栏，优先使用专栏的标题和封面
        if (isArticle) {
            title = dynamic.major.article.title || title;
            text = dynamic.major.article.desc || text; // 专栏摘要
            if (dynamic.major.article.covers && dynamic.major.article.covers.length > 0) {
                coverUrl = dynamic.major.article.covers[0];
            }
        }

        // 尝试提取图片
        const images: string[] = [];
        if (dynamic?.major?.draw?.items) {
            dynamic.major.draw.items.forEach((i: any) => {
                if (i.src) images.push(i.src);
            });
        } else if (dynamic?.major?.opus?.pics) {
            dynamic.major.opus.pics.forEach((p: any) => {
                if (p.url) images.push(p.url);
            });
        }

        const mainbody = escapeHtml(text) + (images.length ? '\n' + images.map(url => h.image(url).toString()).join('') : '');

        const statsString = `转发: ${numeral(stat?.forward?.count || 0, config)} | 评论: ${numeral(stat?.comment?.count || 0, config)} | 点赞: ${numeral(stat?.like?.count || 0, config)}`;

        return {
            platform: name,
            title: title,
            authorName: author?.name,
            mainbody: mainbody,
            coverUrl: coverUrl,
            files: [],
            sourceUrl: `https://www.bilibili.com/opus/${opusId}`,
            stats: statsString,
        };
    } catch (e: any) {
        logger.error(`动态解析异常: ${e.message}`);
        return null;
    }
}

async function processSpace(ctx: Context, config: PluginConfig, link: Link, logger: any): Promise<ParsedInfo | null> {
    const mid = link.id;
    // 使用动态 Feed API 来获取空间信息
    const apiUrl = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${mid}`;

    try {
        const res = await ctx.http.get(apiUrl, {
            headers: {'User-Agent': config.userAgent, 'Host': 'api.bilibili.com'}
        });
        if (res.code !== 0) throw new Error(res.message);

        // 尝试从第一条动态中获取作者信息
        const firstItem = res.data?.items?.[0];
        if (!firstItem) {
            throw new Error("空间为空或不可见");
        }

        const author = firstItem.modules.module_author;
        const title = `${author.name} 的个人空间`;
        const coverUrl = author.face;

        // 构造简单的空间描述
        const mainbody = `UID: ${author.mid}\n最近发布时间: ${author.pub_time}`;

        return {
            platform: name,
            title: title,
            authorName: author.name,
            mainbody: mainbody,
            coverUrl: coverUrl,
            files: [],
            sourceUrl: `https://space.bilibili.com/${mid}`,
            stats: '',
        };
    } catch (e: any) {
        logger.error(`空间解析异常: ${e.message}`);
        return null;
    }
}

async function processAudio(ctx: Context, config: PluginConfig, link: Link, logger: any): Promise<ParsedInfo | null> {
    const sid = link.id;
    const apiUrl = `https://www.bilibili.com/audio/music-service-c/web/song/info?sid=${sid}`;

    try {
        const res = await ctx.http.get(apiUrl, {
            headers: {'User-Agent': config.userAgent, 'Host': 'www.bilibili.com'}
        });
        if (res.code !== 0 || !res.data) throw new Error(res.msg);
        const data = res.data;

        const statsString = `播放: ${numeral(data.statistic.play, config)} | 收藏: ${numeral(data.statistic.collect, config)} | 评论: ${numeral(data.statistic.comment, config)}`;

        return {
            platform: name,
            title: data.title,
            authorName: data.author,
            mainbody: escapeHtml(data.intro || ''),
            coverUrl: data.cover,
            // 如果需要音频文件，可在此处尝试提取（通常 B 站音频需要 sign 较难直接获取直链，此处暂不返回 files）
            files: [],
            sourceUrl: `https://www.bilibili.com/audio/au${sid}`,
            stats: statsString,
        };
    } catch (e: any) {
        logger.error(`音乐解析异常: ${e.message}`);
        return null;
    }
}

async function processAudioMenu(ctx: Context, config: PluginConfig, link: Link, logger: any): Promise<ParsedInfo | null> {
    const sid = link.id;
    const apiUrl = `https://www.bilibili.com/audio/music-service-c/web/menu/info?sid=${sid}`;

    try {
        const res = await ctx.http.get(apiUrl, {
            headers: {'User-Agent': config.userAgent, 'Host': 'www.bilibili.com'}
        });
        if (res.code !== 0 || !res.data) throw new Error(res.msg);
        const data = res.data;

        const statsString = `播放: ${numeral(data.statistic.play, config)} | 收藏: ${numeral(data.statistic.collect, config)} | 分享: ${numeral(data.statistic.share, config)}`;

        return {
            platform: name,
            title: data.title,
            authorName: data.uname, // 歌单创建者
            mainbody: escapeHtml(data.intro || ''),
            coverUrl: data.cover,
            files: [],
            sourceUrl: `https://www.bilibili.com/audio/am${sid}`,
            stats: statsString,
        };
    } catch (e: any) {
        logger.error(`歌单解析异常: ${e.message}`);
        return null;
    }
}

async function processBangumi(ctx: Context, config: PluginConfig, link: Link, logger: any): Promise<ParsedInfo | null> {
    let seasonId = '', epId = '';

    if (link.type === 'bangumi_md') {
        try {
            const mdRes = await ctx.http.get(`https://api.bilibili.com/pgc/review/user?media_id=${link.id}`, {
                headers: {'User-Agent': config.userAgent}
            });
            if (mdRes.result?.media?.season_id) {
                seasonId = mdRes.result.media.season_id;
            } else {
                throw new Error('MDID lookup failed');
            }
        } catch (e) {
            logger.warn(`MDID转SeasonID失败: ${e}`);
            return null;
        }
    } else if (link.type === 'bangumi_ss') {
        seasonId = link.id;
    } else if (link.type === 'bangumi_ep') {
        epId = link.id;
    }

    const apiUrl = epId ? `https://api.bilibili.com/pgc/view/web/season?ep_id=${epId}` : `https://api.bilibili.com/pgc/view/web/season?season_id=${seasonId}`;

    try {
        const res = await ctx.http.get(apiUrl, {
            headers: {'User-Agent': config.userAgent, 'Host': 'api.bilibili.com'}
        });

        if (res.code !== 0 || !res.result) throw new Error(res.message || 'API Error');
        const data = res.result;

        let title = data.season_title;
        let cover = data.cover;
        let desc = data.evaluate;

        // 如果是特定集数，尝试获取分集信息
        if (epId && data.episodes) {
            const ep = data.episodes.find((e: any) => e.ep_id == epId);
            if (ep) {
                title += ` - 第${ep.title}话 ${ep.long_title}`;
                cover = ep.cover; // 使用分集封面
            }
        }

        const stat = data.stat;
        const statsString = `评分: ${data.rating?.score || 'N/A'} | 播放: ${numeral(stat.views, config)} | 追番: ${numeral(stat.favorites, config)}`;

        return {
            platform: name,
            title: title,
            authorName: '哔哩哔哩番剧',
            mainbody: escapeHtml(desc),
            coverUrl: cover,
            files: [],
            sourceUrl: link.url,
            stats: statsString,
        };
    } catch (e: any) {
        logger.error(`番剧解析异常: ${e.message}`);
        return null;
    }
}
