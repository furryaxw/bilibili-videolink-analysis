// src/parsers/xiaohongshu.ts

import {Context, Session} from 'koishi';
import {Link, ParsedInfo, PluginConfig, XhsInitialState} from '../types';
import { Cookie } from 'puppeteer';
import {load} from 'cheerio';
import {numeral} from '../utils';

/**
 * 在文本中匹配小红书链接 (长链接或短链接)
 * @param content 消息内容
 * @returns 匹配到的链接对象数组
 */
export function match(content: string): Link[] {
  const urlRegex = /https?:\/\/(?:www\.xiaohongshu\.com\/discovery\/item\/[A-Za-z0-9]+|xhslink\.com\/[A-Za-z0-9]+)\??[^ \n\r]*/g;
  const matches = content.match(urlRegex);
  if (!matches) return [];

  return matches.map(url => ({
    platform: 'xiaohongshu',
    type: 'note',
    id: url.split('/').pop()!.split('?')[0],
    url: url
  }));
}

/**
 * 使用 Puppeteer 刷新小红书 Cookie 并存入数据库
 * @param ctx - Koishi Context
 */
export async function refreshXhsCookie(ctx: Context, config: PluginConfig): Promise<boolean> {
  const logger = ctx.logger('share-links-analysis:xiaohongshu');
  const platformId = 'xiaohongshu';

  if (!ctx.puppeteer) {
    logger.warn('Puppeteer 服务未启用，无法自动刷新 Cookie。');
    return false;
  }

  logger.info('正在尝试使用 Puppeteer 自动刷新小红书 Cookie...');
  try {
    const page = await ctx.puppeteer.page();
    await page.setUserAgent(config.userAgent);

    try {
      await page.goto('https://www.xiaohongshu.com', {
        waitUntil: 'domcontentloaded',
        timeout: 10000
      });
    } catch (error) {
      logger.error('Puppeteer 访问小红书首页时发生错误:', error);
    }

    // 获取页面上的所有 Cookie
    const cookies = await page.cookies();
    if (cookies.length === 0) {
      logger.warn('Puppeteer 访问了页面，但未能获取到任何 Cookie。');
      await page.close();
      return false;
    }

    // 将 Cookie 数组格式化为可用的字符串
    const cookieString = cookies.map((c: Cookie) => `${c.name}=${c.value}`).join('; ');

    // 将新 Cookie 存入数据库
    await ctx.database.upsert('sla_cookie_cache', [{ platform: platformId, cookie: cookieString }]);

    logger.info('成功使用 Puppeteer 刷新并缓存了小红书 Cookie！');
    await page.close();
    return true;
  } catch (error) {
    logger.error('使用 Puppeteer 刷新 Cookie 时发生错误: ', error);
    return false;
  }
}

/**
 * 处理单个小红书链接
 * @param ctx Koishi Context
 * @param config 插件配置
 * @param link 匹配到的链接对象
 * @param session
 * @returns 处理后的标准格式对象
 */
