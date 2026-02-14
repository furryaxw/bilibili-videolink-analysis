// src/parsers/twitter.ts

import {Context, h, Session} from 'koishi';
import {FileInfo, Link, ParsedInfo, PluginConfig} from '../types';
import {escapeHtml, getEffectiveSettings, numeral} from '../utils';

export const name = "twitter";

const linkRules = [
    {
        pattern: /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com|mobile\.twitter\.com)\/([\w-]+)\/status\/(\d+)/gi,
        type: "tweet" as const,
    },
    {
        pattern: /https?:\/\/t\.co\/([a-zA-Z0-9]+)/gi,
        type: "short" as const,
    }
];

/**
 * 在文本中匹配 Twitter/X 链接
 */
export function match(content: string): Link[] {
    const results: Link[] = [];
    const seen = new Set<string>();

    for (const rule of linkRules) {
        let match;
        while ((match = rule.pattern.exec(content)) !== null) {
            const id = match[2] || match[1]; // short link 只有 group 1
            const url = rule.type === 'short'
                ? `https://t.co/${id}`
                : `https://x.com/${match[1]}/status/${id}`;

            if (seen.has(url)) continue;
            seen.add(url);

            results.push({
                platform: name,
                type: rule.type,
                id: id,
                url: url,
            });
        }
    }

    return results;
}

/**
 * 计算 Syndication API 所需的 Token
 * 算法来源: react-tweet / you-get (reverse engineered)
 */
function getToken(id: string): string {
    return ((Number(id) / 1e15) * Math.PI)
        .toString(36)
        .replace(/(0+|\.)/g, '');
}

/**
 * 移除文本末尾的 t.co 链接（通常是媒体链接或引用推文链接）
 */
function cleanTwitterLink(text: string): string {
    return text.replace(/\s*https:\/\/t\.co\/\w+\s*$/, '');
}

/**
 * 从推文数据对象中提取内容（文本、图片、视频、封面）
 * 适用于 Syndication API 数据结构
 */
function extractTweetContent(data: any, config: PluginConfig) {
    const images: string[] = [];
    const files: FileInfo[] = [];

    // 1. 图片 (Photos)
    if (data.photos && Array.isArray(data.photos)) {
        data.photos.forEach((p: any) => {
            images.push(p.url);
        });
    }

    // 2. 视频 (Video)
    // 优先从 mediaDetails 获取，因为它包含 bitrate 信息且结构更完整
    let videoVariants: any[] = [];
    let videoPoster = '';

    if (data.mediaDetails && Array.isArray(data.mediaDetails)) {
        for (const media of data.mediaDetails) {
            if (media.type === 'video' || media.type === 'animated_gif') {
                // 获取封面 (mediaDetails 中通常是 media_url_https)
                if (!videoPoster) videoPoster = media.media_url_https;

                // 获取变体
                if (media.video_info && media.video_info.variants) {
                    videoVariants.push(...media.video_info.variants);
                }
            }
        }
    }

    // 如果 mediaDetails 中没有找到视频，尝试回退到 data.video (简略版，通常无 bitrate)
    if (videoVariants.length === 0 && data.video && data.video.variants) {
        videoVariants = data.video.variants;
        if (!videoPoster) videoPoster = data.video.poster;
    }

    if (videoVariants.length > 0) {
        // 筛选 mp4 格式，兼容 content_type 和 type 字段
        const mp4Variants = videoVariants.filter((v: any) => {
            const type = v.content_type || v.type;
            return type === 'video/mp4';
        });

        let bestVariant = null;

        if (mp4Variants.length > 0) {
            // 排序逻辑
            if (config.Video_ClarityPriority === '2') {
                // 高清晰度优先: 按 bitrate 降序
                // 注意：如果使用 data.video 回退，bitrate 可能为 undefined，此时顺序可能不稳定
                bestVariant = mp4Variants.sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];
            } else {
                // 低清晰度优先: 按 bitrate 升序
                bestVariant = mp4Variants.sort((a: any, b: any) => (a.bitrate || 0) - (b.bitrate || 0))[0];
            }
        }

        if (bestVariant) {
            // 兼容 url 和 src 字段
            const videoUrl = bestVariant.url || bestVariant.src;
            if (videoUrl) {
                files.push({type: 'video', url: videoUrl});
                // 如果还没有封面（例如没有图片），使用视频封面
            }
        }
    }

    // 处理文本：如果提取到了媒体资源，通常文末的链接就是该资源的 t.co 链接，需要移除
    let text = data.text || '';
    if (images.length > 0 || files.length > 0) {
        text = cleanTwitterLink(text);
    }

    return {
        text,
        screenName: data.user?.screen_name || 'unknown',
        images,
        files,
        cover: videoPoster
    };
}

