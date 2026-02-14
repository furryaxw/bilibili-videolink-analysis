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
 * 适用于主推文和 quoted_tweet
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

    // 构造 Syndication API URL
    const token = getToken(tweetId);
    const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=${token}`;

    try {
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

        // 数据提取
        const user = data.user;
        const authorName = user?.name || 'Unknown';
        const screenName = user?.screen_name || 'unknown';
        const statsString = `点赞: ${numeral(data.favorite_count, config)} | 评论: ${numeral(data.conversation_count, config)}`;

        // 解析主推文
        const main = extractTweetContent(data, config);

        // 构建主推文正文
        let mainbody = escapeHtml(main.text);
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
            mainbody += `\n----------\n[引用 @${quote.screenName}]: ${escapeHtml(quote.text)}`;

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
        logger.error(`Twitter 解析失败: ${error.message}`);
        if (error.response?.status === 404) {
            await session.send('推文不存在或已被删除');
        } else if (error.response?.status === 429) {
            await session.send('API 请求过频，请稍后');
        }
        return null;
    }
}