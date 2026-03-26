// src/parsers/netease.ts

import {Context, Session} from 'koishi';
import {Link, ParsedInfo, PluginConfig} from '../types';
import {escapeHtml, numeral} from '../utils';

export const name = "netease";

// 匹配分享出来的网易云音乐单曲链接
const linkRules = [
    {
        pattern: /(?:https?:\/\/)?(?:y\.|m\.)?music\.163\.com\/(?:m\/)?(?:#\/)?song\?id=(\d+)/gi,
        type: "song" as const,
    },
    {
        pattern: /(?:https?:\/\/)?163cn\.tv\/\w+/gi,
        type: "short" as const, // 如果有短链的需求，预留短链处理
    }
];

export async function match(content: string, ctx: Context, config: PluginConfig): Promise<Link[]> {
    const results: Link[] = [];
    const seen = new Set<string>();
    const initialLinks: Link[] = [];

    for (const rule of linkRules) {
        let m;
        rule.pattern.lastIndex = 0;
        while ((m = rule.pattern.exec(content)) !== null) {
            const id = rule.type === 'short' ? m[0] : m[1];
            const url = rule.type === 'short' ? m[0] : `https://music.163.com/song?id=${id}`;
            initialLinks.push({ platform: name, type: rule.type, id, url });
        }
    }

    for (const link of initialLinks) {
        let finalLink = link;
        if (link.type === 'short') {
            try {
                const res = await ctx.http('HEAD', link.url, { redirect: 'follow', headers: { 'User-Agent': config.userAgent } });
                const finalUrl = res.url || link.url;
                const idMatch = finalUrl.match(/id=(\d+)/);
                if (idMatch) {
                    finalLink = { platform: name, type: 'song', id: idMatch[1], url: `https://music.163.com/song?id=${idMatch[1]}` };
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

export async function process(
    ctx: Context,
    config: PluginConfig,
    link: Link,
    session: Session
): Promise<ParsedInfo | null> {
    const logger = ctx.logger(`share-links-analysis:${name}`);

    const songId = link.id;
    const apiUrl = (config.netease_apiUrl || 'http://127.0.0.1:3000').replace(/\/$/, '');

    try {
        logger.debug(`正在请求网易云音乐解析: ${songId}`);

        // 使用 Promise.all 并行请求歌曲详情和统计信息，提升解析速度
        const [detailRes, commentRes] = await Promise.all([
            // 1. 获取歌曲详情
            ctx.http.get(`${apiUrl}/song/detail?ids=${songId}`, {
                headers: {'User-Agent': config.userAgent}
            }).catch(e => {
                logger.warn(`获取详情失败: ${e.message}`);
                return null;
            }),

            // 2. 获取歌曲状态统计信息 (评论、分享、点赞)
            ctx.http.get(`${apiUrl}/comment/info/list?type=0&ids=${songId}`, {
                headers: {'User-Agent': config.userAgent}
            }).catch(e => {
                logger.warn(`获取统计信息失败: ${e.message}`);
                return null;
            })
        ]);

        if (!detailRes || detailRes.code !== 200 || !detailRes.songs || detailRes.songs.length === 0) {
            throw new Error("获取歌曲详情失败");
        }

        const songData = detailRes.songs[0];
        const title = songData.name || '未知歌曲';
        // 拼接所有歌手的名字
        const authorName = songData.ar?.map((a: any) => a.name).join(' / ') || '未知歌手';
        const albumName = songData.al?.name || '未知专辑';
        const coverUrl = songData.al?.picUrl || '';

        const publishTime = songData.publishTime ? new Date(songData.publishTime).toLocaleDateString() : '未知';

        // 解析统计信息
        let statsString = "统计信息获取失败";
        if (commentRes && commentRes.code === 200 && commentRes.data && commentRes.data.length > 0) {
            const statData = commentRes.data[0];
            const liked = numeral(statData.likedCount || 0, config);
            const comment = numeral(statData.commentCount || 0, config);
            const share = numeral(statData.shareCount || 0, config);
            statsString = `点赞: ${liked} | 评论: ${comment} | 分享: ${share}`;
        }

        // 3. 单独获取歌曲音频直链 (exhigh 级别)
        const urlRes = await ctx.http.get(`${apiUrl}/song/url/v1?id=${songId}&level=exhigh`, {
            headers: {'User-Agent': config.userAgent}
        }).catch(e => {
            logger.warn(`获取直链失败: ${e.message}`);
            return null;
        });

        let audioUrl = '';
        if (urlRes && urlRes.code === 200 && urlRes.data && urlRes.data.length > 0) {
            audioUrl = urlRes.data[0].url;
        }

        if (!audioUrl) {
            logger.warn(`未能获取到网易云音乐 ${songId} 的音频直链（可能需要 VIP 或接口失效）`);
        }

        const mainbody = escapeHtml(`所属专辑: ${albumName}\n发行时间: ${publishTime}`);

        return {
            platform: name,
            title: title,
            authorName: authorName,
            mainbody: mainbody,
            coverUrl: coverUrl,
            files: audioUrl ? [{type: 'audio', url: audioUrl}] : [],
            sourceUrl: `https://music.163.com/song?id=${songId}`,
            stats: statsString,
        };

    } catch (error: any) {
        logger.error(`网易云音乐解析异常: ${error.message}`);
        return null;
    }
}