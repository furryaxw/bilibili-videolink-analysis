// src/parsers/xiaohongshu.ts

import {Context} from 'koishi';
import {Link, ParsedInfo, PluginConfig, XhsInitialState} from '../types';
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
 * 处理单个小红书链接
 * @param ctx Koishi Context
 * @param config 插件配置
 * @param link 匹配到的链接对象
 * @returns 处理后的标准格式对象
 */
export async function process(ctx: Context, config: PluginConfig, link: Link): Promise<ParsedInfo | null> {
  const logger = ctx.logger('share-links-analysis:xiaohongshu');

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
      const response = await ctx.http(link.url, {
        method: 'GET',
        headers: { 'User-Agent': config.userAgent },
        redirect: 'manual',
      });
      const location = response.headers.get('location');
      if (location) {
        finalUrl = location;
        if (config.logLevel === 'full') logger.info(`短链接解析成功，跳转地址: ${finalUrl}`);
      }
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
      // 如果有token，构建一个只带token的纯净URL
      const targetUrl = new URL(baseUrl);
      targetUrl.searchParams.set('xsec_token', token);
      urlToFetch = targetUrl.toString();
    } else {
      // 【修正】如果没有token，则直接尝试访问原始最终链接
      urlToFetch = finalUrl;
    }
  } catch(e) {
    logger.error(`构建最终请求URL失败: ${finalUrl}`);
    return null;
  }

  if (config.logLevel === 'full') logger.info(`正在抓取小红书页面: ${urlToFetch}`);
  try {
    const html = await ctx.http.get<string>(urlToFetch, {
      headers: { 'User-Agent': config.userAgent }
    });
    const $ = load(html);
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
