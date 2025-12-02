// src/core.ts

import { Context, Session } from 'koishi';
import { Link, PluginConfig, ParsedInfo } from './types'; // 导入 ParsedInfo
import * as Bilibili from './parsers/bilibili';
import * as Xiaohongshu from './parsers/xiaohongshu';
import * as Twitter from './parsers/twitter';
import * as Xiaoheihe from './parsers/xiaoheihe';

// 定义所有支持的解析器
const parsers = [Bilibili, Xiaohongshu, Twitter, Xiaoheihe];
export const parsers_str = parsers.map(p => p.name);

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
 * @param session 当前会话对象
 * @returns 处理后的链接结果，如果失败则返回 null
 */
export async function processLink(ctx: Context, config: PluginConfig, link: Link, session: Session): Promise<ParsedInfo | null> {
  for (const parser of parsers) {
    if (parser.match(link.url).length > 0) {
      return await parser.process(ctx, config, link, session);
    }
  }
  return null;
}

export async function init(ctx: Context, config: PluginConfig) {
  for (const parser of parsers) {
    // @ts-ignore
    if (typeof parser.init === 'function') {
      // @ts-ignore
      await parser.init(ctx, config);
    }
  }
  return null;
}
