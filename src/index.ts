// src/index.ts

import { Context, Schema, h, Logger, Session } from 'koishi';
import { resolveLinks, processLink } from './core';
import { ParsedInfo, PluginConfig } from './types';

export const name = 'share-links-analysis';
export const inject = {
  required: ['BiliBiliVideo'],
  optional: ['puppeteer'],
};

export const usage = `
开启插件后，即可自动解析分享链接。
向Bot发送B站、小红书等支持平台的分享链接，会返回图文信息与视频。
您可以在插件配置中为不同平台分别设置返回的图文消息格式。
`;

// 配置文件
export const Config: Schema<PluginConfig> = Schema.intersect([
  Schema.object({
    Video_ClarityPriority: Schema.union([
      Schema.const('1').description('低清晰度优先'),
      Schema.const('2').description('高清晰度优先'),
    ]).role('radio').default('1').description("发送的视频清晰度优先策略"),
    Maximumduration: Schema.number().default(25).description("允许解析的视频最大时长（分钟）").min(1),
    Maximumduration_tip: Schema.string().default('视频太长啦！还是去平台官网看吧~').description("对过长视频的文字提示内容"),
    MinimumTimeInterval: Schema.number().default(180).description("若干秒内不再处理相同链接，防止刷屏").min(1),
    waitTip_Switch: Schema.union([
      Schema.const(false).description('不返回文字提示'),
      Schema.string().description('返回文字提示'),
    ]).description("是否返回等待提示。开启后，会发送`等待提示语`").default(false),
  }).description("基础设置"),

  Schema.object({
    format: Schema.string().role('textarea').default(
`{title}
{cover}
作者：{authorName}
简介：{description}
{stats}
{images}
{video}`
    ).description('统一主输出格式。<br/>可用占位符: `{title}`, `{cover}`, `{authorName}`, `{description}`, `{stats}`, `{sourceUrl}`, `{images}`, `{video}`, `{videoUrl}`'),
  }).description("格式化模板"),

  Schema.object({
    bilibiliStatsFormat: Schema.string().role('textarea').default('播放: {播放} | 弹幕: {弹幕} | 点赞: {点赞} | 硬币: {硬币} | 收藏: {收藏}')
        .description('Bilibili 链接的数据统计格式。<br/>可用占位符: `{播放}`, `{弹幕}`, `{点赞}`, `{硬币}`, `{收藏}`'),
    xiaohongshuStatsFormat: Schema.string().role('textarea').default('点赞: {点赞} | 收藏: {收藏} | 评论: {评论}')
        .description('小红书链接的数据统计格式。<br/>可用占位符: `{点赞}`, `{收藏}`, `{评论}`'),
  }).description("数据格式化"),

  Schema.object({
    parseLimit: Schema.number().default(3).description("单对话多链接解析上限"),
    useNumeral: Schema.boolean().default(true).description("使用格式化数字 (如 10000 -> 1万)"),
    showError: Schema.boolean().default(false).description("当链接不正确时提醒发送者"),
    bVideoIDPreference: Schema.union([
      Schema.const("bv").description("BV 号"),
      Schema.const("av").description("AV 号"),
    ]).default("bv").description("B站ID 偏好"),
  }).description("高级解析设置"),

  Schema.object({
    userAgent: Schema.string().description("所有 API 请求所用的 User-Agent").default("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
    logLevel: Schema.union([
        Schema.const('none').description('不记录'),
        Schema.const('link_only').description('仅记录视频直链'),
        Schema.const('full').description('记录完整调试信息'),
    ]).role('radio').default('none').description("选择后台日志记录等级"),
  }).description("调试设置"),
]) as any;

export function apply(ctx: Context, config: PluginConfig) {
  const logger = ctx.logger('share-links-analysis');
  const lastProcessedUrls: Record<string, Record<string, number>> = {};

  ctx.middleware(async (session, next) => {
    if (!session.content || !session.channelId) return next();

    const content = session.content.replace(/\\/g, '');
    const channelId = session.channelId;
    const links = resolveLinks(content);

    if (links.length === 0) return next();

    let linkCount = 0;
    for (const link of links) {
      if (linkCount >= config.parseLimit) {
        await session.send("已达到单次解析上限…");
        break;
      }

      const now = Date.now();
      if (!lastProcessedUrls[channelId]) lastProcessedUrls[channelId] = {};
      if (now - (lastProcessedUrls[channelId][link.url] || 0) < config.MinimumTimeInterval * 1000) {
        if(config.logLevel === 'full') logger.info(`链接 ${link.url} 在冷却时间内，跳过处理。`);
        continue;
      }

      if (config.waitTip_Switch) {
        await session.send(config.waitTip_Switch);
      }

      const result = await processLink(ctx, config, link);

      if (result) {
        lastProcessedUrls[channelId][link.url] = now;
        await sendResult(session, config, result, logger);
      } else if (config.showError) {
        await session.send(`无法解析链接：${link.url}。可能是不支持的类型或链接有误。`);
      }
      linkCount++;
    }
  });
}


async function sendResult(session: Session, config: PluginConfig, result: ParsedInfo, logger: Logger) {
  let message = config.format;

  message = message.replace(/{title}/g, result.title || '');
  message = message.replace(/{authorName}/g, result.authorName || '');
  message = message.replace(/{description}/g, result.description ? result.description : '');
  message = message.replace(/{sourceUrl}/g, result.sourceUrl || '');
  message = message.replace(/{cover}/g, result.coverUrl ? h.image(result.coverUrl).toString() : '');

  const imagesText = result.images ? result.images.map(img => h.image(img).toString()).join('\n') : '';
  message = message.replace(/{images}/g, imagesText);

  message = message.replace(/{stats}/g, result.stats || '');

  // 【修复】只要 videoUrl 存在就处理，仅当 duration 明确超长时才替换为提示
  if (result.videoUrl) {
    // 仅当 duration 是有效数字且超长时，才显示提示
    if (typeof result.duration === 'number' && result.duration > config.Maximumduration * 60) {
      const tip = config.Maximumduration_tip || '';
      message = message.replace(/{video}/g, tip);
      message = message.replace(/{videoUrl}/g, '');
    } else {
      // 正常发送视频和链接
      message = message.replace(/{video}/g, h.video(result.videoUrl).toString());
      message = message.replace(/{videoUrl}/g, result.videoUrl);
      if (config.logLevel === 'link_only' || config.logLevel === 'full') {
        logger.info(`视频直链 (${result.platform}): ${result.videoUrl}`);
      }
    }
  } else {
    // 没有视频则移除占位符
    message = message.replace(/{video}/g, '');
    message = message.replace(/{videoUrl}/g, '');
  }

  const cleanMessage = message.split('\n').filter(line => line.trim() !== '' || line.includes('<')).join('\n');

  if (cleanMessage) {
    await session.send(h.quote(session.messageId) + cleanMessage);
  }

  if (config.logLevel === 'full') {
    logger.info(`解析结果: \n ${JSON.stringify(result, null, 2)}`);
  }
}
