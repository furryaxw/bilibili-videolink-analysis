// src/parsers/qqmusic.ts

import {Context, Session} from 'koishi';
import {Link, ParsedInfo, PluginConfig} from '../types';
import {escapeHtml, expandShortLink, getCookie, numeral} from '../utils';

export const name = "qqmusic";

// 保存全局的 GUID
let currentGuid: string = "";

// 生成 10 位数字符串模拟真实客户端 GUID
function generateGuid(): string {
    return String(Math.floor(Math.random() * 10000000000));
}

// 插件启动时的初始化钩子 (由 core.ts 自动调用)
export async function init(ctx: Context, config: PluginConfig) {
    currentGuid = generateGuid();
    ctx.logger(`share-links-analysis:${name}`).info(`QQ 音乐已生成初始 GUID: ${currentGuid}`);
}

const linkRules = [
    {
        // 匹配 songDetail 链接
        pattern: /(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)+qq\.com\/[^"'\s]*?songDetail\/([A-Za-z0-9]+)/gi,
        type: "song" as const,
    },
    {
        // 匹配 songmid 参数链接
        pattern: /(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)+qq\.com\/[^"'\s]*?\bsongmid=([A-Za-z0-9]+)/gi,
        type: "song" as const,
    },
    {
        // 匹配 QQ 音乐客户端生成的短链
        pattern: /(?:https?:\/\/)?[a-zA-Z0-9-]+\.y\.qq\.com\/base\/fcgi-bin\/u\?[^"'\s]*?\b__=[a-zA-Z0-9]+/gi,
        type: "short" as const,
    }
];

export async function match(content: string, ctx: Context, config: PluginConfig): Promise<Link[]> {
    const results: Link[] = [];
    const seen = new Set<string>();
    const initialLinks: Link[] = [];

    // 1. 粗匹配
    for (const rule of linkRules) {
        let m;
        rule.pattern.lastIndex = 0;
        while ((m = rule.pattern.exec(content)) !== null) {
            if (rule.type === 'short') {
                const url = m[0].startsWith('http') ? m[0] : `https://${m[0]}`;
                initialLinks.push({platform: name, type: rule.type, id: m[0], url});
            } else {
                const id = m[1];
                // 统一构造长链作为基准
                initialLinks.push({
                    platform: name,
                    type: rule.type,
                    id,
                    url: `https://y.qq.com/n/ryqq/songDetail/${id}`
                });
            }
        }
    }

    const logger = ctx.logger(`share-links-analysis:${name}`);
    const proxy = config.proxy_settings[name] ? config.proxy : undefined;

    // 2. 短链还原及去重
    for (const link of initialLinks) {
        let finalLink = link;

        if (link.type === 'short') {
            const finalUrl = await expandShortLink(ctx, link.url, config, logger, proxy);

            // 尝试从跳转后的长链中提取 songmid
            let idMatch = /songDetail\/([A-Za-z0-9]+)/.exec(finalUrl);
            if (!idMatch) idMatch = /\bsongmid=([A-Za-z0-9]+)/.exec(finalUrl);

            if (idMatch) {
                finalLink = {
                    platform: name,
                    type: 'song',
                    id: idMatch[1],
                    url: `https://y.qq.com/n/ryqq/songDetail/${idMatch[1]}`
                };
            }
        }

        const key = `${finalLink.type}:${finalLink.id}`;
        if (!seen.has(key) && finalLink.type !== 'short') {
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
    const songmid = link.id;

    // 如果因为某些原因 currentGuid 为空，做个兜底
    if (!currentGuid) currentGuid = generateGuid();

    const cookie = await getCookie(ctx, config, name);

    const qqHeaders: Record<string, string> = {
        "User-Agent": config.userAgent,
        "Referer": "https://y.qq.com/",
        "Origin": "https://y.qq.com",
        "Content-Type": "application/json"
    };

    if (cookie) {
        qqHeaders["Cookie"] = cookie;
        logger.debug("已加载 QQ 音乐 Cookie 进行请求");
    }

    try {
        logger.debug(`正在请求 QQ 音乐解析: ${songmid}`);
        const apiUrl = "https://u.y.qq.com/cgi-bin/musicu.fcg?format=json";

        // 判断传入的是否是纯数字（song_id）
        const isNumeric = /^\d+$/.test(songmid);

        // ================= 1. 聚合 RPC 载荷 =================
        const aggregatePayload: any = {
            comm: {ct: 24, cv: 0},
            songinfo: {
                module: "music.pf_song_detail_svr",
                method: "get_song_detail_yqq",
                param: isNumeric ? {song_id: parseInt(songmid)} : {song_mid: songmid}
            },
            fav: {
                module: "music.musicasset.SongFavRead",
                method: "CgiGetSongFav",
                param: isNumeric ? {v_songId: [parseInt(songmid)]} : {v_songMid: [songmid]}
            }
        };

        // 如果是纯数字，第一步不能请求 vkey（因为没有 mid），如果是字符串则正常一并请求
        if (!isNumeric) {
            aggregatePayload.vkey = {
                module: "vkey.GetVkeyServer",
                method: "CgiGetVkey",
                param: {
                    guid: currentGuid,
                    songmid: [songmid],
                    songtype: [0],
                    uin: "0",
                    loginflag: 1,
                    platform: "20"
                }
            }
        }


        const commentUrl = `https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg?biztype=1&topid=${songmid}&cmd=8&pagenum=0&pagesize=1&format=json`;

        // ================= 2. 并行请求聚合数据与评论 =================
        const [aggRes, commentRes] = await Promise.all([
            ctx.http.post(apiUrl, aggregatePayload, {headers: qqHeaders, responseType: 'json'}).catch(e => {
                logger.warn(`聚合 RPC 请求失败: ${e.message}`);
                return null;
            }),
            ctx.http.get(commentUrl, {headers: qqHeaders, responseType: 'json'}).catch(e => {
                logger.warn(`获取评论数失败: ${e.message}`);
                return null;
            })
        ]);

        if (!aggRes || !aggRes.songinfo?.data?.track_info) {
            logger.debug(`聚合接口原始返回: ${JSON.stringify(aggRes, null, 2)}`);
            throw new Error("获取歌曲详情失败，可能该歌曲不存在、无版权或被风控拦截");
        }

        // ================= 3. 提取基础信息与统计 =================
        const track = aggRes.songinfo.data.track_info;

        if (!track || !track.name || !track.mid) {
            throw new Error("获取到的歌曲信息为空（该歌曲可能已下架、无版权或受风控限制）");
        }

        const extraInfo = aggRes.songinfo.data.info;
        const realSongMid = track.mid;

        const title = track.name;
        const artist = track.singer?.map((s: any) => s.name).join(' / ') || '未知歌手';
        const albumMid = track.album?.mid;
        const albumName = track.album?.name || '未知专辑';
        const coverUrl = albumMid ? `https://y.qq.com/music/photo_new/T002R300x300M000${albumMid}.jpg` : '';

        const publishTime = track.time_public || extraInfo?.pub_time?.content?.[0]?.value || '未知时间';
        const company = extraInfo?.company?.content?.[0]?.value || '';
        const genre = extraInfo?.genre?.content?.[0]?.value || '';
        const language = extraInfo?.lan?.content?.[0]?.value || '';
        const bpm = track.bpm || 0;

        let mainbodyText = `所属专辑: ${albumName}\n发行时间: ${publishTime}`;
        if (company) mainbodyText += `\n唱片公司: ${company}`;

        const tags = [];
        if (language) tags.push(`语种: ${language}`);
        if (genre) tags.push(`流派: ${genre}`);
        if (bpm) tags.push(`BPM: ${bpm}`);

        if (tags.length > 0) {
            mainbodyText += `\n${tags.join(' | ')}`;
        }

        const mainbody = escapeHtml(mainbodyText);

        const favCount = aggRes.fav?.data?.v_songInfo?.[0]?.favNum || 0;
        const commentCount = commentRes?.comment?.commenttotal || 0;
        const statsString = `收藏: ${numeral(favCount, config)} | 评论: ${numeral(commentCount, config)}`;

        // ================= 4. 处理直链与重试机制 =================
        let audioUrl = '';
        let purl = aggRes.vkey?.data?.midurlinfo?.[0]?.purl;

        // 第一次聚合请求中如果拿到了 purl，直接使用
        if (purl) {
            audioUrl = "https://dl.stream.qqmusic.qq.com/" + purl;
        } else {
            // 如果第一次没拿到，说明当前 GUID 可能被风控/过期，执行唯一一次刷新兜底
            logger.warn(`首次获取音频直链失败，尝试重新生成 GUID 并重试...`);
            currentGuid = generateGuid();

            const vkeyRetryPayload = {
                comm: {ct: 24, cv: 0},
                vkey: {
                    module: "vkey.GetVkeyServer",
                    method: "CgiGetVkey",
                    param: {
                        guid: currentGuid,
                        songmid: [realSongMid],
                        songtype: [0],
                        uin: "0",
                        loginflag: 1,
                        platform: "20"
                    }
                }
            };

            const retryRes = await ctx.http.post(apiUrl, vkeyRetryPayload, {
                headers: qqHeaders,
                responseType: 'json'
            }).catch(() => null);
            const retryPurl = retryRes?.vkey?.data?.midurlinfo?.[0]?.purl;

            if (retryPurl) {
                audioUrl = "https://dl.stream.qqmusic.qq.com/" + retryPurl;
                logger.info(`重试成功，已获取直链`);
            } else {
                logger.warn(`重试仍未获取到 QQ 音乐 ${songmid} 的直链（可能因为是 VIP 歌曲或付费数字专辑）`);
                logger.debug(`vkey重试原始返回: ${JSON.stringify(retryRes, null, 2)}`);
            }
        }

        return {
            platform: name,
            title: title,
            authorName: artist,
            mainbody: mainbody,
            coverUrl: coverUrl,
            files: audioUrl ? [{type: 'audio', url: audioUrl}] : [],
            sourceUrl: link.url,
            stats: statsString,
        };

    } catch (error: any) {
        logger.error(`QQ 音乐解析异常: ${error.message}`);
        return null;
    }
}