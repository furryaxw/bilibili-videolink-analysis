// src/parsers/youtube.ts

import { Context, Session } from 'koishi';
import { Link, ParsedInfo, PluginConfig, FileInfo } from '../types';
import { escapeHtml, numeral } from '../utils';
import ytdl from '@distube/ytdl-core';
// @ts-ignore
import { Page, Cookie } from 'puppeteer';

export const name = "youtube";

// 匹配规则：支持普通视频、短链接 (youtu.be)、Shorts 以及 Embed 链接
const linkRules = [
  {
    pattern: /https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?v=([\w-]{11})/gi,
    type: "video" as const,
  },
  {
    pattern: /https?:\/\/youtu\.be\/([\w-]{11})/gi,
    type: "video" as const,
  },
  {
    pattern: /https?:\/\/(?:www\.|m\.)?youtube\.com\/shorts\/([\w-]{11})/gi,
    type: "shorts" as const,
  },
  {
    pattern: /https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:v|embed)\/([\w-]{11})/gi,
    type: "video" as const,
  }
];

export function match(content: string): Link[] {
  const results: Link[] = [];
  const seen = new Set<string>();

  for (const rule of linkRules) {
    let match;
    while ((match = rule.pattern.exec(content)) !== null) {
      const id = match[1];
      const url = `https://www.youtube.com/watch?v=${id}`;

      if (seen.has(url)) continue;
      seen.add(url);

      results.push({
        platform: name,
        type: rule.type,
        id,
        url,
      });
    }
  }
  return results;
}

/**
 * 初始化：尝试获取 Cookie
 * 策略：优先 Puppeteer (最稳)，失败则回退到 HTTP 请求 (利用插件自身的代理设置)
 */
export async function init(ctx: Context, config: PluginConfig): Promise<boolean> {
  const logger = ctx.logger('share-links-analysis:youtube');

  // 1. 检查是否已配置手动 Cookie
  if (config.youtubeCookie && config.youtubeCookie.trim().length > 0) {
      logger.info('检测到配置文件中已填写手动 Cookie，将优先使用该 Cookie，跳过自动刷新。');
      // 可选：将配置的 Cookie 同步到数据库，或者在 process 中直接读取配置
      // 这里我们选择不写入数据库，而是每次 process 时直接读配置，方便用户随时修改
      return true;
  }

  // 2. 自动获取逻辑 (仅当未配置手动 Cookie 时执行)
  let cookieString = '';

  // --- 策略 A: 尝试 Puppeteer (受全局 puppeteer 配置影响) ---
  if (ctx.puppeteer) {
    logger.info('尝试通过 Puppeteer 获取 Cookie...');
    let page: Page | null = null;
    try {
      page = await ctx.puppeteer.page();
      await page.setUserAgent(config.userAgent);

      // Puppeteer 只能走全局代理或 Chrome 参数代理，无法在这里动态设置
      await page.goto('https://www.youtube.com', {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });

      // 尝试点击同意 (针对欧盟IP)
      try {
          const consentButton = await page.$('button[aria-label*="Accept"]');
          if (consentButton) await consentButton.click();
      } catch (e) {}

      const cookies = await page.cookies();
      if (cookies.length > 0) {
        cookieString = cookies.map((c: Cookie) => `${c.name}=${c.value}`).join('; ');
        logger.info(`Puppeteer 成功: 获取到 ${cookies.length} 个 Cookie`);
      }
    } catch (error: any) {
      logger.warn(`Puppeteer 获取失败: ${error.message}`);
    } finally {
      if (page) await page.close();
    }
  }

  // --- 策略 B: 如果 Puppeteer 失败，尝试 HTTP 回退 (使用插件独立代理) ---
  if (!cookieString) {
    logger.info('尝试通过 HTTP 请求回退获取 Cookie...');
    try {
      // 构造请求头
      const headers: Record<string, string> = {
        'User-Agent': config.userAgent,
        'Accept-Language': 'en-US,en;q=0.9',
      };

      // 创建一个专用的 http 实例，显式应用插件配置的 proxy
      // 这样才能确保 request 走你在插件里填写的代理，而不是 Koishi 全局代理
      const http = config.proxy
          ? ctx.http.extend({ proxy: config.proxy } as any)
          : ctx.http;

      const res = await http('https://www.youtube.com', {
        method: 'HEAD',
        headers: headers,
        redirect: 'manual'
      });

      let setCookie: string[] = [];

      // 兼容处理 Headers: 标准 API (Node 18+) 或 Polyfill
      if (res.headers && typeof res.headers.getSetCookie === 'function') {
          setCookie = res.headers.getSetCookie();
      } else if (res.headers && typeof res.headers.get === 'function') {
          // 降级：部分环境可能没有 getSetCookie
          const raw = res.headers.get('set-cookie');
          if (raw) setCookie = [raw];
      } else if ((res as any).headers && Array.isArray((res as any).headers['set-cookie'])) {
          // 兼容旧版 axios 风格返回
          setCookie = (res as any).headers['set-cookie'];
      }

      if (setCookie && setCookie.length > 0) {
        cookieString = setCookie.map(str => str.split(';')[0]).join('; ');
        logger.info(`HTTP 回退成功: 获取到 Cookie 字符串`);
      } else {
        logger.warn('HTTP 请求未返回 Set-Cookie 头');
      }
    } catch (error: any) {
      logger.warn(`HTTP 回退失败: ${error.message}`);
    }
  }

  // --- 写入数据库 ---
  if (cookieString) {
    await ctx.database.upsert('sla_cookie_cache', [{ platform: name, cookie: cookieString }]);
    return true;
  } else {
    logger.error('所有策略均失败，无法获取 YouTube Cookie。');
    return false;
  }
}

