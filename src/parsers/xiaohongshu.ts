// src/parsers/xiaohongshu.ts

import {Context, h, Session} from 'koishi';
import {FileInfo, Link, ParsedInfo, PluginConfig, XhsInitialState} from '../types';
// @ts-ignore
import {Cookie, Page} from 'puppeteer';
import {load} from 'cheerio';
import {escapeHtml, getCookie, numeral} from '../utils';

export const name = "xiaohongshu";

const linkRules = [
    {
        pattern: /(?:https?:\/\/)?www\.xiaohongshu\.com\/discovery\/item\/([\w?=&\-.%]+)/gi,
        type: "discovery" as const,
    },
    {
        pattern: /(?:https?:\/\/)?www\.xiaohongshu\.com\/explore\/([\w?=&\-.%]+)/gi,
        type: "explore" as const,
    },
    {
        pattern: /(?:https?:\/\/)?xhslink\.com\/(?:\w\/)?([0-9a-zA-Z]+)/gi,
        type: "short" as const,
    },
];

/**
 * 在文本中匹配小红书链接 (长链接或短链接)
 */
export async function match(content: string, ctx: Context, config: PluginConfig): Promise<Link[]> {
    const results: Link[] = [];
    const seen = new Set<string>();
    const initialLinks: Link[] = [];

    for (const { pattern, type } of linkRules) {
        let m;
        pattern.lastIndex = 0;
        while ((m = pattern.exec(content)) !== null) {
            const idPart = m[1];
            if (!idPart) continue;
            const cleanId = idPart.split('?')[0];
            const host = type === "short" ? "xhslink.com" : "www.xiaohongshu.com";
            const pathPrefix = type === "short" ? (idPart.startsWith('m/') ? 'm/' : '') : (type === "discovery" ? "discovery/item/" : "explore/");
            initialLinks.push({ platform: name, type, id: cleanId, url: `https://${host}/${pathPrefix}${idPart}` });
        }
    }

    for (const link of initialLinks) {
        let finalLink = link;
        if (link.type === 'short') {
            try {
                let finalUrl = '';
                try {
                    await ctx.http(link.url, { method: 'GET', headers: { 'User-Agent': config.userAgent }, redirect: 'manual' });
                } catch (e: any) {
                    finalUrl = e.response?.headers?.location || '';
                }

                if (finalUrl) {
                    const idMatch = finalUrl.match(/\/explore\/([\w?=&\-.%]+)/) || finalUrl.match(/\/discovery\/item\/([\w?=&\-.%]+)/);
                    if (idMatch) {
                        const cleanId = idMatch[1].split('?')[0];
                        // 依然保留 finalUrl，因为 process 还需要提 xsec_token
                        finalLink = { platform: name, type: 'explore', id: cleanId, url: finalUrl };
                    }
                }
            } catch (e) { }
        }

        const key = `${finalLink.type}:${finalLink.id}`;
        if (!seen.has(key)) {
            seen.add(key);
            results.push(finalLink);
        }
    }
    return results;
}

/**
 * 使用 Puppeteer 刷新小红书 Cookie 并存入数据库
 * @param ctx - Koishi Context
 * @param config
 */
