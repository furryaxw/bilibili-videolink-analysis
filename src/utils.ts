import {ParsedInfo, PluginConfig} from './types';
import {h, Logger, Session} from "koishi";
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
  await fs.promises.mkdir(localDownloadDir, { recursive: true });

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

    const req = getter(url, {agent, timeout: 30_000, headers}, (res) => {
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

    req.on('error', (err) => {
      req.destroy();
      reject(new Error(`Request error: ${err.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}


export async function getFileSize(url: string, proxy: string | undefined, userAgent: string | undefined): Promise<number | null> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const agent = getProxyAgent(proxy, url);
    const getter = u.protocol === 'https:' ? require('https').get : require('http').get;

    const req = getter(url, {
      agent,
      method: 'HEAD',
      timeout: 10_000,
      headers: {
        'User-Agent': userAgent
      }
    }, (res) => {
      const len = res.headers['content-length'];
      if (len && /^\d+$/.test(len)) {
        resolve(parseInt(len, 10));
      } else {
        resolve(null);
      }
      req.destroy();
    });

    req.on('error', () => {
      req.destroy();
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

export async function sendResult_plain(session: Session, config: PluginConfig, result: ParsedInfo, logger: Logger) {
  if (config.logLevel === 'full') {
    logger.info('进入普通发送');
  }

  const localDownloadDir = config.localDownloadDir;
  const onebotReadDir = config.onebotReadDir;

  let mediaCoverUrl = result.coverUrl;
  let mediaVideoUrl: string | null = result.videoUrl || null;
  let mediaMainbody = result.mainbody;

  // --- 下载封面 ---
  if (result.coverUrl) {
    try {
      mediaCoverUrl = await downloadAndMapUrl(result.coverUrl, config.proxy, config.userAgent, localDownloadDir, onebotReadDir, logger);
      if (config.logLevel === 'full') logger.info(`封面已下载: ${mediaCoverUrl}`);
    } catch (e) {
      logger.warn(`封面下载失败: ${result.coverUrl}`, e);
      mediaCoverUrl = '';
    }
  }

  // --- 视频：先检查大小 ---
  let videoExceedsLimit = false;
  if (result.videoUrl) {
    const sizeBytes = await getFileSize(result.videoUrl, config.proxy, config.userAgent);
    const maxBytes = config.Max_size !== undefined ? config.Max_size * 1024 * 1024 : undefined;

    // 日志用 MB（保留 2 位小数）
    const formatMB = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2);

    if (sizeBytes === null) {
      logger.warn(`无法获取视频大小: ${result.videoUrl}，默认允许下载`);
    } else {
      const sizeMB = formatMB(sizeBytes);
      if (maxBytes !== undefined && sizeBytes > maxBytes) {
        videoExceedsLimit = true;
        mediaVideoUrl = null;
        const maxMB = config.Max_size.toFixed(2);
        if (config.logLevel !== 'none') {
          logger.info(`视频大小超限 (${sizeMB} MB > ${maxMB} MB): ${result.videoUrl}`);
        }
      } else {
        // 大小合规，执行下载
        try {
          mediaVideoUrl = await downloadAndMapUrl(result.videoUrl, config.proxy, config.userAgent, localDownloadDir, onebotReadDir, logger);
          if (config.logLevel === 'full') {
            logger.info(`视频已下载 (${sizeMB} MB): ${mediaVideoUrl}`);
          }
        } catch (e) {
          logger.warn(`视频下载失败: ${result.videoUrl}`, e);
          mediaVideoUrl = null;
        }
      }
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
          const localUrl = await downloadAndMapUrl(remoteUrl, config.proxy, config.userAgent, localDownloadDir, onebotReadDir, logger);
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

  // 处理视频相关占位符
  if (result.videoUrl) {
    message = message.replace(/{videoUrl}/g, escapeHtml(result.videoUrl));

    if (videoExceedsLimit) {
      const tip = escapeHtml(config.Max_size_tip);
      message = message.replace(/{video}/g, tip);
    } else if (mediaVideoUrl) {
      message = message.replace(/{video}/g, h.video(mediaVideoUrl).toString());
    } else {
      message = message.replace(/{video}/g, '');
    }
    if (config.logLevel === 'link_only') {
      logger.info(`视频直链 (${result.platform}): ${result.videoUrl}`);
    }
  } else {
    message = message.replace(/{video}/g, '');
    message = message.replace(/{videoUrl}/g, '');
  }

  const cleanMessage = message.split('\n').filter(line => line.trim() !== '' || line.includes('<')).join('\n');

  if (config.logLevel === 'full') {
    logger.info(`解析结果: \n ${JSON.stringify(result, null, 2)}`);
  }

  if (cleanMessage) {
    await session.send(h.quote(session.messageId) + cleanMessage);
  }
}

export async function sendResult_forward(session: Session, config: PluginConfig, result: ParsedInfo, logger: Logger, mixed_sending = false) {
  if (config.logLevel === 'full') {
    logger.info(mixed_sending ? '进入混合发送' : '进入合并发送');
  }

  const localDownloadDir = config.localDownloadDir;
  const onebotReadDir = config.onebotReadDir;

  let mediaCoverUrl = result.coverUrl;
  let mediaVideoUrl: string | null = result.videoUrl || null;
  let mediaMainbody = result.mainbody;

  // --- 封面 ---
  if (result.coverUrl) {
    try {
      mediaCoverUrl = await downloadAndMapUrl(result.coverUrl, config.proxy, config.userAgent, localDownloadDir, onebotReadDir, logger);
    } catch (e) {
      logger.warn('封面下载失败', e);
      mediaCoverUrl = '';
    }
  }

  // --- 视频大小检查 + 下载 ---
  let videoExceedsLimit = false;
  if (result.videoUrl) {
    const sizeBytes = await getFileSize(result.videoUrl, config.proxy, config.userAgent);
    const maxBytes = config.Max_size !== undefined ? config.Max_size * 1024 * 1024 : undefined;
    const formatMB = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2);

    if (sizeBytes === null) {
      logger.warn(`无法获取视频大小: ${result.videoUrl}，默认允许下载`);
    } else {
      const sizeMB = formatMB(sizeBytes);
      if (maxBytes !== undefined && sizeBytes > maxBytes) {
        videoExceedsLimit = true;
        mediaVideoUrl = null;
        const maxMB = config.Max_size.toFixed(2);
        if (config.logLevel !== 'none') {
          logger.info(`视频大小超限 (${sizeMB} MB > ${maxMB} MB): ${result.videoUrl}`);
        }
      } else {
        try {
          mediaVideoUrl = await downloadAndMapUrl(result.videoUrl, config.proxy, config.userAgent, localDownloadDir, onebotReadDir, logger);
          if (config.logLevel === 'full') {
            logger.info(`视频已下载 (${sizeMB} MB): ${mediaVideoUrl}`);
          }
        } catch (e) {
          logger.warn('视频下载失败', e);
          mediaVideoUrl = null;
        }
      }
    }
  }

  // --- mainbody 图片 ---
  if (result.mainbody) {
    const imgUrls = [...result.mainbody.matchAll(/<img\s[^>]*src\s*=\s*["']?([^"'>\s]+)["']?/gi)].map(m => m[1]);
    const urlMap: Record<string, string> = {};
    await Promise.all(imgUrls.map(async (url) => {
      try {
        urlMap[url] = await downloadAndMapUrl(url, config.proxy, config.userAgent, localDownloadDir, onebotReadDir, logger);
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

  // === 构建消息模板 ===
  let message = config.format;
  message = message.replace(/{title}/g, escapeHtml(result.title || ''));
  message = message.replace(/{authorName}/g, escapeHtml(result.authorName || ''));
  message = message.replace(/{sourceUrl}/g, escapeHtml(result.sourceUrl || ''));
  message = message.replace(/{stats}/g, escapeHtml(result.stats || ''));

  // 处理 {videoUrl} 和 {video} 占位符逻辑（用于后续判断）
  if (result.videoUrl) {
    message = message.replace(/{videoUrl}/g, escapeHtml(result.videoUrl));
    if (videoExceedsLimit) {
      const tip = escapeHtml(config.Max_size_tip);
      message = message.replace(/{video}/g, tip);
    }
    // 注意：这里不替换 {video} 为实际视频，留到转发节点构建时处理
  }

  const hasVideoInTemplate = message.includes('{video}');

  const mediaMap: Record<string, any[]> = {};
  if (mediaCoverUrl) {
    mediaMap['{cover}'] = [{type: 'image', data: {file: mediaCoverUrl}}];
  } else {
    mediaMap['{cover}'] = [];
  }

  const lines = message.split('\n').filter(line => line.trim() !== '');
  const nonVideoSegments: any[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLastLine = i === lines.length - 1;
    const tokens = line.split(/(\{cover\}|\{video\})/g);
    const currentLineSegments: any[] = [];
    let hasTextContent = false;

    for (const token of tokens) {
      if (token === '{cover}') {
        currentLineSegments.push(...mediaMap[token]);
      } else if (token === '{mainbody}') {
        const parsed = parseHtmlToSegments(mediaMainbody || '');
        currentLineSegments.push(...parsed);
        hasTextContent = parsed.some(seg => seg.type === 'text');
      } else if (token === '{video}') {
        // 超限时替换为提示文本；否则留空（由转发节点处理）
        if (videoExceedsLimit) {
          const tip = config.Max_size_tip;
          currentLineSegments.push({type: 'text', data: {text: tip}});
          hasTextContent = true;
        }
        // 否则不插入内容（视频将作为独立节点）
      } else if (token.trim() !== '') {
        currentLineSegments.push({type: 'text', data: {text: token}});
        hasTextContent = true;
      }
    }

    if (currentLineSegments.length > 0) {
      nonVideoSegments.push(...currentLineSegments);
    }
    if (!isLastLine && hasTextContent) {
      nonVideoSegments.push({type: 'text', data: {text: '\n'}});
    }
  }

  const forwardNodes: any[] = [];

  if (nonVideoSegments.length > 0) {
    forwardNodes.push({
      type: 'node',
      data: {
        user_id: session.selfId,
        nickname: '分享助手',
        content: nonVideoSegments
      }
    });
  }

  let videoElement: string | undefined;
  if (hasVideoInTemplate && result.videoUrl && !videoExceedsLimit && mediaVideoUrl) {
    if (!mixed_sending) {
      forwardNodes.push({
        type: 'node',
        data: {
          user_id: session.selfId,
          nickname: '分享助手',
          content: [{type: 'video', data: {file: mediaVideoUrl}}]
        }
      });
    } else {
      videoElement = h.video(mediaVideoUrl).toString();
    }
    if (config.logLevel === 'link_only') {
      logger.info(`视频直链 (${result.platform}): ${result.videoUrl}`);
    }
  }

  if (forwardNodes.length === 0) return;

  if (config.logLevel === 'full') {
    logger.info(`解析结果: \n ${JSON.stringify(result, null, 2)}`);
  }

  if (!(session.onebot && session.onebot._request)) throw new Error("Onebot is not defined");
  const promises = [];
  promises.push(session.onebot._request('send_group_forward_msg', {
    group_id: session.guildId,
    messages: forwardNodes,
    news: [{text: mediaMainbody || '-'}, {text: '点击查看详情 | Powered by furryaxw'}],
    prompt: result.title || '',
    summary: '分享解析',
    source: result.title || ''
  }));
  if (mixed_sending && videoElement) {
    promises.push(session.send(videoElement));
  }
  await Promise.all(promises);
}
