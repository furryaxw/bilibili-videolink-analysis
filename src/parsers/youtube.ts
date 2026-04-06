// src/parsers/youtube.ts

import {Context, Session} from 'koishi';
import {Link, ParsedInfo, PluginConfig} from '../types';
import {escapeHtml, numeral} from '../utils';

export const name = "youtube";

// 匹配规则
const linkRules = [
    {
        pattern: /https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?[^"'\s]*?\bv=([\w-]{11})/gi,
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

export async function match(content: string, ctx: Context, config: PluginConfig): Promise<Link[]> {
    const results: Link[] = [];
    const seen = new Set<string>();

    for (const rule of linkRules) {
        let match;
        rule.pattern.lastIndex = 0;
        while ((match = rule.pattern.exec(content)) !== null) {
            const id = match[1];
            const key = `${rule.type}:${id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            results.push({ platform: name, type: rule.type, id, url: `https://www.youtube.com/watch?v=${id}` });
        }
    }
    return results;
}

export async function process(
    ctx: Context,
    config: PluginConfig & { youtube_ApiUrl?: string },
    link: Link,
    session: Session
): Promise<ParsedInfo | null> {
    const logger = ctx.logger(`share-links-analysis:${name}`);
    const videoUrl = link.url;

    const apiUrl = config.youtube_ApiUrl || 'http://127.0.0.1:12001';

    try {
        logger.debug(`正在请求解析: ${link.id}`);

        // 发送 POST 请求给 Python 服务
        const response = await ctx.http.post(`${apiUrl}/api/parse`, {
            url: videoUrl,
            clarity_priority: config.Video_ClarityPriority,
            max_size: config.Max_size
        }, {
            timeout: 30000
        });

        if (!response || !response.success) {
            throw new Error("Python 服务端返回异常结构");
        }

        const views = response.views ? numeral(response.views, config) : '未知';
        const likes = response.likes ? numeral(response.likes, config) : '未知';
        const comments = response.comments ? numeral(response.comments, config) : '未知';

        logger.debug(`[解析成功] 拿到视频直链: ${response.direct_url.substring(0, 50)}...`);

        return {
            platform: name,
            title: response.title,
            authorName: response.author,
            mainbody: escapeHtml(response.description),
            coverUrl: response.cover,
            files: [{type: 'video', url: response.direct_url}],
            sourceUrl: videoUrl,
            stats: `观看: ${views} | 点赞: ${likes} | 评论: ${comments}`,
        };

    } catch (error: any) {
        // 判断是否是根本连不上 Python 服务的网络错误
        const isNetworkError = error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED');

        if (isNetworkError) {
            logger.error(`无法连接到 Python 解析服务。请确认是否已部署后端。`);
            await session.send('YouTube 解析失败：无法连接到解析后端。');
        } else {
            // Python 服务内部抛出的业务错误 (如找不到直链、代理失效等)
            const detail = error.response?.data?.detail || error.message;
            logger.error(`Python 后端解析异常: ${detail}`);
        }
        return null;
    }
}