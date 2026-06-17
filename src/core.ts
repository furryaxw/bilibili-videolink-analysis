// src/core.ts

import {Context, Session} from 'koishi';
import {Link, ParsedInfo, PluginConfig} from './types';
import * as Bilibili from './parsers/bilibili';
import * as Xiaohongshu from './parsers/xiaohongshu';
import * as Twitter from './parsers/twitter';
import * as Xiaoheihe from './parsers/xiaoheihe';
import * as Youtube from './parsers/youtube';
import * as Netease from './parsers/netease';
import * as QQMusic from './parsers/qqmusic';
import * as Kugou from './parsers/kugou'
import * as Github from './parsers/github';

// 定义一个接口来描述你的 Parser 模块结构
interface ParserModule {
    name: string;
    match: (content: string, ctx: Context, config: PluginConfig) => Promise<Link[]>;
    init?: (ctx: Context, config: PluginConfig) => Promise<any> | any;
    lc_get_cookie?: (ctx: Context, config: PluginConfig) => Promise<string>;
    getFileCacheKey?: (url: string, linkId?: string) => string | null;
    process: (ctx: Context, config: PluginConfig, link: Link, session: Session) => Promise<ParsedInfo | null>;

    [key: string]: any;
}

// 强制将数组识别为 ParserModule 列表
// 这样如果某个模块忘了导出 name，IDE 这里直接就会报错提醒你，非常安全
export const parsers: ParserModule[] = [Bilibili, Xiaohongshu, Twitter, Xiaoheihe, Youtube, Netease, QQMusic, Kugou, Github];
export const parsers_str = parsers.map(p => p.name);

/**
 * 从文本中解析出所有支持的链接
 * @param content 消息内容
 * @param ctx Koishi Context
 * @param config 插件配置
 * @returns 解析出的链接对象数组
 */
export async function resolveLinks(content: string, ctx: Context, config: PluginConfig): Promise<Link[]> {
    const allLinks: Link[] = [];
    for (const parser of parsers) {
        const links = await parser.match(content, ctx, config);
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
        if (parser.name == link.platform) {
            ctx.logger('share-links-analysis').debug(`解析平台：${parser.name}，链接：${link.url}`);
            return await parser.process(ctx, config, link, session);
        }
    }
    return null;
}

export async function init(ctx: Context, config: PluginConfig) {
    const promises = parsers.map(async (parser) => {
        if (typeof parser.init === 'function') {
            try {
                await parser.init(ctx, config);
            } catch (e) {
                ctx.logger('share-links-analysis').error(`[Init Failed] Parser: ${parser.name || 'Unknown'}`, e);
            }
        }
    });

    await Promise.all(promises);
    return null;
}

export async function init_cookie(ctx: Context, config: PluginConfig) {
    // 1. 筛选出包含 lc_get_cookie 方法的 parsers
    const validParsers = parsers.filter(parser =>
        typeof parser.lc_get_cookie === 'function'
    );

    // 2. 并行执行，并构造 [key, value] 形式的元组
    // map 内部使用 async 是为了等待 cookie 结果，同时保留 parser.name
    const entries = await Promise.all(
        validParsers.map(async (parser) => {
            const cookieValue = await parser.lc_get_cookie?.(ctx, config);
            return [parser.name, cookieValue];
        })
    );

    // 3. 将 [[key, value], [key, value]] 转换为 Object { key: value }
    return Object.fromEntries(entries);
}