export async function process(ctx: Context, config: PluginConfig, link: Link, session: Session): Promise<ParsedInfo | null> {
  const logger = ctx.logger('share-links-analysis:xiaohongshu');
  const platformId = 'xiaohongshu';

  // 步骤一：从原始分享链接中提取 xsec_token
  let token: string | null = null;
  try {
    // 解码URL中的HTML实体, 主要是 &amp; -> &
    const decodedUrl = link.url.replace(/&amp;/g, '&');
    const originalUrl = new URL(decodedUrl);
    token = originalUrl.searchParams.get('xsec_token');
    if (token && config.logLevel === 'full') {
      logger.info(`成功从分享链接中提取 xsec_token。`);
    } else if (config.logLevel === 'full') {
      logger.debug(`分享链接中未找到 xsec_token: ${link.url}`);
    }
  } catch (e) {
    if (config.logLevel === 'full') logger.debug(`解析分享链接URL失败: ${link.url}`);
  }

  let finalUrl = link.url;

  // 步骤二：如果是短链接，获取其跳转后的基础地址
  if (link.url.includes('xhslink.com')) {
    if (config.logLevel === 'full') logger.info(`小红书短链接解析：尝试获取 ${link.url} 的最终地址`);
    try {
      await ctx.http(link.url, {
        method: 'GET',
        headers: { 'User-Agent': config.userAgent },
        redirect: 'manual',
      });
    } catch (e: any) {
        const location = e.response?.headers?.location;
        if (location) {
            finalUrl = location;
            if (config.logLevel === 'full') logger.info(`短链接解析成功，跳转地址: ${finalUrl}`);
        } else {
            logger.error(`解析短链接时发生网络错误: ${e.message}`);
            return null;
        }
    }
  }

  // 步骤三：构建最终要抓取的URL
  let urlToFetch: string;
  try {
    const baseUrl = finalUrl.split('?')[0];
    if (token) {
      const targetUrl = new URL(baseUrl);
      targetUrl.searchParams.set('xsec_token', token);
      urlToFetch = targetUrl.toString();
    } else {
      urlToFetch = finalUrl;
    }
  } catch(e) {
    logger.error(`构建最终请求URL失败: ${finalUrl}`);
    return null;
  }

  if (config.logLevel === 'full') logger.info(`正在抓取小红书页面: ${urlToFetch}`);
  try {
    const dbCache = await ctx.database.get('sla_cookie_cache', platformId);
    let currentCookie = (dbCache && dbCache.length > 0) ? dbCache[0].cookie : '';
    const requestHeaders: Record<string, string> = {
      'User-Agent': config.userAgent,
    };
    if (currentCookie) {
      requestHeaders['Cookie'] = currentCookie;
    } else {
      logger.warn('警告！没有找到缓存的小红书cookie');
      await session.send("小红书 Cookie 未配置或自动刷新失败，无法解析链接。请联系管理员。");
    }

    const fullResponse = await ctx.http(urlToFetch, { method: 'GET', headers: requestHeaders });

    const responseHtml = fullResponse.data;

    const $ = load(responseHtml);
    const scriptContent = $('script:contains("window.__INITIAL_STATE__")').html();

    if (!scriptContent) {
      logger.error('在页面中未找到 __INITIAL_STATE__ 数据块，可能是token无效或小红书策略变更。');
      return null;
    }

    const jsonStr = scriptContent.replace(/window\.__INITIAL_STATE__\s*=\s*/, '').replace(/undefined/g, 'null');
    const pageData = JSON.parse(jsonStr) as XhsInitialState;
    const noteKey = Object.keys(pageData.note.noteDetailMap)[0];
    if (!noteKey) {
        logger.error('无法在页面数据中找到笔记详情。');
        return null;
    }
    const noteData = pageData.note.noteDetailMap[noteKey].note;

    logger.error(pageData.note);

    // --- 构建结构化数据 ---
    let videoUrl: string | null = null;
    let coverUrl: string | undefined = undefined;
    const images: string[] = [];

    if (noteData.type === 'video' && noteData.video) {
        if (config.logLevel === 'full') {
            logger.info(`[XHS Video Debug] 发现视频笔记，视频数据对象: \n${JSON.stringify(noteData.video, null, 2)}`);
        }
        if (noteData.video.media?.stream?.h264?.[0]?.masterUrl) {
            videoUrl = noteData.video.media.stream.h264[0].masterUrl;
            if (config.logLevel === 'full') {
                logger.info(`[XHS Video Debug] 已提取视频链接: ${videoUrl}`);
            }
        } else {
            logger.warn('[XHS Video Debug] 未能从预期路径 `note.video.media.stream.h264[0].masterUrl` 找到视频链接。');
        }

      if (noteData.imageList && noteData.imageList.length > 0) {
        coverUrl = noteData.imageList[0].infoList.find(i => i.imageScene === 'WB_DETAIL_SHARE')?.url || noteData.imageList[0].infoList[1]?.url;
      }
    } else if (noteData.type === 'normal' && Array.isArray(noteData.imageList)) {
      noteData.imageList.forEach((img) => {
        const imageUrl = img.infoList.find((i) => i.imageScene === 'WB_DETAIL_SHARE')?.url || img.infoList[1]?.url || img.url_default;
        if (imageUrl) {
            images.push(imageUrl);
        }
      });
    }

    const stats = {
        '点赞': numeral(parseInt(noteData.interactInfo.likedCount), config),
        '收藏': numeral(parseInt(noteData.interactInfo.collectedCount), config),
        '评论': numeral(parseInt(noteData.interactInfo.commentCount), config),
    };
    let statsString = config.xiaohongshuStatsFormat;
    (Object.keys(stats) as Array<keyof typeof stats>).forEach(key => {
        statsString = statsString.replace(`{${key}}`, stats[key]);
    });

    return {
      platform: 'xiaohongshu',
      title: noteData.title,
      authorName: noteData.user.nickname,
      description: noteData.desc.trim(),
      coverUrl: coverUrl,
      videoUrl: videoUrl,
      duration: (videoUrl && noteData.video?.media?.duration) ? noteData.video.media.duration / 1000 : null,
      sourceUrl: urlToFetch,
      stats: statsString,
      images: images.length > 0 ? images : undefined,
    };

  } catch (error: any) {
    logger.error(`抓取或解析小红书页面时失败: ${error.message}`);
    return null;
  }
}
