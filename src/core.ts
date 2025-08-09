import { Context } from 'koishi';
import {Link, PluginConfig, ProcessedLink} from './types';
import * as Bilibili from './parsers/bilibili';
import * as Xiaohongshu from './parsers/xiaohongshu';

// 定义所有支持的解析器
const parsers = [Bilibili, Xiaohongshu];

/**
 * 从文本中解析出所有支持的链接
 * @param content 消息内容
 * @returns 解析出的链接对象数组
 */
export function resolveLinks(content: string): Link[] {
  const allLinks: Link[] = [];
  for (const parser of parsers) {
    const links = parser.match(content);
    allLinks.push(...links);
  }
  return allLinks;
}

/**
 * 处理单个链接，并返回格式化后的结果
 * @param ctx Koishi Context
 * @param config 插件配置
 * @param link 解析出的链接对象
 * @returns 处理后的链接结果，如果失败则返回 null
 */
export async function processLink(ctx: Context, config: PluginConfig, link: Link): Promise<ProcessedLink | null> {
  for (const parser of parsers) {
    // 检查这个解析器是否能处理此类型的链接
    if (parser.match(link.url).length > 0) {
      return await parser.process(ctx, config, link);
    }
  }
  return null;
}