/**
 * 从 VxTwitter API 数据对象中提取内容
 * 适用于 api.vxtwitter.com 数据结构
 */
function extractVxContent(data: any) {
    const images: string[] = [];
    const files: FileInfo[] = [];
    let videoPoster = '';

    if (data.media_extended && Array.isArray(data.media_extended)) {
        for (const media of data.media_extended) {
            if (media.type === 'image') {
                images.push(media.url);
            } else if (media.type === 'video' || media.type === 'gif') {
                files.push({type: 'video', url: media.url});
                if (!videoPoster && media.thumbnail_url) {
                    videoPoster = media.thumbnail_url;
                }
            }
        }
    }

    let text = data.text || '';
    // VxTwitter 有时会自动清理链接，但也可能保留，尝试清理
    if (images.length > 0 || files.length > 0) {
        text = cleanTwitterLink(text);
    }

    return {
        text,
        screenName: data.user_screen_name || 'unknown',
        authorName: data.user_name || 'Unknown',
        images,
        files,
        cover: videoPoster
    };
}

/**
 * 使用 VxTwitter API 进行回退解析
 */
async function handleVxFallback(
    ctx: Context,
    config: PluginConfig,
    tweetId: string,
    session: Session
): Promise<ParsedInfo | null> {
    const logger = ctx.logger(`share-links-analysis:${name}:fallback`);
    // 使用 Twitter 作为占位符，VxAPI 会根据 ID 自动解析
    const apiUrl = `https://api.vxtwitter.com/Twitter/status/${tweetId}`;

    try {
        logger.debug(`请求 VxAPI: ${apiUrl}`);
        const data = await ctx.http.get(apiUrl, {
            headers: {
                'User-Agent': config.userAgent
            }
        });

        if (!data) throw new Error('VxAPI 返回无效');

        // 敏感内容检查 (VxTwitter 返回 possibly_sensitive)
        const settings = await getEffectiveSettings(ctx, session.guildId, config);
        if (data.possibly_sensitive && !settings.nsfw) {
            if (config.showError) await session.send('内容包含敏感信息，已停止解析 (Fallback)');
            return null;
        }

        const main = extractVxContent(data);
        const statsString = `点赞: ${numeral(data.likes, config)} | 评论: ${numeral(data.replies, config)} | 转发: ${numeral(data.retweets, config)}`;

        // 构建主推文正文
        let mainbody = escapeHtml(main.text);
        if (main.images.length > 0) {
            mainbody += '\n' + main.images.map(img => h.image(img).toString()).join('\n');
        }

        const files: FileInfo[] = [...main.files];
        const coverUrl = main.cover;

        // 解析引用推文 (Quoted Tweet)
        if (data.quoted_tweet) {
            mainbody = cleanTwitterLink(mainbody);
            const quote = extractVxContent(data.quoted_tweet);
            mainbody += `\n----------\n[引用 @${quote.screenName}]: ${escapeHtml(quote.text)}`;
            if (quote.images.length > 0) {
                mainbody += '\n' + quote.images.map(img => h.image(img).toString()).join('\n');
            }
            files.push(...quote.files);
        }

        return {
            platform: name,
            title: `@${main.screenName} 的推文`,
            authorName: main.authorName,
            mainbody,
            sourceUrl: `https://x.com/${main.screenName}/status/${tweetId}`,
            stats: statsString,
            files,
            coverUrl
        };

    } catch (e: any) {
        logger.error(`VxTwitter fallback failed: ${e.message}`);
        // 这里不再抛出错误给上层，而是返回 null 或让 process 最后的错误处理接管
        throw e;
    }
}

