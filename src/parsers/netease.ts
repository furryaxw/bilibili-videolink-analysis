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
        pattern: /(?:https?:\/\/)?(?:y\.|m\.)?music\.163\.com\/(?:m\/)?(?:#\/)?program\?id=(\d+)/gi,
        type: "program" as const,
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

    // 预先声明返回所需的字段变量
    let targetSongId = songId;
    let title = '未知标题';
    let authorName = '未知作者';
    let coverUrl = '';
    let mainbody = '';
    let sourceUrl = link.url;
    let statsString = '统计信息获取失败';

    try {
        logger.debug(`正在请求网易云音乐解析: ${songId}, ${link.type}`);

        if (link.type === 'program') {
            // ========================
            // 1. 电台节目 (Program) 逻辑
            // ========================
            const progRes = await ctx.http.get(`${apiUrl}/dj/program/detail?id=${songId}`, {
                headers: {'User-Agent': config.userAgent}
            }).catch(e => {
                logger.warn(`获取电台节目失败: ${e.message}`);
                return null;
            });

            if (progRes && progRes.program && progRes.program.mainSong) {
                const prog = progRes.program;

                if (!prog.name) {
                    throw new Error("API返回了空数据（该电台节目可能已被下架或屏蔽）");
                }

                targetSongId = prog.mainSong.id.toString();
                title = prog.name;
                authorName = prog.dj?.nickname || '未知主播';
                console.log(prog)
                coverUrl = prog.coverUrl || prog.blurCoverUrl || '';
                const publishTime = prog.createTime ? new Date(prog.createTime).toLocaleDateString() : '未知';

                // 拼接所属电台名称、发布时间和节目描述
                const radioName = prog.radio?.name ? `所属电台: ${prog.radio.name}\n` : '';
                mainbody = escapeHtml(`${radioName}发布时间: ${publishTime}\n${prog.description || ''}`);

                sourceUrl = `https://music.163.com/program?id=${songId}`;
                statsString = `点赞: ${numeral(prog.likedCount || 0, config)} | 评论: ${numeral(prog.commentCount || 0, config)} | 分享: ${numeral(prog.shareCount || 0, config)}`;
            } else {
                throw new Error("获取电台节目详情失败");
            }

        } else {
            // ========================
            // 2. 普通单曲 (Song) 逻辑
            // ========================
            const [detailRes, commentRes] = await Promise.all([
                ctx.http.get(`${apiUrl}/song/detail?ids=${songId}`, {
                    headers: {'User-Agent': config.userAgent}
                }).catch(e => null),
                ctx.http.get(`${apiUrl}/comment/info/list?type=0&ids=${songId}`, {
                    headers: {'User-Agent': config.userAgent}
                }).catch(e => null)
            ]);

            if (!detailRes || detailRes.code !== 200 || !detailRes.songs || detailRes.songs.length === 0) {
                throw new Error("获取歌曲详情失败");
            }

            const songData = detailRes.songs[0];

            if (!songData.name) {
                throw new Error("API返回了空数据（该歌曲可能因版权限制已被下架）");
            }

            title = songData.name;
            authorName = songData.ar?.map((a: any) => a.name).join(' / ') || '未知歌手';
            coverUrl = songData.al?.picUrl || '';

            const albumName = songData.al?.name || '未知专辑';
            const publishTime = songData.publishTime ? new Date(songData.publishTime).toLocaleDateString() : '未知';
            mainbody = escapeHtml(`所属专辑: ${albumName}\n发行时间: ${publishTime}`);

            sourceUrl = `https://music.163.com/song?id=${songId}`;

            if (commentRes && commentRes.code === 200 && commentRes.data && commentRes.data.length > 0) {
                const statData = commentRes.data[0];
                const liked = numeral(statData.likedCount || 0, config);
                const comment = numeral(statData.commentCount || 0, config);
                const share = numeral(statData.shareCount || 0, config);
                statsString = `点赞: ${liked} | 评论: ${comment} | 分享: ${share}`;
            }
        }

        // ========================
        // 3. 统一获取音频直链
        // ========================
        const urlRes = await ctx.http.get(`${apiUrl}/song/url/v1?id=${targetSongId}&level=exhigh`, {
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
            logger.warn(`未能获取到网易云音乐 ${targetSongId} 的音频直链（可能需要 VIP 或接口失效）`);
        }

        return {
            platform: name,
            title: title,
            authorName: authorName,
            mainbody: mainbody,
            coverUrl: coverUrl,
            files: audioUrl ? [{type: 'audio', url: audioUrl}] : [],
            sourceUrl: sourceUrl,
            stats: statsString,
        };

    } catch (error: any) {
        logger.error(`网易云音乐解析异常: ${error.message}`);
        return null;
    }
}