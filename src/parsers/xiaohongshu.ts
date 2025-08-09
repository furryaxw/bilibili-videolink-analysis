import { Context } from 'koishi';
import { Link, ProcessedLink, PluginConfig } from '../types';

const XHS_POST_REGEX = /xiaohongshu\.com\/explore\/([a-zA-Z0-9]+)/gim;
const XHS_SHORT_REGEX = /xhslink\.com\/([a-zA-Z0-9]+)/gim;

/**
 * 匹配文本中的小红书链接
 */
export function match(content: string): Link[] {
  const links: Link[] = [];
  let match;

  while ((match = XHS_POST_REGEX.exec(content)) !== null) {
    links.push({ platform: 'xiaohongshu', type: 'post', id: match[1], url: match[0] });
  }

  while ((match = XHS_SHORT_REGEX.exec(content)) !== null) {
    links.push({ platform: 'xiaohongshu', type: 'short', id: match[1], url: match[0] });
  }

  return links;
}

/**
 * 处理小红书链接（当前为占位）
 */
export async function process(ctx: Context, config: PluginConfig, link: Link): Promise<ProcessedLink | null> {
  ctx.logger('share-links-analysis').info(`检测到小红书链接，但暂不支持解析: ${link.url}`);

  // 未来可以在这里实现真正的解析逻辑
  // 目前返回一个提示信息
  return {
    text: `暂不支持解析小红书链接：${link.url}`,
    videoUrl: null,
    duration: null,
    sourceUrl: link.url,
  };
}