export async function process(
    ctx: Context,
    config: PluginConfig,
    link: Link,
    session: Session
): Promise<ParsedInfo | null> {
    const logger = ctx.logger(`share-links-analysis:${name}`);

    // 处理短链接
    let tweetId = link.id;
    if (link.type === 'short') {
        try {
            const res = await ctx.http('HEAD', link.url, {redirect: 'follow'});
            const match = /status\/(\d+)/.exec(res.url);
            if (match) tweetId = match[1];
            else throw new Error('无法还原短链接');
        } catch (e) {
            logger.warn(`短链接解析失败: ${e}`);
            return null;
        }
    }

    // 尝试首选: Syndication API
    try {
        const token = getToken(tweetId);
        const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=${token}`;

        logger.debug(`请求 API: ${apiUrl}`);
        const data = await ctx.http.get(apiUrl, {
            headers: {
                'User-Agent': config.userAgent,
                'Accept': '*/*'
            }
        });

        if (!data || !data.text) {
            throw new Error('API 返回数据无效或推文不存在');
        }

        // 敏感内容检查
        const settings = await getEffectiveSettings(ctx, session.guildId, config);
        if (data.possibly_sensitive && !settings.nsfw) {
            if (config.showError) await session.send('内容包含敏感信息，已停止解析');
            return null;
        }

        // 数据提取 (Syndication Logic)
        const user = data.user;
        const authorName = user?.name || 'Unknown';
        const screenName = user?.screen_name || 'unknown';
        const statsString = `点赞: ${numeral(data.favorite_count, config)} | 评论: ${numeral(data.conversation_count, config)}`;

        // 解析主推文
        const main = extractTweetContent(data, config);

        // 构建主推文正文
        let mainbody = main.text;
        if (main.images.length > 0) {
            mainbody += '\n' + main.images.map(img => h.image(img).toString()).join('\n');
        }

        const files: FileInfo[] = [...main.files];
        const coverUrl = main.cover;

        // 解析引用推文 (Quoted Tweet)
        if (data.quoted_tweet) {
            // 如果存在引用推文，主推文文末通常会有一个指向该引用的链接，需要移除
            mainbody = cleanTwitterLink(mainbody);

            const quoteData = data.quoted_tweet;
            const quote = extractTweetContent(quoteData, config);

            // 追加引用推文内容
            mainbody += `\n----------\n[引用 @${quote.screenName}]: ${quote.text}`;

            // 追加引用推文图片
            if (quote.images.length > 0) {
                mainbody += '\n' + quote.images.map(img => h.image(img).toString()).join('\n');
            }

            // 追加引用推文视频到文件列表
            files.push(...quote.files);
        }

        return {
            platform: name,
            title: `@${screenName} 的推文`,
            authorName,
            mainbody,
            sourceUrl: `https://x.com/${screenName}/status/${tweetId}`,
            stats: statsString,
            files,
            coverUrl
        };

    } catch (error: any) {
        // 如果是 429 (Rate Limit) 或其他非 404 错误，尝试 Fallback
        // 404 通常意味着推文真的没了，但有时候 API 抽风也会 404
        const isNotFound = error.response?.status === 404;

        if (!isNotFound) {
            logger.warn(`Syndication API 失败 (${error.message})，尝试 VxTwitter Fallback...`);
            try {
                return await handleVxFallback(ctx, config, tweetId, session);
            } catch (fallbackError: any) {
                logger.error(`Fallback 失败: ${fallbackError.message}`);
            }
        }

        // 最终错误处理
        logger.error(`Twitter 解析失败: ${error.message}`);
        if (error.response?.status === 404) {
            await session.send('推文不存在或已被删除');
        } else if (error.response?.status === 429) {
            await session.send('API 请求过频，请稍后');
        }
        return null;
    }
}