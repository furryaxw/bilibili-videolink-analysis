import {FileInfo, ParsedInfo, PluginConfig} from './types';
import {Context, h, Logger, Session} from "koishi";
import path from 'path';
import {createWriteStream} from 'fs';
import {promisify} from 'util';
import {pipeline} from 'stream';
import {URL} from 'url';
import {Agent as HttpAgent} from 'http';
import {Agent as HttpsAgent} from 'https';
import {HttpProxyAgent} from 'http-proxy-agent';
import {HttpsProxyAgent} from 'https-proxy-agent'
import * as fs from "node:fs";

/**
 * 将数字格式化为易读的字符串（如 万、亿）
 * @param num 数字
 * @param config 插件配置
 * @returns 格式化后的字符串
 */
export function numeral(num: number, config: PluginConfig): string {
  if (config.useNumeral) {
    if (num >= 100000000) {
      return (num / 100000000).toFixed(1) + "亿";
    }
    if (num >= 10000) {
      return (num / 10000).toFixed(1) + "万";
    }
  }
  return String(num);
}

export function escapeHtml(str: string) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getProxyAgent(proxy: string | undefined, url: string): HttpAgent | HttpsAgent | undefined {
  if (!proxy) return undefined;

  const u = new URL(url);

  if (u.protocol === 'https:') {
    return new HttpsProxyAgent(proxy);
  } else {
    return new HttpProxyAgent(proxy);
  }
}

function parseHtmlToSegments(html: string): any[] {
  const segments: any[] = [];
  // 匹配 <img> 标签和普通文本
  const tokens = html.split(/(<img\s[^>]*src\s*=\s*["']?[^"'>\s]+["']?[^>]*>)/gi);

  for (const token of tokens) {
    if (!token) continue;

    const imgMatch = token.match(/<img\s[^>]*src\s*=\s*["']?([^"'>\s]+)["']?/i);
    if (imgMatch) {
      const url = imgMatch[1];
      segments.push({type: 'image', data: {file: url}});
    } else {
      // 非 <img> 部分：当作普通文本（已转义，可直接使用）
      // 注意：HTML 中的换行可能是 <br> 或 \n，根据实际情况处理
      // 此处假设换行用 \n 表示（或上游已转换）
      if (token.trim() !== '') {
        segments.push({type: 'text', data: {text: token}});
      }
    }
  }

  return segments;
}

