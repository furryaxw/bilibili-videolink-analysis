import { Context, h } from 'koishi';
import { Link, ProcessedLink, PluginConfig, BilibiliVideoInfo } from '../types';
import { numeral } from '../utils';

/**
 * 在文本中匹配B站链接
 * @param content 消息内容
 * @returns 匹配到的链接对象数组
 */
export function match(content: string): Link[] {
  const linkRegex = [
    { pattern: /(https?:\/\/)?bilibili\.com\/video\/([ab]v[0-9a-zA-Z]+)/i, type: "video" },
    { pattern: /(https?:\/\/)?b23\.tv\/([0-9a-zA-Z]+)/i, type: "short" },
  ];

  const results: Link[] = [];

  for (const rule of linkRegex) {
    const matches = [...content.matchAll(new RegExp(rule.pattern, 'gi'))];
    for (const matchArr of matches) {
        if (matchArr[2]) {
            results.push({
                platform: 'bilibili',
                type: rule.type,
                id: matchArr[2], // 捕获组2是ID
                url: matchArr[0] // 完整匹配的URL
            });
        }
    }
  }
  return results;
}

/**
 * 处理单个B站链接
 * @param ctx Koishi Context
 * @param config 插件配置
 * @param link 匹配到的链接对象
 * @returns 处理后的标准格式对象
 */
export async function process(ctx: Context, config: PluginConfig, link: Link): Promise<ProcessedLink | null> {
  const logger = ctx.logger('share-links-analysis:bilibili');
  let videoId = link.id;
  let videoIdType = link.type;

  // 如果是短链接，需要解析出真实ID
    if (link.type === 'short') {
        let finalUrl = '';

        // 【方案一】优先使用原始插件的轻量级解析方案
        logger.info(`B站短链接解析：尝试使用轻量级HTTP方案解析 ${link.url}`);
        try {
            const response = await ctx.http(link.url, {
                method: 'GET',
                headers: { 'User-Agent': config.userAgent },
                redirect: 'manual',
            });

            // 【修正】使用 .get('location') 的标准方法来获取响应头
            const locationHeader = response.headers.get('location');
            if (locationHeader) {
                finalUrl = locationHeader;
                logger.info(`轻量级方案成功 (方式A：获取响应头)，短链接指向: ${finalUrl}`);
            }
            else if (response.data) {
                const match = String(response.data).match(/<a\s+.*?href="([^"]*)"/i);
                if (match && match[1]) {
                    finalUrl = match[1];
                    logger.info(`轻量级方案成功 (方式B：解析响应体)，短链接指向: ${finalUrl}`);
                }
            }
        } catch (e: any) {
            // 正常情况下这里不应再触发，仅作为网络错误等意外情况的捕获
            const message = e instanceof Error ? e.message : String(e);
            logger.error(`轻量级HTTP请求失败: ${message}`);
        }

    // 【方案二】如果轻量级方案失败，并且安装了Puppeteer，则使用它作为后备
    if (!finalUrl && ctx.puppeteer) {
        logger.warn(`轻量级方案解析失败，切换至Puppeteer后备方案: ${link.url}`);
        let page = null;
        try {
            page = await ctx.puppeteer.page();
            await page.setUserAgent(config.userAgent);
            await page.goto(link.url, { waitUntil: 'networkidle0' });
            finalUrl = page.url(); // 获取跳转后的最终URL
            logger.info(`Puppeteer方案成功，短链接指向: ${finalUrl}`);
        } catch(e) {
            const message = e instanceof Error ? e.message : String(e);
            logger.error(`Puppeteer方案解析短链接 ${link.url} 失败: ${message}`);
            return null;
        } finally {
            if (page) await page.close();
        }
    } else if (!finalUrl && !ctx.puppeteer) {
        logger.error('轻量级方案解析短链接失败，且未安装或启用Puppeteer服务，无法继续解析。');
        return null;
    }

    // 从最终解析出的URL里提取视频ID
    const matchedLinks = match(finalUrl);
    if (matchedLinks.length > 0 && matchedLinks[0].type === 'video') {
        videoId = matchedLinks[0].id;
        videoIdType = 'video';
    } else {
        logger.warn(`在最终链接中未找到有效的视频ID: ${finalUrl}`);
        return null;
    }
  }

  // 如果最终没能得到视频ID，则解析失败
  if (videoIdType !== 'video' || !videoId) {
    logger.warn(`无法从链接 ${link.url} 中解析出有效的B站视频ID。`);
    return null;
  }

  logger.info(`获取视频信息，ID: ${videoId}`);
  const idType = videoId.startsWith('BV') ? 'bvid' : 'aid';
  const infoUrl = `https://api.bilibili.com/x/web-interface/view?${idType}=${videoId}`;

  let info: BilibiliVideoInfo;
  try {
    info = await ctx.http.get<BilibiliVideoInfo>(infoUrl, {
      headers: { 'User-Agent': config.userAgent }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`获取B站视频信息失败，ID ${videoId}: ${message}`);
    return null;
  }

  if (!info || !info.data) {
      logger.warn(`B站API未返回有效数据，ID ${videoId}。响应: ${JSON.stringify(info)}`);
      return null;
  }
  const data = info.data;

  // --- 格式化图文消息 ---
  let text = `${data.title}\n`;
  if (config.bVideoImage) text += h.image(data.pic) + '\n';
  if (config.bVideoOwner) text += `UP主： ${data.owner.name}\n`;
  if (config.bVideoDesc && data.desc) text += `简介：${data.desc}\n`;
  if (config.bVideoStat) {
    text += `点赞: ${numeral(data.stat.like, config)} | 硬币: ${numeral(data.stat.coin, config)} | 收藏: ${numeral(data.stat.favorite, config)}\n`;
  }
  if (config.bVideoExtraStat) {
    text += `播放: ${numeral(data.stat.view, config)} | 弹幕: ${numeral(data.stat.danmaku, config)}\n`;
  }

  const sourceUrl = `https://www.bilibili.com/video/${data.bvid}`;
  if (config.bVideoShowLink) {
    text += sourceUrl;
  }

  // --- 获取视频直链 ---
  let videoUrl: string | null = null;
  if (config.VideoParsing_ToLink !== '1') {
    logger.info(`尝试获取视频流，bvid: ${data.bvid}`);
    try {
      const videoStream = await ctx.BiliBiliVideo.getBilibiliVideoStream(data.aid, data.bvid, data.pages[0].cid, config.Video_ClarityPriority === '1' ? 32 : 80, 'html5', 1);
      if (videoStream?.data?.durl?.[0]?.url) {
        videoUrl = videoStream.data.durl[0].url;
        logger.info(`成功获取视频流，bvid: ${data.bvid}`);
      } else {
        logger.warn(`未能获取视频流，bvid: ${data.bvid}。API返回的流数据无效。响应: ${JSON.stringify(videoStream)}`);
      }
    } catch(e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error(`通过BiliBiliVideo服务获取视频流失败，bvid: ${data.bvid}: ${message}`);
    }
  }

  return {
    text: text.trim(),
    videoUrl: videoUrl,
    duration: data.duration,
    sourceUrl: sourceUrl,
  };
}
