// src/parsers/bilibili.ts

import {Context, h, Session} from 'koishi';
import {Link, ParsedInfo, PluginConfig, BilibiliVideoInfo} from '../types';
import {escapeHtml, numeral} from '../utils';

const linkRules = [
  {
    pattern: /(?:https?:\/\/)?(?:www\.bilibili\.com\/video\/)(([ab]v[0-9a-zA-Z]+))/gi,
    type: "video" as const,
  },
  {
    pattern: /(?:https?:\/\/)?(?:b23\.tv\/([0-9a-zA-Z]+))/gi,
    type: "short" as const,
  },
];
const bvPattern = /(?<![a-zA-Z0-9/])(BV[1-9A-HJ-NP-Za-km-z]{10})(?![a-zA-Z0-9])/gi;

/**
 * 在文本中匹配B站链接 (长链/短链/纯BV号)
 * @param content 消息内容
 * @returns 匹配到的链接对象数组
 */
export function match(content: string): Link[] {
  const results: Link[] = [];
  const seen = new Set<string>();

  for (const {pattern, type} of linkRules) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const id = match[1];
      if (!id) continue;

      const host = type === "short" ? "b23.tv" : "www.bilibili.com";
      const path = type === "short" ? id : `video/${id}`;
      const url = `https://${host}/${path}`;

      if (seen.has(url)) continue;
      seen.add(url);

      results.push({
        platform: 'bilibili',
        type,
        id,
        url,
      });
    }
  }

  // 匹配独立的 BV 号（不包含在链接中）
  let bvMatch;
  while ((bvMatch = bvPattern.exec(content)) !== null) {
    const videoId = bvMatch[1];
    const url = `https://www.bilibili.com/video/${videoId}`;

    if (seen.has(url)) continue;
    seen.add(url);

    results.push({
      platform: 'bilibili',
      type: 'video',
      id: videoId,
      url,
    });
  }

  return results;
}

/**
 * 处理单个B站链接
 * @param ctx Koishi Context
 * @param config 插件配置
 * @param link 匹配到的链接对象
 * @param session
 * @returns 处理后的标准格式对象
 */
export async function process(ctx: Context, config: PluginConfig, link: Link, session: Session): Promise<ParsedInfo | null> {
  const logger = ctx.logger('share-links-analysis:bilibili');
  let videoId = link.id;
  let videoIdType = link.type;

  if (link.type === 'short') {
    let finalUrl = '';
    logger.info(`B站短链接解析：尝试解析 ${link.url}`);
    try {
      const response = await ctx.http(link.url, {
        method: 'GET',
        headers: {'User-Agent': config.userAgent},
        redirect: 'manual',
      });
      const locationHeader = response.headers.get('location');
      if (locationHeader) finalUrl = locationHeader;
    } catch (e: any) {
      const locationHeader = e.response?.headers?.location;
      if (locationHeader) {
        finalUrl = locationHeader;
      } else if (config.logLevel === 'full') {
        logger.debug(`解析短链接时发生网络错误或未找到跳转地址: ${e.message}`);
      }
    }

    if (finalUrl && (finalUrl.includes('b23.tv') || finalUrl.includes('bilibili.com/'))) {
      const urlObj = new URL(finalUrl);
      if (urlObj.hostname === 'b23.tv' || (urlObj.hostname === 'bilibili.com' && !urlObj.pathname.startsWith('/video/'))) {
        logger.warn(`标准HTTP解析方案未能解析到最终视频链接，仍然是短链接或非视频页: ${finalUrl}。切换至后备方案。`);
        finalUrl = '';
      }
    }

    if (!finalUrl && ctx.puppeteer) {
      logger.info(`标准解析方案失败或结果无效，切换至Puppeteer后备方案: ${link.url}`);
      let page = null;
      try {
        page = await ctx.puppeteer.page();
        await page.setUserAgent(config.userAgent);
        await page.goto(link.url, {waitUntil: 'networkidle0'});
        finalUrl = page.url();
      } catch (e: any) {
        logger.error(`Puppeteer方案解析短链接 ${link.url} 失败: ${e.message}`);
        return null;
      } finally {
        if (page) await page.close();
      }
    }

    if (finalUrl) {
      if (config.logLevel === 'full') logger.info(`短链接解析成功，指向: ${finalUrl}`);
      const matchedLinks = match(finalUrl);
      if (matchedLinks.length > 0 && matchedLinks[0].type === 'video') {
        videoId = matchedLinks[0].id;
        videoIdType = 'video';
      } else {
        logger.warn(`在最终链接中未找到有效的视频ID: ${finalUrl}`);
        return null;
      }
    } else {
      logger.error('短链接解析失败，且无后备方案。');
      return null;
    }
  }

  if (videoIdType !== 'video' || !videoId) {
    logger.warn(`无法从链接 ${link.url} 中解析出有效的B站视频ID。`);
    return null;
  }

  if (config.logLevel === 'full') logger.info(`获取视频信息，ID: ${videoId}`);
  const idType = videoId.startsWith('BV') ? 'bvid' : 'aid';
  const infoUrl = `https://api.bilibili.com/x/web-interface/view?${idType}=${videoId}`;

  try {
    const info = await ctx.http.get<BilibiliVideoInfo>(infoUrl, {
      headers: {'User-Agent': config.userAgent}
    });

    if (!info || !info.data) {
      logger.warn(`B站API未返回有效数据，ID ${videoId}。响应: ${JSON.stringify(info)}`);
      return null;
    }
    const data = info.data;

    // --- 获取视频直链 ---
    let videoUrl: string | null = null;
    if (config.logLevel === 'full') logger.info(`尝试获取视频流，bvid: ${data.bvid}`);
    try {
      const videoStream = await ctx.BiliBiliVideo.getBilibiliVideoStream(data.aid, data.bvid, data.pages[0].cid, config.Video_ClarityPriority === '1' ? 32 : 80, 'html5', 1);
      if (videoStream?.data?.durl?.[0]?.url) {
        videoUrl = videoStream.data.durl[0].url;
        if (config.logLevel === 'full') logger.info(`成功获取视频流，bvid: ${data.bvid}`);
      }
    } catch (e: any) {
      logger.error(`通过BiliBiliVideo服务获取视频流失败，bvid: ${data.bvid}: ${e.message}`);
    }

    const play = numeral(data.stat.view, config);
    const danmaku = numeral(data.stat.danmaku, config);
    const liked = numeral(data.stat.like, config);
    const coin = numeral(data.stat.coin, config);
    const favorite = numeral(data.stat.favorite, config);

    const statsString = `播放: ${play} | 弹幕: ${danmaku}
  点赞: ${liked} | 硬币: ${coin} | 收藏: ${favorite}`;

    return {
      platform: 'bilibili',
      title: data.title,
      authorName: data.owner.name,
      mainbody: escapeHtml(data.desc),
      coverUrl: data.pic,
      videoUrl: videoUrl,
      sourceUrl: `https://www.bilibili.com/video/${data.bvid}`,
      stats: statsString,
    };

  } catch (error: any) {
    logger.error(`获取或处理B站视频信息失败，ID ${videoId}: ${error.message}`);
    return null;
  }
}
