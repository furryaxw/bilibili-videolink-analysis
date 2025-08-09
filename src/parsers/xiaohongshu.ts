import { Context, h } from 'koishi';
import { Link, ProcessedLink, PluginConfig } from '../types';
import { load } from 'cheerio'; // 引入 cheerio

// 【新增】为页面数据和图片/视频定义更详细的类型接口
interface XhsImageInfo {
  imageScene: string;
  url: string;
}

interface XhsImage {
  infoList: XhsImageInfo[];
  url_default: string;
}

interface XhsNoteData {
  title: string;
  desc: string;
  type: 'video' | 'normal';
  imageList: XhsImage[];
  video?: {
    media: {
      duration: number;
      stream: {
        h264: { masterUrl: string }[];
      };
    };
  };
}

interface XhsInitialState {
  note: {
    noteDetailMap: {
      [key: string]: {
        note: XhsNoteData;
      };
    };
  };
}

/**
 * 在文本中匹配小红书链接 (长链接或短链接)
 * @param content 消息内容
 * @returns 匹配到的链接对象数组
 */
export function match(content: string): Link[] {
  // 正则表达式现在可以同时匹配长链接和短链接
  const urlRegex = /https?:\/\/(?:www\.xiaohongshu\.com\/discovery\/item\/[A-Za-z0-9]+|xhslink\.com\/[A-Za-z0-9]+)/g;
  const matches = content.match(urlRegex);
  if (!matches) return [];

  return matches.map(url => ({
    platform: 'xiaohongshu',
    type: 'note',
    id: url.split('/').pop()!,
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
  let finalUrl = link.url;

  // 步骤一：如果是短链接，获取最终跳转地址
  if (link.url.includes('xhslink.com')) {
    logger.info(`小红书短链接解析：尝试获取 ${link.url} 的最终地址`);
    try {
      const response = await ctx.http(link.url, {
        method: 'GET',
        headers: {
          'User-Agent': config.userAgent
        },
        redirect: 'manual',
      });
      const location = response.headers.get('location');
      if (location) {
        finalUrl = location;
        logger.info(`短链接解析成功，最终地址: ${finalUrl}`);
      } else {
        logger.warn(`未能从响应头中找到跳转地址: ${link.url}`);
        return null;
      }
    } catch (e: any) {
      const location = e.response?.headers?.location;
      if (location) {
        finalUrl = location;
        logger.info(`短链接解析成功，最终地址: ${finalUrl}`);
      } else {
        logger.error(`解析短链接时发生网络错误: ${e.message}`);
        return null;
      }
    }
  }

  // 步骤二：获取最终页面的HTML并解析 __INITIAL_STATE__
  logger.info(`正在抓取小红书页面: ${finalUrl}`);
  try {
    const html = await ctx.http.get<string>(finalUrl, {
      headers: { 'User-Agent': config.userAgent }
    });

    const $ = load(html);
    const scriptContent = $('script:contains("window.__INITIAL_STATE__")').html();

    if (!scriptContent) {
      logger.error('在页面中未找到 __INITIAL_STATE__ 数据块。');
      return null;
    }

    const jsonStr = scriptContent
      .replace(/window\.__INITIAL_STATE__\s*=\s*/, '')
      .replace(/undefined/g, 'null');

    // 【修正】将解析出的JSON强制转换为我们定义的精确类型
    const pageData = JSON.parse(jsonStr) as XhsInitialState;

    // 步骤三：从解析后的数据中提取信息并格式化
    const noteData = Object.values(pageData.note.noteDetailMap)[0].note;

    let text = `【${noteData.title}】\n${noteData.desc}\n`;
    let videoUrl: string | null = null;

    if (noteData.type === 'video' && noteData.video) {
      videoUrl = noteData.video.media.stream.h264[0].masterUrl;
    } else {
      // TypeScript现在可以自动推断出img和i的类型，不再报错
      noteData.imageList.forEach((img) => {
        const imageUrl = img.infoList.find((i) => i.imageScene === 'WB_DETAIL_SHARE')?.url || img.infoList[1]?.url || img.url_default;
        if (imageUrl) {
            text += h.image(imageUrl) + '\n';
        }
      });
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