export async function lc_get_cookie(ctx: Context, config: PluginConfig): Promise<string> {
    const logger = ctx.logger('share-links-analysis:xiaohongshu');

    if (!ctx.puppeteer) {
        logger.warn('Puppeteer 服务未启用，无法自动刷新 Cookie。');
        return "";
    }

    logger.info('正在执行两步导航策略以刷新小红书 Cookie...');
    let page: Page | null = null;
    try {
        page = await ctx.puppeteer.page();
        await page.setUserAgent(config.userAgent);

        // --- 步骤 1: 访问首页，获取基础会话 Cookie (如 web_session) ---
        logger.info('步骤 1/2: 访问首页以获取初始会话 Cookie...');
        try {
            await page.goto('https://www.xiaohongshu.com/', {
                waitUntil: 'load',
                timeout: 10000
            });
        } catch (error) {
        }
        const initialCookies = await page.cookies();
        logger.info(`步骤 1 完成, 获取到 ${initialCookies.length} 个初始 Cookie。`);

        // --- 步骤 2: 访问 /explore 页面，触发反爬虫验证，获取安全 Cookie ---
        logger.info('步骤 2/2: 访问 /explore 页面以触发并获取安全 Cookie...');
        try {
            await page.goto('https://www.xiaohongshu.com/explore', {
                waitUntil: 'load',
                timeout: 10000
            });
        } catch (error) {
        }

        // --- 步骤 3: 收集并验证最终合并的 Cookie ---
        const finalCookies = await page.cookies();
        if (finalCookies.length === 0) {
            logger.warn('执行两步导航后，仍未能获取到任何 Cookie。');
            return "";
        }

        const hasWebSession = finalCookies.some((c: Cookie) => c.name === 'web_session');
        const hasABRequestId = finalCookies.some((c: Cookie) => c.name === 'abRequestId');

        logger.info(`步骤 2 完成, 共获取到 ${finalCookies.length} 个最终 Cookie。`);
        logger.info(`- 是否包含 'web_session': ${hasWebSession ? '是' : '否'}`);
        logger.info(`- 是否包含 'abRequestId': ${hasABRequestId ? '是' : '否'}`);

        if (!hasWebSession || !hasABRequestId) {
            logger.warn('关键 Cookie 缺失，本次刷新可能不完整。将放弃刷新。');
            return "";
        }

        // 在这里过滤掉 acw_tc
        const filteredCookies = finalCookies.filter((c: Cookie) => c.name !== 'acw_tc');

        // 使用过滤后的 cookie 数组来生成字符串
        const cookieString = filteredCookies.map((c: Cookie) => `${c.name}=${c.value}`).join('; ');

        logger.info('成功执行两步刷新策略并缓存了小红书 Cookie！');
        return cookieString;
    } catch (error) {
        logger.error('在执行两步导航刷新 Cookie 时发生错误: ', error);
        return "";
    } finally {
        if (page) {
            await page.close();
        }
    }
}

/**
 * 处理单个小红书链接
 * @param ctx Koishi Context
 * @param config 插件配置
 * @param link 匹配到的链接对象
 * @param session
 * @returns 处理后的标准格式对象
 */
