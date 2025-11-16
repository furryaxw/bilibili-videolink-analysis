// src/parsers/twitter.ts

import {Context, h, Session} from 'koishi';
import {PluginConfig, ParsedInfo, Link, FileInfo} from '../types';
import {escapeHtml, numeral} from '../utils';

// ======================
// 链接匹配规则
// ======================
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
            const username = match[1] || 'unknown';
            const tweetId = match[2] || match[1];
            let cleanUrl = match[0];

            // 处理短链接
            if (rule.type === 'short') {
                cleanUrl = `https://t.co/${tweetId}`;
                // 标准化域名
            } else {
                cleanUrl = `https://x.com/${username}/status/${tweetId}`;
            }

            if (seen.has(cleanUrl)) continue;
            seen.add(cleanUrl);

            results.push({
                platform: 'twitter',
                type: rule.type,
                id: tweetId,
                url: cleanUrl,
            });
        }
    }

    return results;
}

/**
 * 处理单条 Twitter 链接
 */
export async function process(
    ctx: Context,
    config: PluginConfig,
    link: Link,
    session: Session
): Promise<ParsedInfo | null> {
    const logger = ctx.logger('twitter:process');

    let apiUrl
    if (link.type === 'short') {
        // 短链接需先解析，但 vxtwitter 支持直接转换
        apiUrl = `https://api.vxtwitter.com/tweet?id=${link.id}`;
    }
    // 标准推文链接
    apiUrl = link.url.replace("x.com", "api.vxtwitter.com");

    if (!apiUrl) {
        logger.warn(`无效的 Twitter 链接: ${link.url}`);
        await session.send('无法解析此 Twitter 链接，URL 格式不正确');
        return null;
    }

    try {
        logger.info(`🔍 解析推文: ${apiUrl}`);
        const tweetData = await ctx.http.get(apiUrl, {
            headers: {
                'User-Agent': config.userAgent,
                'Accept': 'application/json'
            }
        });

        // 处理 API 错误
        if (tweetData?.error) {
            logger.error(`API 错误: ${tweetData.error}`);
            await session.send(`Twitter API 错误: ${tweetData.error}`);
            return null;
        }

        if (tweetData.possibly_sensitive && !config.allow_sensitive) {
            await session.send('潜在的不合规内容，已停止发送');
            return null;
        }

        // 解析媒体
        let media
        if (tweetData?.hasMedia) {
            media = parseMedia(tweetData);
        }

        const likes = numeral(parseInt(tweetData.likes), config);
        const replies = numeral(parseInt(tweetData.replies), config);
        const retweets = numeral(parseInt(tweetData.retweets), config);

        const statsString = `点赞: ${likes} | 评论: ${replies} | 转发: ${retweets}`;

        let tweet_text
        if (tweetData.replyingTo) {
            tweet_text = "回复：" + tweetData.text;
        } else {
            tweet_text = tweetData.text
        }

        const image = media?.images ? media?.images.map(img => h.image(img).toString()).join('\n') : ''
        const mainbody = escapeHtml(tweet_text) + image

        const videos = media?.videos
        let files: FileInfo[] = [];
        if (videos){
          for (const video of videos) {
            files.push({ type: "video", url: video.url });
          }
        }

        return {
            platform: 'twitter',
            title: `@${tweetData.user_screen_name} 的推文`,
            authorName: tweetData.user_name || tweetData.user_screen_name,
            mainbody: mainbody,
            sourceUrl: link.url,
            stats: statsString,
            files: files,
            coverUrl: media?.videos[0]?.preview_url,
        };

    } catch (error: any) {
        logger.error(`解析失败: ${error.message || error}`);

        // 专项错误处理
        if (error.message?.includes('429')) {
            await session.send('Twitter API 速率限制，请稍后再试');
        } else if (error.message?.includes('404')) {
            await session.send('推文不存在或已删除');
        } else if (error.message?.includes('ECONNRESET') || error.message?.includes('ETIMEDOUT')) {
            await session.send('连接 Twitter API 超时，请重试');
        } else {
            await session.send(`解析失败: ${error.message}`);
        }

        return null;
    }
}

// ======================
// 内部工具函数
// ======================

/**
 * 解析媒体数据
 */
function parseMedia(tweetData: any) {
    const images: string[] = [];
    const videos: { url: string; preview_url?: string; duration?: number }[] = [];

    for (const media of tweetData.media_extended) {
        switch (media.type) {
            case 'image':
                images.push(media.url);
                continue;
            case 'video':
                videos.push({
                    url: media.url,
                    preview_url: media.thumbnail_url,
                    duration: media.duration_millis ? media.duration_millis / 1000 : undefined
                });
                continue;
        }
    }
    return {images, videos};
}
