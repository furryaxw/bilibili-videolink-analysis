import { Context, h } from 'koishi';
import {Link, ProcessedLink, BilibiliVideoInfo, PluginConfig} from '../types';
import { numeral } from '../utils';

const BILI_VIDEO_REGEX = /bilibili\.com\/video\/([ab]v[0-9a-zA-Z]+)/gim;
const BILI_SHORT_REGEX = /b23\.tv(?:\\)?\/([0-9a-zA-Z]+)/gim;

/**
 * 匹配文本中的Bilibili链接
 */
export function match(content: string): Link[] {
  const links: Link[] = [];
  let match;

  while ((match = BILI_VIDEO_REGEX.exec(content)) !== null) {
    links.push({ platform: 'bilibili', type: 'video', id: match[1], url: match[0] });
  }

  while ((match = BILI_SHORT_REGEX.exec(content)) !== null) {
    links.push({ platform: 'bilibili', type: 'short', id: match[1], url: match[0] });
  }

  return links;
}

/**
 * 处理Bilibili链接
 */
export async function process(ctx: Context, config: PluginConfig, link: Link): Promise<ProcessedLink | null> {
  try {
    if (link.type === 'short') {
      const redirectedUrl = await getRedirectedUrl(ctx, link.id);
      if (!redirectedUrl) return null;

      const newLinks = match(redirectedUrl);
      if (newLinks.length > 0) {
        return process(ctx, config, newLinks[0]); // 处理重定向后的链接
      }
      return null;
    }

    if (link.type === 'video') {
      const videoInfo = await fetchVideoInfo(ctx, config, link.id);
      if (!videoInfo || !videoInfo.data) return null;

      const text = generateTextMessage(config, videoInfo.data);
      let videoUrl: string | null = null;
      let duration: number | null = null;

      if (config.VideoParsing_ToLink !== '1') {
        const streamData = await fetchVideoStream(ctx, config, videoInfo.data);
        if(streamData) {
          videoUrl = streamData.url;
          duration = streamData.duration;
        }
      }

      return {
        text,
        videoUrl,
        duration,
        sourceUrl: `https://www.bilibili.com/video/${videoInfo.data.bvid}`
      };
    }
  } catch (error) {
    // 【修复】处理 unknown 类型的 error
    const err = error as any;
    ctx.logger('share-links-analysis').warn(`处理Bilibili链接失败 (${link.url}): ${err.message}`);
    return null;
  }
  return null;
}

// --- 内部帮助函数 ---

async function getRedirectedUrl(ctx: Context, id: string): Promise<string | null> {
  try {
    const response = await ctx.http.get(`https://b23.tv/${id}`, {
      redirect: 'manual',
    });
    // Koishi 的 http aget 不会自动抛出重定向错误，我们需要手动检查 headers
    // 实际上，对于b23.tv，它在head中返回location
    return response.headers.get('location');
  } catch (e) {
    // 【修复】处理 unknown 类型的 e
    const err = e as any;
    if (err.response?.headers?.location) {
      return err.response.headers.location;
    }
    ctx.logger('share-links-analysis').warn(`获取B站短链接重定向失败: ${err.message}`);
    return null;
  }
}

async function fetchVideoInfo(ctx: Context, config: PluginConfig, id: string): Promise<BilibiliVideoInfo | null> {
  const type = id.startsWith('BV') ? 'bvid' : 'aid';
  const url = `https://api.bilibili.com/x/web-interface/view?${type}=${id}`;
  return await ctx.http.get(url, {
    headers: { 'User-Agent': config.userAgent },
  });
}

function generateTextMessage(config: PluginConfig, data: BilibiliVideoInfo['data']): string {
  let ret = `${data.title}\n`;
  if (config.bVideoImage) ret += h.image(data.pic) + '\n';
  if (config.bVideoOwner) ret += `UP主： ${data.owner.name}\n`;
  if (config.bVideoDesc) ret += `${data.desc}\n`;
  if (config.bVideoStat) {
    ret += `点赞：${numeral(data.stat.like, config)}  投币：${numeral(data.stat.coin, config)}\n`;
    ret += `收藏：${numeral(data.stat.favorite, config)}  转发：${numeral(data.stat.share, config)}\n`;
  }
  if (config.bVideoExtraStat) {
    ret += `观看：${numeral(data.stat.view, config)}  弹幕：${numeral(data.stat.danmaku, config)}\n`;
  }
  if (config.bVideoIDPreference === 'av') {
    ret += `https://www.bilibili.com/video/av${data.aid}\n`;
  } else {
    ret += `https://www.bilibili.com/video/${data.bvid}\n`;
  }
  return ret;
}

// 【修复】为 videoData 添加类型
async function fetchVideoStream(ctx: Context, config: PluginConfig, videoData: BilibiliVideoInfo['data']): Promise<{url: string, duration: number} | null> {
  const { aid, bvid } = videoData;
  const cid = videoData.pages[0].cid; // 通常处理第一个分P
  const bilibiliVideo = ctx.BiliBiliVideo;

  try {
    const streamInfo = await bilibiliVideo.getBilibiliVideoStream(aid, bvid, cid, null, null, config.Video_ClarityPriority);
    if(streamInfo.data?.durl?.[0]?.url) {
      return {
        url: streamInfo.data.durl[0].url,
        duration: videoData.duration
      };
    }
    return null;
  } catch (error) {
    // 【修复】处理 unknown 类型的 error
    const err = error as any;
    ctx.logger('share-links-analysis').warn(`获取B站视频流失败: ${err.message}`);
    return null;
  }
}
