import { Context, h } from 'koishi';
import { Link, ProcessedLink, PluginConfig, XhsInitialState, XhsNoteData } from '../types';
import { load } from 'cheerio';
import { numeral } from '../utils';

/**
 * 在文本中匹配小红书链接 (长链接或短链接)
 * @param content 消息内容
 * @returns 匹配到的链接对象数组
 */
export function match(content: string): Link[] {
  // 正则表达式匹配包含查询参数的完整URL
  const urlRegex = /https?:\/\/(?:www\.xiaohongshu\.com\/discovery\/item\/[A-Za-z0-9]+|xhslink\.com\/[A-Za-z0-9]+)\??[^ \n\r]*/g;
  const matches = content.match(urlRegex);
  if (!matches) return [];

  return matches.map(url => ({
    platform: 'xiaohongshu',
    type: 'note',
    id: url.split('/').pop()!.split('?')[0], // 获取纯ID
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
export async function process(ctx: Context, config: PluginConfig, link: Link): Promise<ProcessedLink | null> {
  const logger = ctx.logger('share-links-analysis:xiaohongshu');

  // 步骤一：从原始分享链接中提取 xsec_token
  let token: string | null = null;
  try {
    // 【修正】解码URL中的HTML实体, 主要是 &amp; -> &
    const decodedUrl = link.url.replace(/&amp;/g, '&');
    const originalUrl = new URL(decodedUrl);
    token = originalUrl.searchParams.get('xsec_token');
    if (token) {
      logger.info(`成功从分享链接中提取 xsec_token。`);
    } else {
      logger.warn(`分享链接中未找到 xsec_token: ${link.url}`);
    }
  } catch (e) {
    logger.warn(`解析分享链接URL失败: ${link.url}`);
    // 即使URL解析失败，也继续尝试，因为短链接可能没有参数
  }

  let finalUrl = link.url;

  // 步骤二：如果是短链接，获取其跳转后的基础地址
  if (link.url.includes('xhslink.com')) {
    logger.info(`小红书短链接解析：尝试获取 ${link.url} 的最终地址`);
    try {
      const response = await ctx.http(link.url, {
        method: 'GET',
        headers: { 'User-Agent': config.userAgent },
        redirect: 'manual',
      });
      const location = response.headers.get('location');
      if (location) {
        finalUrl = location;
        logger.info(`短链接解析成功，跳转地址: ${finalUrl}`);
      }
    } catch (e: any) {
        const location = e.response?.headers?.location;
        if (location) {
            finalUrl = location;
            logger.info(`短链接解析成功，跳转地址: ${finalUrl}`);
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

  // 步骤四：获取最终页面的HTML并解析
  logger.info(`正在抓取小红书页面: ${urlToFetch}`);
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

    const jsonStr = scriptContent
      .replace(/window\.__INITIAL_STATE__\s*=\s*/, '')
      .replace(/undefined/g, 'null');

    const pageData = JSON.parse(jsonStr) as XhsInitialState;
    const noteData = Object.values(pageData.note.noteDetailMap)[0].note;

    // 【修改】完全重构图文消息的构建逻辑，严格对齐B站风格
    let text = '';
    let videoUrl: string | null = null;

    // 1. 标题 (去除方括号)
    text += `${noteData.title}\n`;

    if (noteData.type === 'video' && noteData.video) {
      videoUrl = noteData.video.media.stream.h264[0].masterUrl;

      // 2. 封面 (仅视频笔记)
      if (config.xhsCover && noteData.imageList && noteData.imageList.length > 0) {
        const coverUrl = noteData.imageList[0].infoList.find(i => i.imageScene === 'WB_DETAIL_SHARE')?.url || noteData.imageList[0].infoList[1]?.url;
        if(coverUrl) text += h.image(coverUrl) + '\n';
      }
    }

    // 3. 作者信息 (统一使用“UP主”)
    if (config.xhsAuthor) {
      text += `UP主：${noteData.user.nickname}\n`;
    }

    // 4. 简介 (添加“简介：”前缀)
    if (config.xhsDesc) {
      text += `简介：${noteData.desc}\n`;
    }

    // 5. 图片列表 (仅图文笔记)
    if (noteData.type === 'normal' && Array.isArray(noteData.imageList)) {
      const images: string[] = [];
      noteData.imageList.forEach((img) => {
        const imageUrl = img.infoList.find((i) => i.imageScene === 'WB_DETAIL_SHARE')?.url || img.infoList[1]?.url || img.url_default;
        if (imageUrl) {
            images.push(h.image(imageUrl).toString());
        }
      });
      text += images.join('\n');
      text += '\n'; // 在图片后添加一个换行
    }

    // 6. 互动数据 (去除emoji，使用“|”分割)
    if (config.xhsStat && noteData.interactInfo) {
      const likes = numeral(parseInt(noteData.interactInfo.likedCount), config);
      const favorites = numeral(parseInt(noteData.interactInfo.collectedCount), config);
      const comments = numeral(parseInt(noteData.interactInfo.commentCount), config);
      text += `点赞：${likes} | 收藏：${favorites} | 评论：${comments}`;
    }

    return {
      text: text.trim(),
      videoUrl: videoUrl,
      duration: (videoUrl && noteData.video) ? noteData.video.media.duration : null,
    };

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`抓取或解析小红书页面时失败: ${message}`);
    return null;
  }
}