async function downloadAndMapUrl(
  url: string,
  proxy: string | undefined,
  userAgent: string | undefined,
  localDownloadDir: string,
  onebotReadDir: string,
  logger: Logger
): Promise<string> {
  await fs.promises.mkdir(localDownloadDir, {recursive: true});

  const u = new URL(url);
  const ext = path.extname(u.pathname).split('?')[0] || '.bin';
  const safeFilename = `${Date.now()}_${Math.random().toString(36).substring(2, 10)}${ext}`;

  const actualPath = path.join(localDownloadDir, safeFilename);
  const onebotPath = path.posix.join(onebotReadDir, safeFilename);

  const fileUrl = `file://${onebotPath}`;
  return new Promise((resolve, reject) => {
    const agent = getProxyAgent(proxy, url);
    const headers = {
      'User-Agent': userAgent,
      'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Connection': 'keep-alive'
    };
    const getter = u.protocol === 'https:' ? require('https').get : require('http').get;

    const req = getter(url, {agent, timeout: 30_000, headers}, (res: any) => {
      // 处理重定向
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy();
        logger.debug(`重定向: ${url} -> ${res.headers.location}`);
        downloadAndMapUrl(res.headers.location, proxy, userAgent, localDownloadDir, onebotReadDir, logger)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        req.destroy();
        reject(new Error(`HTTP ${res.statusCode} when fetching ${url}`));
        return;
      }

      // 检查内容类型，避免下载非图片内容
      const contentType = res.headers['content-type'] || '';
      if (!contentType.startsWith('image/') && !contentType.includes('video/')) {
        req.destroy();
        reject(new Error(`Unexpected content type: ${contentType}`));
        return;
      }

      const pipelineAsync = promisify(pipeline);
      pipelineAsync(res, createWriteStream(actualPath))
        .then(() => {
          logger.debug(`下载成功: ${url} -> ${fileUrl}`);
          resolve(fileUrl);
        })
        .catch((err) => {
          req.destroy();
          reject(new Error(`Pipeline failed: ${err.message}`));
        });
    });

    req.on('error', (err: any) => {
      req.destroy();
      reject(new Error(`Request error: ${err.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

export async function getFileSize(url: string, proxy: string | undefined, userAgent: string | undefined, logger: Logger): Promise<number | null> {
  try {
    // 先尝试HEAD请求（标准方式）
    const headSize = await tryHeadRequest(url, proxy, userAgent, logger);
    if (headSize !== null) {
      return headSize;
    }

    // HEAD失败，尝试GET请求获取部分内容
    return await tryGetRequestForSize(url, proxy, userAgent, logger);
  } catch (e) {
    logger.warn(`获取文件大小失败: ${url}`, e);
    return null;
  }
}

async function tryHeadRequest(url: string, proxy: string | undefined, userAgent: string | undefined, logger: Logger): Promise<number | null> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const agent = getProxyAgent(proxy, url);
    const getter = u.protocol === 'https:' ? require('https').get : require('http').get;

    const req = getter(url, {
      agent,
      method: 'HEAD',
      timeout: 10_000,
      headers: {
        'User-Agent': userAgent,
        'Referer': 'https://www.bilibili.com/'
      }
    }, (res: any) => {
      const len = res.headers['content-length'];
      if (len && /^\d+$/.test(len)) {
        resolve(parseInt(len, 10));
      } else {
        resolve(null);
      }
      req.destroy();
    });

    req.on('error', (err: any) => {
      logger.warn(`HEAD请求失败: ${url}`, err);
      req.destroy();
      resolve(null);
    });

    req.on('timeout', () => {
      logger.warn(`HEAD请求超时: ${url}`);
      req.destroy();
      resolve(null);
    });
  });
}

async function tryGetRequestForSize(url: string, proxy: string | undefined, userAgent: string | undefined, logger: Logger): Promise<number | null> {
  proxy = undefined
  return new Promise((resolve) => {
    const u = new URL(url);
    const agent = getProxyAgent(proxy, url);
    const getter = u.protocol === 'https:' ? require('https').get : require('http').get;

    const req = getter(url, {
      agent,
      timeout: 15_000,
      headers: {
        'User-Agent': userAgent,
        'Range': 'bytes=0-1023' // 只请求前1KB
      }
    }, (res: any) => {
      const contentRange = res.headers['content-range'];
      if (contentRange) {
        // 从 Content-Range 头获取总大小，例如: "bytes 0-1023/12345678"
        const match = contentRange.match(/\/(\d+)$/);
        if (match) {
          resolve(parseInt(match[1], 10));
          req.destroy();
          return;
        }
      }

      const len = res.headers['content-length'];
      if (len && /^\d+$/.test(len)) {
        resolve(parseInt(len, 10));
      } else {
        resolve(null);
      }

      // 读取少量数据后关闭连接
      res.on('data', () => {
        req.destroy();
      });
    });

    req.on('error', (err: any) => {
      logger.warn(`GET请求获取大小失败: ${url}`, err);
      req.destroy();
      resolve(null);
    });

    req.on('timeout', () => {
      logger.warn(`GET请求获取大小超时: ${url}`);
      req.destroy();
      resolve(null);
    });
  });
}

export async function getEffectiveSettings(ctx: Context, guildId: string | undefined, config: PluginConfig) {
  if (guildId !== undefined) {
    return {
      parsers: config.default_parsers,
      nsfw: config.allow_sensitive
    };
  }

  // @ts-ignore
  const data = await ctx.database.get('sla_group_settings', guildId);
  const record = data[0]

  // 合并：自定义设置覆盖默认
  // @ts-ignore
  const effectiveParsers = { ...config.default_parsers, ...record?.custom_parsers ? record.custom_parsers : {} };
  // @ts-ignore
  const nsfw_enabled = record?.nsfw_enabled ? record.nsfw_enabled : config.allow_sensitive;
  return {
    parsers: effectiveParsers,
    nsfw: nsfw_enabled
  };
}

export async function isUserAdmin(session: Session, userId: string): Promise<boolean> {
  if (!session.guildId) return false;
  // @ts-ignore
  if (session.user?.authority >= 3) return true;
  try {
    const memberInfo = await session.bot.getGuildMember(session.guildId, userId);
    if (!memberInfo) return false;

    const adminRoles = ["owner", "admin", "administrator"];
    const memberRoles = [...(memberInfo.roles || [])].flat().filter(Boolean);

    for (const role of memberRoles) {
      if (adminRoles.includes(role.toLowerCase())) return true;
    }
    return false;
  } catch (error) {
    return true;
  }
}

export async function sendResult_plain(session: Session, config: PluginConfig, result: ParsedInfo, logger: Logger) {
  if (config.logLevel === 'full') {
    logger.info('进入普通发送');
  }

  const localDownloadDir = config.localDownloadDir;
  const onebotReadDir = config.onebotReadDir;

  let mediaCoverUrl = result.coverUrl;
  let mediaMainbody = result.mainbody;

  let proxy = undefined;
  if (config.proxy_settings[result.platform as keyof typeof config.proxy_settings]) {
    proxy = config.proxy;
    logger.info("正在使用代理");
  }

  // --- 下载封面 ---
  if (result.coverUrl) {
    try {
      mediaCoverUrl = await downloadAndMapUrl(result.coverUrl, proxy, config.userAgent, localDownloadDir, onebotReadDir, logger);
      if (config.logLevel === 'full') logger.info(`封面已下载: ${mediaCoverUrl}`);
    } catch (e) {
      logger.warn(`封面下载失败: ${result.coverUrl}`, e);
      mediaCoverUrl = '';
    }
  }

  // --- 下载 mainbody 中的图片 ---
  if (result.mainbody) {
    const imgMatches = [...result.mainbody.matchAll(/<img\s[^>]*src\s*=\s*["']?([^"'>\s]+)["']?/gi)];
    const urlMap: Record<string, string> = {};

    await Promise.all(
      imgMatches.map(async (match) => {
        const remoteUrl = match[1];
        try {
          const localUrl = await downloadAndMapUrl(remoteUrl, proxy, config.userAgent, localDownloadDir, onebotReadDir, logger);
          urlMap[remoteUrl] = localUrl;
          if (config.logLevel === 'full') logger.info(`正文图片已下载: ${localUrl}`);
        } catch (e) {
          logger.warn(`正文图片下载失败: ${remoteUrl}`, e);
        }
      })
    );

    mediaMainbody = result.mainbody;
    for (const [remote, local] of Object.entries(urlMap)) {
      const escaped = remote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      mediaMainbody = mediaMainbody.replace(new RegExp(escaped, 'g'), local);
    }
  }

  // === 模板替换 ===
  let message = config.format;
  message = message.replace(/{title}/g, escapeHtml(result.title || ''));
  message = message.replace(/{authorName}/g, escapeHtml(result.authorName || ''));
  message = message.replace(/{mainbody}/g, mediaMainbody ?? '');
  message = message.replace(/{sourceUrl}/g, escapeHtml(result.sourceUrl || ''));
  message = message.replace(/{cover}/g, mediaCoverUrl ? h.image(mediaCoverUrl).toString() : '');
  message = message.replace(/{stats}/g, escapeHtml(result.stats || ''));

  // 清理空行
  const cleanMessage = message.split('\n').filter(line => line.trim() !== '' || line.includes('<')).join('\n');

  if (config.logLevel === 'full') {
    logger.info(`解析结果: \n ${JSON.stringify(result, null, 2)}`);
  }

  const sendPromises: Promise<any>[] = [];

  // 发送主消息
  if (cleanMessage) {
    sendPromises.push(session.send(h.quote(session.messageId) + cleanMessage));
  }

  // --- 发送 files 中的所有媒体（video/audio/generic）---
  if (config.sendFiles && Array.isArray(result.files)) {
    for (const file of result.files) {
      const {type, url: remoteUrl} = file;
      if (!['video', 'audio', 'generic'].includes(type)) continue;

      let shouldSend = true;
      if (config.Max_size !== undefined) {
        const sizeBytes = await getFileSize(remoteUrl, proxy, config.userAgent, logger);
        const maxBytes = config.Max_size * 1024 * 1024;
        if (sizeBytes !== null && sizeBytes > maxBytes) {
          shouldSend = false;
          if (config.logLevel !== 'none') {
            const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
            const maxMB = config.Max_size.toFixed(2);
            sendPromises.push(session.send(`文件大小超限 (${sizeMB} MB > ${maxMB} MB)`));
            logger.info(`文件大小超限 (${sizeMB} MB > ${maxMB} MB)，跳过: ${remoteUrl}`);
          }
        }
      }

      if (shouldSend) {
        try {
          const localUrl = await downloadAndMapUrl(remoteUrl, proxy, config.userAgent, localDownloadDir, onebotReadDir, logger);
          if (!localUrl) continue;

          let element: string | null = null;
          if (type === 'video') {
            element = h.video(localUrl).toString();
          } else if (type === 'audio') {
            element = h.audio(localUrl).toString();
          } else if (type === 'generic') {
            // 注意：标准 OneBot v11 不支持 file，部分实现支持
            // 若你环境不支持，可改用文本链接：element = escapeHtml(remoteUrl);
            element = h.file(localUrl).toString();
          }

          if (element) {
            sendPromises.push(session.send(element));
            if (config.logLevel === 'link_only') {
              logger.info(`${type} 直链 (${result.platform}): ${remoteUrl}`);
            }
            if (config.logLevel === 'full') {
              const size = await getFileSize(remoteUrl, proxy, config.userAgent, logger);
              const sizeMB = size ? (size / (1024 * 1024)).toFixed(2) : 'unknown';
              logger.info(`${type} 已发送 (${sizeMB} MB): ${localUrl}`);
            }
          }
        } catch (e) {
          logger.warn(`${type} 下载/发送失败: ${remoteUrl}`, e);
        }
      }
    }
  }

  await Promise.all(sendPromises);
}

export async function sendResult_forward(session: Session, config: PluginConfig, result: ParsedInfo, logger: Logger, mixed_sending = false) {
  if (config.logLevel === 'full') {
    logger.info(mixed_sending ? '进入混合发送' : '进入合并发送');
  }

  const localDownloadDir = config.localDownloadDir;
  const onebotReadDir = config.onebotReadDir;

  let mediaCoverUrl = result.coverUrl;
  let mediaMainbody = result.mainbody;

  let proxy = undefined;
  if (config.proxy_settings[result.platform as keyof typeof config.proxy_settings]) {
    proxy = config.proxy;
    logger.info("正在使用代理");
  }

  // --- 封面 ---
  if (result.coverUrl) {
    try {
      mediaCoverUrl = await downloadAndMapUrl(result.coverUrl, proxy, config.userAgent, localDownloadDir, onebotReadDir, logger);
    } catch (e) {
      logger.warn('封面下载失败', e);
      mediaCoverUrl = '';
    }
  }

  // --- mainbody 图片 ---
  if (result.mainbody) {
    const imgUrls = [...result.mainbody.matchAll(/<img\s[^>]*src\s*=\s*["']?([^"'>\s]+)["']?/gi)].map(m => m[1]);
    const urlMap: Record<string, string> = {};
    await Promise.all(imgUrls.map(async (url) => {
      try {
        urlMap[url] = await downloadAndMapUrl(url, proxy, config.userAgent, localDownloadDir, onebotReadDir, logger);
      } catch (e) {
        logger.warn(`正文图片下载失败: ${url}`, e);
      }
    }));
    mediaMainbody = result.mainbody;
    for (const [remote, local] of Object.entries(urlMap)) {
      const escaped = remote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      mediaMainbody = mediaMainbody.replace(new RegExp(escaped, 'g'), local);
    }
  }

  // === 主消息（不含媒体文件）===
  let message = config.format;
  message = message.replace(/{title}/g, escapeHtml(result.title || ''));
  message = message.replace(/{authorName}/g, escapeHtml(result.authorName || ''));
  message = message.replace(/{sourceUrl}/g, escapeHtml(result.sourceUrl || ''));
  message = message.replace(/{stats}/g, escapeHtml(result.stats || ''));

  const lines = message.split('\n').filter(line => line.trim() !== '');
  const mainSegments: any[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLastLine = i === lines.length - 1;
    const tokens = line.split(/(\{cover\})/g);
    const currentLineSegments: any[] = [];
    let hasTextContent = false;

    for (const token of tokens) {
      if (token === '{cover}') {
        if (mediaCoverUrl) {
          currentLineSegments.push({type: 'image', data: {file: mediaCoverUrl}});
        }
      } else if (token === '{mainbody}') {
        const parsed = parseHtmlToSegments(mediaMainbody || '');
        currentLineSegments.push(...parsed);
        hasTextContent = parsed.some(seg => seg.type === 'text');
      } else if (token.trim() !== '') {
        currentLineSegments.push({type: 'text', data: {text: token}});
        hasTextContent = true;
      }
    }

    if (currentLineSegments.length > 0) {
      mainSegments.push(...currentLineSegments);
    }
    if (!isLastLine && hasTextContent) {
      mainSegments.push({type: 'text', data: {text: '\n'}});
    }
  }

  const forwardNodes: any[] = [];
  if (mainSegments.length > 0) {
    forwardNodes.push({
      type: 'node',
      data: {
        user_id: session.selfId,
        nickname: '分享助手',
        content: mainSegments
      }
    });
  }

  // --- 处理 files 中的所有媒体 ---
  const extraSendPromises: Promise<any>[] = [];

  if (config.sendFiles && Array.isArray(result.files)) {
    for (const file of result.files) {
      const {type, url: remoteUrl} = file;
      if (!['video', 'audio', 'generic'].includes(type)) continue;

      let shouldInclude = true;
      if (config.Max_size !== undefined) {
        const sizeBytes = await getFileSize(remoteUrl, proxy, config.userAgent, logger);
        const maxBytes = config.Max_size * 1024 * 1024;
        if (sizeBytes !== null && sizeBytes > maxBytes) {
          shouldInclude = false;
          if (config.logLevel !== 'none') {
            const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
            const maxMB = config.Max_size.toFixed(2);
            forwardNodes.push({
              type: 'node',
              data: {
                user_id: session.selfId,
                nickname: '分享助手',
                content: {
                  type: 'text', data: {
                    text: `文件大小超限 (${sizeMB} MB > ${maxMB} MB)`
                  }
                }
              }
            });
            logger.info(`文件大小超限 (${sizeMB} MB > ${maxMB} MB)，跳过: ${remoteUrl}`);
          }
        }
      }

      if (shouldInclude) {
        try {
          const localUrl = await downloadAndMapUrl(remoteUrl, proxy, config.userAgent, localDownloadDir, onebotReadDir, logger);
          if (!localUrl) continue;

          if (!mixed_sending) {
            // 作为转发节点发送
            let segment: any = null;
            if (type === 'video') {
              segment = {type: 'video', data: {file: localUrl}};
            } else if (type === 'audio') {
              segment = {type: 'audio', data: {file: localUrl}};
            } else if (type === 'generic') {
              // 注意：标准 OneBot 转发节点不支持 file，这里降级为文本链接
              segment = {type: 'text', data: {text: `📄 文件: ${remoteUrl}`}};
            }

            if (segment) {
              forwardNodes.push({
                type: 'node',
                data: {
                  user_id: session.selfId,
                  nickname: '分享助手',
                  content: [segment]
                }
              });
            }
          } else {
            // 混合模式：独立发送
            let element: string | null = null;
            if (type === 'video') element = h.video(localUrl).toString();
            else if (type === 'audio') element = h.audio(localUrl).toString();
            else if (type === 'generic') element = h.file(localUrl).toString();

            if (element) {
              extraSendPromises.push(session.send(element));
            }
          }

          if (config.logLevel === 'link_only') {
            logger.info(`${type} 直链 (${result.platform}): ${remoteUrl}`);
          }
        } catch (e) {
          logger.warn(`${type} 下载失败: ${remoteUrl}`, e);
        }
      }
    }
  }

  if (forwardNodes.length === 0 && extraSendPromises.length === 0) return;

  if (config.logLevel === 'full') {
    logger.info(`解析结果: \n ${JSON.stringify(result, null, 2)}`);
  }

  if (!(session.onebot && session.onebot._request)) throw new Error("Onebot is not defined");

  const promises: Promise<any>[] = [];

  if (forwardNodes.length > 0) {
    promises.push(session.onebot._request('send_group_forward_msg', {
      group_id: session.guildId,
      messages: forwardNodes,
      news: [{text: mediaMainbody || '-'}, {text: '点击查看详情 | Powered by furryaxw'}],
      prompt: result.title || '',
      summary: '分享解析',
      source: result.title || ''
    }));
  }

  if (mixed_sending && extraSendPromises.length > 0) {
    promises.push(...extraSendPromises);
  }

  await Promise.all(promises);
}
