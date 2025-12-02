// src/index.ts

import {Context, Schema, h, Logger, Session} from 'koishi';
import {resolveLinks, processLink, init, parsers_str} from './core';
import {ParsedInfo, PluginConfig} from './types';
import {} from 'koishi-plugin-adapter-onebot'
import {getEffectiveSettings, isUserAdmin, sendResult_forward, sendResult_plain} from './utils';

export const name = 'share-links-analysis';
export const inject = {
  required: ['BiliBiliVideo', 'database', 'puppeteer'],
  optional: [],
};

export const usage = `
开启插件后，即可自动解析分享链接。
向Bot发送B站、小红书等支持平台的分享链接，会返回图文信息与视频。
您可以在插件配置中为不同平台分别设置返回的图文消息格式。
此插件只测试过在Napcat下的兼容性情况，不保证其他平台可用。
`;

// 配置文件
export const Config: Schema<PluginConfig> = Schema.intersect([
  Schema.object({
    Video_ClarityPriority: Schema.union([
      Schema.const('1').description('低清晰度优先'),
      Schema.const('2').description('高清晰度优先'),
    ]).role('radio').default('1').description("发送的视频清晰度优先策略"),
    Max_size: Schema.number().default(20).description("允许发送的最大文件大小（Mb）"),
    Min_Interval: Schema.number().default(600).description("若干秒内不再处理相同链接，防止刷屏").min(1),
    waitTip_Switch: Schema.union([
      Schema.const(false).description('不返回文字提示'),
      Schema.string().description('返回文字提示'),
    ]).description("是否返回等待提示。开启后，会发送`等待提示语`").default(false),
    useForward: Schema.union([
      Schema.const("plain").description("普通发送"),
      Schema.const("forward").description("合并转发"),
      Schema.const("mixed").description("混合发送"),
    ]).default("forward").description("发送模式"),
    usingLocal: Schema.boolean().default(false).description("使用本地文件（关闭后代理设置无效）"),
    sendFiles: Schema.boolean().default(true).description("是否发送文件（视频等）"),
    sendLinks: Schema.boolean().default(false).description("是否附加直链（仅对合并发送有效）"),
  }).description("基础设置"),

  Schema.object({
    format: Schema.string().role('textarea').default(
      `{title}
{cover}
作者：{authorName}
{stats}
----------
{mainbody}
----------
{sourceUrl}`
    ).description('图文/视频输出格式。<br/>可用占位符: `{title}`, `{cover}`, `{authorName}`, `{mainbody}`, `{stats}`, `{sourceUrl}`'),
  }).description("格式化模板"),

  Schema.object({
    parseLimit: Schema.number().default(3).description("单对话多链接解析上限"),
    useNumeral: Schema.boolean().default(true).description("使用格式化数字 (如 10000 -> 1万)"),
    showError: Schema.boolean().default(false).description("当链接不正确时提醒发送者"),
  }).description("高级解析设置"),

  Schema.object({
    proxy: Schema.string().description("代理设置"),
    proxy_settings: Schema.object(
      Object.fromEntries(
        parsers_str.map(parser => [parser, Schema.boolean().default(false).description(`对${parser}使用代理`)])
      )
    ),
  }).description("代理设置"),

  Schema.object({
    default_parsers: Schema.object(
      Object.fromEntries(
        parsers_str.map(parser => [parser, Schema.boolean().default(true).description(`启用${parser}解析器`)])
      )
    ),
    allow_sensitive: Schema.boolean().default(false).description("允许NSFW内容"),
  }).description("默认解析器设置"),

  Schema.object({
    onebotReadDir: Schema.string().description('OneBot 实现 (如 NapCat) 所在的容器或环境提供的路径前缀。').default("/app/.config/QQ/NapCat/temp"),
    localDownloadDir: Schema.string().description('与上述路径对应的、Koishi 所在的容器或主机可以访问的路径前缀。').default("/koishi/data/temp"),
  }).description('跨环境路径映射设置'),

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
  // @ts-ignore
  ctx.model.extend('sla_cookie_cache', {
    platform: 'string', // 平台名称，如 'xiaohongshu'
    cookie: 'text',   // 存储的 cookie 字符串
  }, {
    primary: 'platform' // 使用平台名称作为主键
  });

  // @ts-ignore
  ctx.model.extend('sla_group_settings', {
    guildId: 'string',
    custom_parsers: 'json',
    nsfw_enabled: 'boolean',
  }, {
    primary: 'guildId',
  });

  // 注册指令
  const cmd = ctx.command('share', '分享解析插件配置', {authority: 1})
    .action(async ({session}) => {
      if (!session?.guildId || !session?.userId) return '该指令只能在群组中使用。';
      const {parsers, nsfw} = await getEffectiveSettings(ctx, session.guildId, config);
      const parserList = Object.entries(parsers)
        .map(([name, enabled]) => `${enabled ? '✅' : '❌'} ${name}`)
        .join('\n');
      return `当前解析器状态：\n${parserList}\nNSFW 内容：${nsfw ? '✅' : '❌'}`.trim();
    });

  cmd.subcommand('.parsers [parser:string] [mode:string]', '查看/管理当前群的解析器状态', {authority: 1})
    .action(async ({session}, parser, value) => {
      if (!session?.guildId || !session?.userId) return '该指令只能在群组中使用。';
      if (!await isUserAdmin(session, session.userId)) return '权限不足'
      if (parser) {
        type ParserName = typeof parsers_str[number];
        const isValidParser = (name: string): name is ParserName =>
          (parsers_str as readonly string[]).includes(name);

        if (!isValidParser(parser)) return '请输入正确的解析器名称';
        if (!value) return '请输入正确的模式';
        const mode = value.trim().toLowerCase() === 'true'

        // @ts-ignore
        const data = await ctx.database.get('sla_group_settings', session.guildId);
        // @ts-ignore
        const final_parsers = {...data[0]?.custom_parsers, ...{[parser]: mode}};
        const record = {guildId: session.guildId, custom_parsers: final_parsers};
        // @ts-ignore
        await ctx.database.upsert('sla_group_settings', [record]);
      }
      await session.execute('share');
    });

  cmd.subcommand('.nsfw [value:string]', '设置是否允许 NSFW 内容', {authority: 1})
    .action(async ({session}, value) => {
      if (!session?.guildId || !session?.userId) return '该指令只能在群组中使用。';
      if (!await isUserAdmin(session, session.userId)) return '权限不足'
      if (value) {
        const mode = value.trim().toLowerCase() === 'true'
        const record = {guildId: session.guildId, nsfw_enabled: mode};
        // @ts-ignore
        await ctx.database.upsert('sla_group_settings', [record]);
      }
      await session.execute('share');
    });

  cmd.subcommand('.reset', '重置为全局默认设置', {authority: 1})
    .action(async ({session}) => {
      if (!session?.guildId || !session?.userId) return '该指令只能在群组中使用。';
      if (!await isUserAdmin(session, session.userId)) return '权限不足'
      // @ts-ignore
      await ctx.database.remove('sla_group_settings', {guildId: session.guildId});
      return '已重置为全局默认设置。';
    });

  const logger = ctx.logger('share-links-analysis');
  const lastProcessedUrls: Record<string, Record<string, number>> = {};

  ctx.on('ready', async () => {
    logger.info('插件已启动，执行插件初始化');
    await init(ctx, config);
  });

  ctx.middleware(async (session, next) => {
    if (!session.content || !session.channelId) return next();

    const content = session.content.replace(/\\/g, '').replace(/&amp;/g, '&');
    const channelId = session.channelId;
    const links = resolveLinks(content);

    if (links.length === 0) return next();

    let linkCount = 0;
    for (const link of links) {
      if (session.guildId) {
        const settings = await getEffectiveSettings(ctx, session.guildId, config)
        if (!settings.parsers[link.platform]) continue;
      } else {
        if (!config.default_parsers[link.platform as keyof typeof config.default_parsers]) continue;
      }

      if (linkCount >= config.parseLimit) {
        await session.send("已达到单次解析上限…");
        break;
      }

      const now = Date.now();
      if (!lastProcessedUrls[channelId]) lastProcessedUrls[channelId] = {};
      if (now - (lastProcessedUrls[channelId][link.url] || 0) < config.Min_Interval * 1000) {
        if (config.logLevel === 'full') logger.info(`链接 ${link.url} 在冷却时间内，跳过处理。`);
        continue;
      }

      if (config.waitTip_Switch) {
        await session.send(config.waitTip_Switch);
      }

      const result = await processLink(ctx, config, link, session);

      if (result) {
        lastProcessedUrls[channelId][link.url] = now;
        await sendResult(session, config, result, logger);
      }
      linkCount++;
    }
  });
}

async function sendResult(session: Session, config: PluginConfig, result: ParsedInfo, logger: Logger) {
  if (!session.channel) {
    await sendResult_plain(session, config, result, logger);
    return;
  }
  switch (config.useForward) {
    case "plain":
      await sendResult_plain(session, config, result, logger);
      return;
    case 'forward':
      await sendResult_forward(session, config, result, logger, false);
      return;
    case "mixed":
      await sendResult_forward(session, config, result, logger, true);
      return;
  }
}
