import { Context, Schema, h, Logger, Session } from 'koishi';
import { resolveLinks, processLink } from './core';
import { ProcessedLink, PluginConfig } from './types';

// 这是插件的元数据
export const name = 'share-links-analysis';
export const inject = {
  required: ['BiliBiliVideo'],
  optional: ['puppeteer'], // 【修改】将 puppeteer 作为可选依赖注入
};

export const usage = `
开启插件后，即可自动解析分享链接
向Bot发送B站、小红书等支持平台的分享链接，会返回图文信息与视频。

B站短链接(b23.tv)解析需要 puppeteer 服务支持，请确保已安装并启用该插件。
`;

export const Config: Schema<PluginConfig> = Schema.intersect([
  Schema.object({
    linktextParsing: Schema.boolean().default(true).description("是否返回图文数据。`开启后，才发送视频数据的图文解析。`"),
    VideoParsing_ToLink: Schema.union([
      Schema.const('1').description('不返回视频/视频直链'),
      Schema.const('2').description('仅返回视频'),
      Schema.const('3').description('仅返回视频直链'),
      Schema.const('4').description('返回视频和视频直链'),
      Schema.const('5').description('返回视频，仅在日志记录视频直链'),
    ]).role('radio').default('2').description("是否返回` 视频/视频直链 `"),
    Video_ClarityPriority: Schema.union([
      Schema.const('1').description('低清晰度优先（低清晰度的视频发得快一点）'),
      Schema.const('2').description('高清晰度优先（建议在B站观看高画质视频）'),
    ]).role('radio').default('1').description("发送的视频清晰度优先策略"),
    Maximumduration: Schema.number().default(25).description("允许解析的视频最大时长（分钟）`超过这个时长就不会发送视频`").min(1),
    Maximumduration_tip: Schema.union([
      Schema.const('不返回文字提示').description('不返回文字提示'),
      Schema.string().description('返回文字提示（请在右侧填写文字内容）').default('视频太长啦！还是去B站看吧~'),
    ]).description("对过长视频的文字提示内容").default('视频太长啦！还是去B站看吧~'),
    MinimumTimeInterval: Schema.number().default(180).description("若干`秒`内不再处理相同链接 `防止多bot互相触发导致的刷屏/性能浪费`").min(1),
    waitTip_Switch: Schema.union([
      Schema.const(false).description('不返回文字提示'),
      Schema.string().description('返回文字提示（请在右侧填写文字内容）'),
    ]).description("是否返回等待提示。开启后，会发送`等待提示语`").default(false),
  }).description("基础设置"),

  Schema.object({
    BVnumberParsing: Schema.boolean().default(true).description("是否允许根据`独立的BV号`解析视频 `开启后，可以通过视频的BV号解析视频。`"),
    parseLimit: Schema.number().default(3).description("单对话多链接解析上限").hidden(),
    useNumeral: Schema.boolean().default(true).description("使用格式化数字 (如 10000 -> 1万)").hidden(),
    showError: Schema.boolean().default(false).description("当链接不正确时提醒发送者").hidden(),
    bVideoIDPreference: Schema.union([
      Schema.const("bv").description("BV 号"),
      Schema.const("av").description("AV 号"),
    ]).default("bv").description("B站ID 偏好").hidden(),
    bVideoImage: Schema.boolean().default(true).description("显示封面"),
    bVideoOwner: Schema.boolean().default(true).description("显示 UP 主"),
    bVideoDesc: Schema.boolean().default(false).description("显示简介`有的简介真的很长`"),
    bVideoStat: Schema.boolean().default(true).description("显示状态（*三连数据*）"),
    bVideoExtraStat: Schema.boolean().default(true).description("显示额外状态（*弹幕&观看*）"),
    bVideoShowLink: Schema.boolean().default(false).description("显示视频链接`开启可能会导致其他bot循环解析`"),
  }).description("B站内容解析设置"),

  Schema.object({
    xhsCover: Schema.boolean().default(true).description("显示首图/封面"),
    xhsAuthor: Schema.boolean().default(true).description("显示作者"),
    xhsDesc: Schema.boolean().default(true).description("显示简介"),
    xhsStat: Schema.boolean().default(true).description("显示状态（*点赞、收藏、评论*）"),
  }).description("小红书内容解析设置"),

  Schema.object({
    userAgent: Schema.string().description("所有 API 请求所用的 User-Agent").default("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
    loggerinfo: Schema.boolean().default(false).description("日志调试输出 `日常使用无需开启`"),
  }).description("调试设置"),
]) as any;

// 主插件逻辑
export function apply(ctx: Context, config: PluginConfig) {
  const logger = ctx.logger('share-links-analysis');
  const lastProcessedUrls: Record<string, Record<string, number>> = {};

  ctx.middleware(async (session, next) => {
    if (!session.content || !session.channelId) {
      return next();
    }

    let content = session.content;
    content = content.replace(/\\/g, '');
    const channelId = session.channelId;

    if (config.BVnumberParsing) {
      const bvPattern = /(?:^|\s)(BV[1-9A-HJ-NP-Za-km-z]{10})(?:\s|$)/g;
      const bvMatches = content.match(bvPattern);
      if (bvMatches) {
        const urls = bvMatches.map(bv => `https://www.bilibili.com/video/${bv.trim()}`);
        content += '\n' + urls.join('\n');
      }
    }

    const links = resolveLinks(content);
    if (links.length === 0) return next();

    let linkCount = 0;
    for (const link of links) {
      if (linkCount >= config.parseLimit) {
        await session.send("已达到单次解析上限…");
        break;
      }

      const now = Date.now();
      if (!lastProcessedUrls[channelId]) {
        lastProcessedUrls[channelId] = {};
      }
      if (now - (lastProcessedUrls[channelId][link.url] || 0) < config.MinimumTimeInterval * 1000) {
        if(config.loggerinfo) logger.info(`链接 ${link.url} 在冷却时间内，跳过处理。`);
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

    return next();
  });
}

async function sendResult(session: Session, config: PluginConfig, result: ProcessedLink, logger: Logger) {
  if (config.linktextParsing && result.text) {
    let message = result.text;
    if (!config.bVideoShowLink && result.sourceUrl) {
      message = message.replace(new RegExp(result.sourceUrl + '\\n?$'), '');
    }
    await session.send(h.quote(session.messageId) + message);
  }

  if (result.videoUrl && result.duration) {
    if (result.duration > config.Maximumduration * 60) {
      if (config.Maximumduration_tip && config.Maximumduration_tip !== '不返回文字提示') {
        await session.send(config.Maximumduration_tip);
      }
      return;
    }
  }

  if (result.videoUrl && config.VideoParsing_ToLink !== '1') {
    switch (config.VideoParsing_ToLink) {
      case '2':
        await session.send(h.video(result.videoUrl));
        break;
      case '3':
        await session.send(h.text(result.videoUrl));
        break;
      case '4':
        await session.send(h.text(result.videoUrl));
        await session.send(h.video(result.videoUrl));
        break;
      case '5':
        logger.info(`视频直链: ${result.videoUrl}`);
        await session.send(h.video(result.videoUrl));
        break;
    }
  }

  if (config.loggerinfo) {
    logger.info(`解析结果: \n ${JSON.stringify(result, null, 2)}`);
  }
}
