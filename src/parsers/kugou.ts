// src/parsers/kugou.ts

import {Context, Session} from 'koishi';
import {Link, ParsedInfo, PluginConfig} from '../types';
import {escapeHtml, expandShortLink} from '../utils';

export const name = "kugou";

export function getFileCacheKey(url: string, songHash?: string): string | null {
    try {
        const u = new URL(url);
        const filename = u.pathname.split('/').filter(Boolean).pop() || 'audio';
        return songHash ? `kugou:${songHash}:${filename}` : `kugou:${filename}`;
    } catch {
        return songHash ? `kugou:${songHash}` : null;
    }
}

function createKugouAudioFile(songHash: string, url: string): { type: 'audio', url: string, cacheKey?: string } {
    const cacheKey = getFileCacheKey(url, songHash);
    return cacheKey ? {type: 'audio', url, cacheKey} : {type: 'audio', url};
}

const linkRules = [
    {
        // 匹配网页版/移动版常规链接中明文携带的 hash
        pattern: /(?:https?:\/\/)?(?:www\.|m\.)?kugou\.com\/[^"'\s]*?[?&#]hash=([a-fA-F0-9]{32})\b/gi,
        type: "song" as const,
    },
    {
        // 匹配 mixsong 链接
        pattern: /(?:https?:\/\/)?(?:www\.|m\.)?kugou\.com\/mixsong\/[a-zA-Z0-9_]+\.html\b/gi,
        type: "mixsong" as const,
    },
    {
        // 匹配 share 链接
        pattern: /(?:https?:\/\/)?(?:www\.|m\.)?kugou\.com\/share\/[a-zA-Z0-9_]+\.html\b/gi,
        type: "share" as const,
    },
    {
        // 匹配酷狗纯短链
        pattern: /(?:https?:\/\/)?(?:t\d\.|k\.)kugou\.com\/[a-zA-Z0-9_]+\b/gi,
        type: "short" as const,
    }
];

export async function match(content: string, ctx: Context, config: PluginConfig): Promise<Link[]> {
    const results: Link[] = [];
    const seen = new Set<string>();
    const initialLinks: Link[] = [];

    // 1. 正则粗匹配
    for (const rule of linkRules) {
        let m;
        rule.pattern.lastIndex = 0;
        while ((m = rule.pattern.exec(content)) !== null) {
            const id = rule.type === 'song' ? m[1] : m[0];
            const url = m[0].startsWith('http') ? m[0] : `https://${m[0]}`;
            initialLinks.push({platform: name, type: rule.type, id, url});
        }
    }

    const logger = ctx.logger(`share-links-analysis:${name}`);
    const proxy = config.proxy_settings[name] ? config.proxy : undefined;

    // 2. 深入处理各种非直接 hash 类型的链接
    for (const link of initialLinks) {
        let finalLink = link;

        // 如果不是直接命中 song (即 url 没带 hash 参数)，则必须发请求拿 HTML
        if (link.type !== 'song') {
            let finalUrl = link.url;

            if (link.type === 'short') {
                finalUrl = await expandShortLink(ctx, link.url, config, logger, proxy);
            }

            // 先尝试是否能直接在跳转后的 URL 里摘到 hash
            let hashMatch = finalUrl.match(/hash=([a-fA-F0-9]{32})/i);

            if (hashMatch) {
                finalLink = {platform: name, type: 'song', id: hashMatch[1], url: finalUrl};
            } else {
                try {
                    const reqOptions = {headers: {'User-Agent': config.userAgent}};
                    let html = await ctx.http.get(finalUrl, reqOptions);

                    // 兼容 share 页面：它自身的 DOM 可能不含目标数据，需要二次拉取 mixsong
                    if (link.type === 'share' || finalUrl.includes('/share/')) {
                        const mixsongMatch = html.match(/https?:\/\/(?:www\.)?kugou\.com\/mixsong\/\w+\.html/i);
                        if (mixsongMatch) {
                            finalUrl = mixsongMatch[0];
                            html = await ctx.http.get(finalUrl, reqOptions);
                        }
                    }

                    // 暴力提取页面中的 32 位 Hash (不再去提取多余的 album_id)
                    hashMatch = html.match(/"hash":"([a-fA-F0-9]{32})"/i) || html.match(/hash=([a-fA-F0-9]{32})/i);
                    if (hashMatch) {
                        finalLink = {platform: name, type: 'song', id: hashMatch[1], url: finalUrl};
                    }
                } catch (e) {
                    logger.warn(`提取酷狗页面 Hash 失败: ${finalUrl}`);
                }
            }
        }

        // 3. 严格去重与入队：只要没拿到 32 位合法 Hash，就不往后丢
        const key = `${finalLink.type}:${finalLink.id}`;
        if (!seen.has(key) && finalLink.type === 'song') {
            seen.add(key);
            results.push(finalLink);
        }
    }
    return results;
}

export async function process(
    ctx: Context,
    config: PluginConfig,
    link: Link,
    session: Session
): Promise<ParsedInfo | null> {
    const logger = ctx.logger(`share-links-analysis:${name}`);
    const song_hash = link.id.toLowerCase();

    try {
        logger.debug(`正在请求酷狗音乐解析: ${song_hash}`);

        const url = "http://m.kugou.com/app/i/getSongInfo.php";
        const params = {
            cmd: "playInfo",
            hash: song_hash
        };

        const headers = {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
            "Accept": "application/json, text/plain, */*",
            "Referer": "http://m.kugou.com/"
        };

        const reqOptions: any = {headers, params, responseType: 'text'};
        if (config.proxy_settings[name] && config.proxy) {
            reqOptions.proxyAgent = config.proxy;
        }

        // 拿到原始文本数据
        const rawResponse = await ctx.http.get(url, reqOptions);

        let data;
        try {
            // 手动强转 JSON
            data = typeof rawResponse === 'string' ? JSON.parse(rawResponse) : rawResponse;
        } catch (e) {
            // 打印截断的前 200 个字符。如果是被云盾拦截，这里会原形毕露显示 HTML
            logger.debug(`酷狗接口原始返回: ${typeof rawResponse === 'string' ? rawResponse.substring(0, 200) : '非文本数据'}...`);
            throw new Error("接口返回的不是合法 JSON，极有可能当前服务器 IP 已被酷狗云盾拦截，请检查控制台 Debug 日志。");
        }

        // 检查业务错误码
        if (data?.errcode !== 0) {
            throw new Error(`接口拒绝: ${data?.error || JSON.stringify(data)}`);
        }

        let coverUrl = data.album_img || data.imgUrl || "";
        // 处理封面分辨率占位符
        if (coverUrl.includes("{size}")) {
            coverUrl = coverUrl.replace("{size}", "512");
        }

        const audioUrl = data.url || "";
        const title = data.songName || "未知歌曲";
        const author = data.author_name || data.singerName || "未知歌手";

        return {
            platform: name,
            title: title,
            authorName: author,
            mainbody: escapeHtml(`歌手: ${author}`),
            coverUrl: coverUrl,
            sourceUrl: link.url,
            stats: "",
            files: audioUrl ? [createKugouAudioFile(song_hash, audioUrl)] : []
        };

    } catch (error: any) {
        logger.error(`酷狗解析异常: ${error.message}`);
        return null;
    }
}