// 辅助函数：解析 Cookie 字符串
function parseCookieString(cookieString: string) {
    if (!cookieString) return [];
    return cookieString.split(';').map(pair => {
        const parts = pair.split('=');
        // 处理 value 中可能包含 = 的情况
        const name = parts.shift();
        const value = parts.join('=');
        if (name && value) return { name: name.trim(), value: value.trim() };
        return null;
    }).filter((c): c is {name: string, value: string} => c !== null);
}

export async function process(
  ctx: Context,
  config: PluginConfig,
  link: Link,
  session: Session
): Promise<ParsedInfo | null> {
  const logger = ctx.logger(`share-links-analysis:${name}`);
  const videoUrl = `https://www.youtube.com/watch?v=${link.id}`;

  // 修复 2: 提升变量作用域，确保 catch 块能访问
  let cookieString = '';

  try {
    // 1. 准备 Cookie
    // 优先级：配置的手动 Cookie > 数据库缓存的自动 Cookie
    if (config.youtubeCookie && config.youtubeCookie.trim().length > 0) {
        cookieString = config.youtubeCookie.trim();
        logger.debug('使用配置文件中的手动 Cookie。');
    } else {
        const dbCache = await ctx.database.get('sla_cookie_cache', name);
        cookieString = (dbCache && dbCache.length > 0) ? dbCache[0].cookie : '';
        if (cookieString) logger.debug('使用数据库缓存的自动 Cookie。');
    }

    if (!cookieString) {
      logger.debug('无 Cookie，将尝试裸连解析（风险较高）。');
    } else {
      logger.debug('已加载 Cookie，准备解析。');
    }

    const cookies = parseCookieString(cookieString);

    // 2. 创建 Agent (ytdl 专用)
    // 无论 Puppeteer 是否有代理，这里必须使用插件配置的代理来请求视频流
    let agent;
    if (config.proxy) {
        // 使用 createProxyAgent 同时处理 代理 和 Cookie
        // 注意：@distube/ytdl-core 4.x+ 支持此方法
        if (typeof ytdl.createProxyAgent === 'function') {
            logger.debug(`使用代理: ${config.proxy}`);
            agent = ytdl.createProxyAgent({ uri: config.proxy }, cookies);
        } else {
            // 如果版本较旧没有 createProxyAgent，回退到普通 Agent (代理会失效)
            logger.warn('ytdl.createProxyAgent 不存在，将忽略代理设置。请更新 @distube/ytdl-core');
            agent = ytdl.createAgent(cookies);
        }
    } else {
        // 无代理，直接使用 createAgent
        agent = ytdl.createAgent(cookies);
    }

    // 3. 获取视频信息
    logger.debug(`正在解析 YouTube 视频: ${link.id}`);

    // 尝试获取信息
    // 为了提高成功率，我们允许 ytdl 尝试使用不同的内置客户端 (如 Android, iOS)
    // 注意：@distube/ytdl-core 会自动处理客户端回退，但我们可以显式传参
    const info = await ytdl.getInfo(videoUrl, {
      agent, // 将正确的 Agent 传递给顶层选项
      requestOptions: {
        headers: {
            'User-Agent': config.userAgent,
            // 确保 headers 里也带上 Cookie，增加成功率
            'Cookie': cookieString
        }
      }
    });

    const details = info.videoDetails;

    // 4. 提取元数据
    const title = details.title;
    const authorName = details.author.name;
    const description = details.description || '';

    // 获取最高分辨率的封面
    const thumbnails = details.thumbnails;
    const coverUrl = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : undefined;

    const views = numeral(parseInt(details.viewCount), config);
    const likes = details.likes ? numeral(details.likes, config) : '未知';
    const statsString = `观看: ${views} | 点赞: ${likes}`;

    // 5. 选择最佳视频流
    // 优先寻找 MP4 封装且包含音视频的格式 (兼容性最好)
    let format = ytdl.chooseFormat(info.formats, {
        quality: 'highest',
        filter: (f: any) => f.container === 'mp4' && f.hasAudio && f.hasVideo
    });

    // 如果找不到 MP4 合流，尝试任意音视频合流
    if (!format) {
        logger.debug('未找到 MP4 合流格式，尝试查找任意音视频合流...');
        try {
            format = ytdl.chooseFormat(info.formats, {
                quality: 'highest',
                filter: 'audioandvideo'
            });
        } catch (e) {}
    }

    // 6. 构建文件列表
    const files: FileInfo[] = [];
    if (format && format.url) {
        // 只有当存在有效链接时才添加
        files.push({ type: 'video', url: format.url });
    } else {
        logger.warn('未找到合适的视频流格式。');
    }

    // 7. 构建正文
    const mainbody = escapeHtml(description);

    return {
      platform: name,
      title: title,
      authorName: authorName,
      mainbody: mainbody,
      coverUrl: coverUrl,
      files: files,
      sourceUrl: videoUrl,
      stats: statsString,
    };

  } catch (error: any) {
    if (error.message.includes('Sign in') || error.message.includes('429')) {
        const tip = cookieString
            ? '当前 Cookie 可能已失效，请更新配置中的 Cookie。'
            : '请在插件配置中填入已登录账号的 YouTube Cookie。';
        await session.send(`YouTube 解析被拦截：${tip}`);
        logger.warn(`解析拦截: ${error.message}`);
    } else if (error.message.includes('Private video')) {
        await session.send('解析失败：私享视频。');
    } else {
        logger.error(`解析异常: ${error.message}`);
    }
    return null;
  }
}
