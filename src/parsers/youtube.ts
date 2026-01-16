// src/parsers/youtube.ts

import {Context, Session} from 'koishi';
import {FileInfo, Link, ParsedInfo, PluginConfig} from '../types';
import {escapeHtml, getCookie, numeral} from '../utils';
import ytdl from '@distube/ytdl-core';
// @ts-ignore
import {Cookie, Page} from 'puppeteer';

export const name = "youtube";

// 匹配规则
const linkRules = [
    {
        pattern: /https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?v=([\w-]{11})/gi,
        type: "video" as const,
    },
    {
        pattern: /https?:\/\/youtu\.be\/([\w-]{11})/gi,
        type: "video" as const,
    },
    {
        pattern: /https?:\/\/(?:www\.|m\.)?youtube\.com\/shorts\/([\w-]{11})/gi,
        type: "shorts" as const,
    },
    {
        pattern: /https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:v|embed)\/([\w-]{11})/gi,
        type: "video" as const,
    }
];

export function match(content: string): Link[] {
    const results: Link[] = [];
    const seen = new Set<string>();

    for (const rule of linkRules) {
        let match;
        while ((match = rule.pattern.exec(content)) !== null) {
            const id = match[1];
            const url = `https://www.youtube.com/watch?v=${id}`;
            if (seen.has(url)) continue;
            seen.add(url);
            results.push({platform: name, type: rule.type, id, url});
        }
    }
    return results;
}

/**
 * 尝试通过 Puppeteer 或 HTTP 请求获取 Cookie
 */
export async function lc_get_cookie(ctx: Context, config: PluginConfig): Promise<string> {
    const logger = ctx.logger('share-links-analysis:youtube');

    let cookieString = '';

    // 尝试 Puppeteer (最稳健)
    if (ctx.puppeteer) {
        logger.info('尝试通过 Puppeteer 获取 Cookie...');
        let page: Page | null = null;
        try {
            page = await ctx.puppeteer.page();
            await page.setUserAgent(config.userAgent);
            await page.goto('https://www.youtube.com', {waitUntil: 'domcontentloaded', timeout: 20000});

            // 尝试点击“同意”按钮 (针对欧盟 IP)
            try {
                const consentButton = await page.$('button[aria-label*="Accept"], button[aria-label*="Agree"]');
                if (consentButton) await consentButton.click();
            } catch {
            }

            const cookies = await page.cookies();
            if (cookies.length > 0) {
                cookieString = cookies.map((c: Cookie) => `${c.name}=${c.value}`).join('; ');
                logger.info(`Puppeteer 成功: 获取到 ${cookies.length} 个 Cookie`);
            }
        } catch (error: any) {
            logger.warn(`Puppeteer 获取失败: ${error.message}`);
        } finally {
            if (page) await page.close();
        }
    }

    // 3. 尝试 HTTP 回退 (利用插件代理)
    if (!cookieString) {
        logger.info('尝试通过 HTTP 请求回退获取 Cookie...');
        try {
            const http = config.proxy ? ctx.http.extend({proxy: config.proxy} as any) : ctx.http;
            const res = await http('https://www.youtube.com', {
                method: 'HEAD',
                headers: {'User-Agent': config.userAgent, 'Accept-Language': 'en-US,en;q=0.9'},
                redirect: 'manual'
            });

            let setCookie: string[] = [];
            if (res.headers && typeof res.headers.getSetCookie === 'function') {
                setCookie = res.headers.getSetCookie();
            } else if ((res as any).headers?.['set-cookie']) {
                setCookie = (res as any).headers['set-cookie'];
            }

            if (setCookie?.length > 0) {
                cookieString = setCookie.map(str => str.split(';')[0]).join('; ');
                logger.info('HTTP 回退成功: 获取到 Cookie');
            }
        } catch (error: any) {
            logger.warn(`HTTP 回退失败: ${error.message}`);
        }
    }

    if (cookieString) {
        return cookieString;
    }
    return "";
}

// 解析 Cookie 字符串为对象数组
function parseCookieString(cookieString: string) {
    if (!cookieString) return [];
    return cookieString.split(';').map(pair => {
        const parts = pair.split('=');
        const name = parts.shift();
        const value = parts.join('=');
        if (name && value) return {name: name.trim(), value: value.trim()};
        return null;
    }).filter((c): c is { name: string, value: string } => c !== null);
}