export async function process(ctx: Context, config: PluginConfig, link: Link, session: Session): Promise<ParsedInfo | null> {
    const logger = ctx.logger(`share-links-analysis:${name}`);

    // 步骤一：从原始分享链接中提取 xsec_token
    let token: string | null = null;
    try {
        // 解码URL中的HTML实体, 主要是 &amp; -> &
        const decodedUrl = link.url.replace(/&amp;/g, '&');
        const originalUrl = new URL(decodedUrl);
        token = originalUrl.searchParams.get('xsec_token');
        if (token) {
            logger.debug(`成功从分享链接中提取 xsec_token。`);
        } else {
            logger.debug(`分享链接中未找到 xsec_token: ${link.url}`);
        }
    } catch (e) {
        logger.debug(`解析分享链接URL失败: ${link.url}`);
    }

    let finalUrl = link.url;

    // 步骤二：构建最终要抓取的URL
    let urlToFetch: string;
    try {
        const baseUrl = finalUrl.split('?')[0];
        if (token) {
            const targetUrl = new URL(baseUrl);
            targetUrl.searchParams.set('xsec_token', token);
            urlToFetch = targetUrl.toString();
        } else {
            urlToFetch = finalUrl;
        }
    } catch (e) {
        logger.error(`构建最终请求URL失败: ${finalUrl}`);
        return null;
    }

    logger.debug(`正在抓取小红书页面: ${urlToFetch}`);
    try {
        const cookie = await getCookie(ctx, config, name);
        const requestHeaders: Record<string, string> = {
            'User-Agent': config.userAgent,
            'Cookie': cookie,
            'Referer': 'https://www.xiaohongshu.com/',
        };

        const fullResponse = await ctx.http(urlToFetch, {method: 'GET', headers: requestHeaders});

        const responseHtml = fullResponse.data;

        const $ = load(responseHtml);
        const scriptContent = $('script:contains("window.__INITIAL_STATE__")').html();

        if (!scriptContent) {
            logger.error('在页面中未找到 __INITIAL_STATE__ 数据块，可能是token无效或小红书策略变更。');
            return null;
        }

        const jsonStr = scriptContent.replace(/window\.__INITIAL_STATE__\s*=\s*/, '').replace(/undefined/g, 'null');
        const pageData = JSON.parse(jsonStr) as XhsInitialState;
        const noteKey = Object.keys(pageData.note.noteDetailMap)[0];
        if (!noteKey) {
            logger.error('无法在页面数据中找到笔记详情。');
            return null;
        }
        const noteData = pageData.note.noteDetailMap[noteKey].note;

        // --- 构建结构化数据 ---
        let videoUrl: string | null = null;
        let coverUrl: string | undefined = undefined;
        const images: string[] = [];

        if (noteData.type === 'video' && noteData.video) {
            logger.debug(`[XHS Video Debug] 发现视频笔记，视频数据对象: \n${JSON.stringify(noteData.video, null, 2)}`);
            if (noteData.video.media?.stream?.h264?.[0]?.masterUrl) {
                videoUrl = noteData.video.media.stream.h264[0].masterUrl;
                logger.debug(`[XHS Video Debug] 已提取视频链接: ${videoUrl}`);
            } else {
                logger.warn('[XHS Video Debug] 未能从预期路径 `note.video.media.stream.h264[0].masterUrl` 找到视频链接。');
            }

            if (noteData.imageList && noteData.imageList.length > 0) {
                coverUrl = noteData.imageList[0].infoList.find(i => i.imageScene === 'WB_DETAIL_SHARE')?.url || noteData.imageList[0].infoList[1]?.url;
            }
        } else if (noteData.type === 'normal' && Array.isArray(noteData.imageList)) {
            noteData.imageList.forEach((img) => {
                const imageUrl = img.infoList.find((i) => i.imageScene === 'WB_DETAIL_SHARE')?.url || img.infoList[1]?.url || img.url_default;
                if (imageUrl) {
                    images.push(imageUrl);
                }
            });
        }

        const liked = numeral(parseInt(noteData.interactInfo.likedCount), config);
        const collected = numeral(parseInt(noteData.interactInfo.collectedCount), config);
        const comment = numeral(parseInt(noteData.interactInfo.commentCount), config);
        const shared = numeral(parseInt(noteData.interactInfo.shareCount), config);

        const statsString = `点赞: ${liked} | 收藏: ${collected} | 评论: ${comment} | 分享: ${shared}`;

        const tags = noteData.tagList?.map(t => `#${t.name}`).join(' ') || '';

        // 提取发布时间 (Time)
        let timeString = '';
        if (noteData.time) {
            const date = new Date(noteData.time);
            // 简单格式化为 YYYY-MM-DD HH:mm:ss
            timeString = `\n发布时间: ${date.toLocaleString('zh-CN', {hour12: false})}`;
        }

        // 组装 Mainbody
        const image = images ? images.map(img => h.image(img).toString()).join('\n') : ''
        // 将 描述 + 标签 + 时间 + 图片 组合
        const mainbody = `${escapeHtml(noteData.desc.trim())}\n\n${tags}${timeString}\n` + image;

        let files: FileInfo[] = [];
        if (videoUrl) {
            files = [{type: "video", url: videoUrl}];
        }

        return {
            platform: name,
            title: noteData.title,
            authorName: noteData.user.nickname,
            mainbody: mainbody,
            coverUrl: coverUrl,
            files: files,
            sourceUrl: urlToFetch,
            stats: statsString,
        };

    } catch (error: any) {
        logger.error(`抓取或解析小红书页面时失败: ${error.message}`);
        return null;
    }
}