export async function process(
    ctx: Context,
    config: PluginConfig,
    link: Link,
    session: Session
): Promise<ParsedInfo | null> {
    const logger = ctx.logger(`share-links-analysis:${name}`);
    const videoUrl = link.url;

    try {
        // 1. 获取 Cookie (调用全局接口)
        // 自动处理：CookieCloud -> Database Fallback
        const cookieString = await getCookie(ctx, config, name);

        if (cookieString) {
            logger.debug('已加载 Cookie');
        } else {
            logger.debug('无 Cookie，尝试裸连');
        }

        const cookies = parseCookieString(cookieString);

        // 2. 创建 Agent
        let agentOptions: any = {cookies};
        let agent;

        // 代理逻辑 (保持不变)
        if (config.proxy) {
            if (typeof ytdl.createProxyAgent === 'function') {
                agent = ytdl.createProxyAgent({uri: config.proxy}, cookies);
            } else {
                agent = ytdl.createAgent(cookies);
            }
        } else {
            agent = ytdl.createAgent(cookies);
        }

        // 3. 获取视频信息
        logger.debug(`正在解析: ${link.id}`);
        const info = await ytdl.getInfo(videoUrl, {
            agent,
            requestOptions: {
                headers: {
                    'User-Agent': config.userAgent,
                    'Cookie': cookieString
                }
            }
        });

        const details = info.videoDetails;
        const title = details.title;
        const authorName = details.author.name;
        const description = details.description || '';

        // 取最高质量封面
        const coverUrl = details.thumbnails.length > 0
            ? details.thumbnails[details.thumbnails.length - 1].url
            : undefined;

        const views = numeral(parseInt(details.viewCount), config);
        const likes = details.likes ? numeral(details.likes, config) : '未知';
        const statsString = `观看: ${views} | 点赞: ${likes}`;

        // 4. 选择最佳流 (Format Selection)
        // 策略：优先选择 container: mp4 且 hasAudio + hasVideo
        // 许多 OneBot 实现不支持 DASH 音视频分离流的自动合并，因此必须寻找 muxed 流
        let formats = ytdl.filterFormats(info.formats, (f: any) => f.container === 'mp4' && f.hasAudio && f.hasVideo);

        // 如果没有找到 mp4 封装的音视频流，尝试放宽条件
        if (formats.length === 0) {
            formats = ytdl.filterFormats(info.formats, 'audioandvideo');
        }

        let format;
        if (formats.length > 0) {
            // 按分辨率(height)从小到大排序
            formats.sort((a, b) => (a.height || 0) - (b.height || 0));

            if (config.Video_ClarityPriority === '2') {
                // 高清晰度优先：直接取最大值
                format = formats[formats.length - 1];
            } else {
                // 低清晰度优先 (要求最低 480p)
                // 1. 尝试寻找 >= 480p 的格式中最小的一个
                format = formats.find(f => (f.height || 0) >= 480);

                // 2. 如果没找到 (说明所有格式都 < 480p)，则取当前可用的最高画质 (比如 360p)，
                //    避免选到 144p 这种不可用的画质，同时满足"尽可能接近480p"的意图
                if (!format) {
                    format = formats[formats.length - 1];
                }
            }
        }

        const files: FileInfo[] = [];
        if (format && format.url) {
            files.push({type: 'video', url: format.url});
            logger.debug(`选定的视频流: ${format.qualityLabel || 'unknown'} (${format.container})`);
        }

        return {
            platform: name,
            title: title,
            authorName: authorName,
            mainbody: escapeHtml(description),
            coverUrl: coverUrl,
            files: files,
            sourceUrl: videoUrl,
            stats: statsString,
        };

    } catch (error: any) {
        logger.error(`解析异常: ${error.message}`);
        if (error.message.includes('Sign in') || error.message.includes('429')) {
            await session.send('YouTube 解析被拦截。');
        } else if (error.message.includes('Private video')) {
            await session.send('解析失败：私享视频。');
        }
        return null;
    }
}
