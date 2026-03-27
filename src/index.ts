// src/index.ts

import {Context, Schema} from 'koishi';
import {init, parsers, parsers_str, processLink, resolveLinks} from './core';
import {ParsedInfo, PluginConfig} from './types';
import {getEffectiveSettings, isUserAdmin, sendResult, syncCookiesFromCloud} from './utils';
import * as fs from 'node:fs';

export const name = 'share-links-analysis';
export const inject = {
    required: ['database', 'puppeteer'],
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
        sendVoice: Schema.boolean().default(true).description('是否发送额外的语音（音乐解析）'),
        sendVoiceOutside: Schema.boolean().default(true).description('是否将额外的语音单独发送（仅合并转发模式生效）'),
        sendLinks: Schema.boolean().default(false).description("是否附加直链（仅对合并发送有效）"),
    }).description("基础设置"),

    Schema.object({
        enableCache: Schema.boolean().default(true).description("开启缓存（包括解析结果缓存和资源文件缓存）"),
        cacheExpiration: Schema.number().default(24).description("L1 缓存过期时间（小时）。设为 0 则不过期。"),
        optimisticCache: Schema.boolean().default(true).description("开启乐观缓存"),
        optimisticExpiration: Schema.number().default(240).description("乐观缓存最大保留时间（小时）。设为 0 则不过期。"),
        autoCleanInterval: Schema.number().default(1).description("自动清理过期缓存的检查间隔（小时）。"),
    }).description("缓存设置"),

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
        showError: Schema.boolean().default(false).description("当链接被阻止时提醒发送者"),
    }).description("高级解析设置"),

    Schema.object({
        cookieCloud: Schema.object({
            enable: Schema.boolean().default(false).description('启用 CookieCloud 同步 (优先使用云端 Cookie)'),
            host: Schema.string().role('link').description('服务器地址 (如 http://cookie.example.com)'),
            uuid: Schema.string().role('secret').description('用户 UUID'),
            password: Schema.string().role('secret').description('端对端加密密码'),
        })
    }).description('CookieCloud 设置'),

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
        youtube_ApiUrl: Schema.string().role('link').description(
            '外挂 Python 解析服务的 API 地址，需要专用解析服务<br>' +
            '<a href="https://github.com/furryaxw/share-links-analysis/blob/Master/README.md" target="_blank">点击此处查看部署方式</a>'
        ).default('http://127.0.0.1:12001'),
    }).description('YouTube 解析设置'),

    Schema.object({
        netease_apiUrl: Schema.string().role('link').description(
            '网易云音乐 API (NeteaseCloudMusicApi) 的地址<br>' +
            '<a href="https://docs-neteasecloudmusicapi.focalors.ltd/#/?id=neteasecloudmusicapienhanced" target="_blank">点击此处查看部署方式</a>'
        ).default('http://127.0.0.1:3000'),
    }).description('网易云音乐设置'),

    Schema.object({
        onebotReadDir: Schema.string().description('OneBot 实现 (如 NapCat) 所在的容器或环境提供的路径前缀。').default("/app/.config/QQ/NapCat/temp"),
        localDownloadDir: Schema.string().description('与上述路径对应的、Koishi 所在的容器或主机可以访问的路径前缀。').default("/koishi/data/temp"),
    }).description('跨环境路径映射设置'),

    Schema.object({
        userAgent: Schema.string().description("所有 API 请求所用的 User-Agent").default("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
        debug: Schema.boolean().default(false).description("开启调试模式 (输出详细日志)"),
    }).description("调试设置"),

    Schema.object({
        reportEnabled: Schema.boolean().default(false).description("开启性能数据上报"),
        reportUrl: Schema.string().default("http://127.0.0.1:8080/").description("性能数据上报地址 (HTTP POST)"),
    }).description("性能监控"),
]) as any;

async function reportMetric(ctx: Context, config: PluginConfig, payload: Record<string, any>) {
    if (!config.reportEnabled || !config.reportUrl) return;

    const data = {
        app: "share_links_analysis", // 必填 app 标识
        timestamp: Math.floor(Date.now() / 1000), // 可选时间戳
        ...payload
    };

    // 异步发送，不阻塞主流程
    ctx.http.post(config.reportUrl, data).catch(e => {
        // 仅在调试模式下打印上报错误，避免刷屏
        if (config.debug) {
            ctx.logger('share-links-analysis').warn(`性能数据上报失败: ${e.message}`);
        }
    });
}

export function apply(ctx: Context, config: PluginConfig) {
    // 数据库模型定义
    ctx.model.extend('sla_cookie_cache', {
        platform: 'string', // 平台名称，如 'xiaohongshu'
        cookie: 'text',   // 存储的 cookie 字符串
    }, {
        primary: 'platform' // 使用平台名称作为主键
    });

    ctx.model.extend('sla_group_settings', {
        guildId: 'string',
        custom_parsers: 'json',
        nsfw_enabled: 'boolean',
    }, {
        primary: 'guildId',
    });

    // 解析结果缓存
    ctx.model.extend('sla_parse_cache', {
        key: 'string', // platform + ':' + id
        data: 'json',
        created_at: 'double',
    }, {primary: 'key'});

    // 资源文件缓存 (hash)
    ctx.model.extend('sla_file_cache', {
        hash: 'string', // URL MD5
        path: 'string', // 本地绝对路径
        url: 'string',
        created_at: 'double',
    }, {primary: 'hash'});

    const logger = ctx.logger('share-links-analysis');
    // 根据配置设置日志等级
    if (config.debug) {
        logger.level = 3; // Debug Level
    }

    const pendingChecks = new Map<string, Promise<ParsedInfo | null>>();

    // 清理缓存函数
    const cleanExpiredCache = async () => {
        if (!config.enableCache) return;
        const now = Date.now();

        let maxExpiration = 0;

        if (config.optimisticCache) {
            // 如果开启了乐观缓存，且 L1 或 L2 中有任何一个设为 0（永不过期），则直接跳过定时清理
            if (config.cacheExpiration === 0 || config.optimisticExpiration === 0) {
                return;
            }
            // 只有两者都不为 0 时，才取它们的最大值作为物理清理时间
            maxExpiration = Math.max(config.cacheExpiration, config.optimisticExpiration);
        } else {
            // 如果没开启乐观缓存，且 L1 设为 0（永不过期），直接跳过
            if (config.cacheExpiration === 0) {
                return;
            }
            maxExpiration = config.cacheExpiration;
        }

        const threshold = now - maxExpiration * 60 * 60 * 1000;

        // 清理解析缓存
        await ctx.database.remove('sla_parse_cache', {
            created_at: {$lt: threshold}
        });

        // 清理文件缓存
        const expiredFiles = await ctx.database.get('sla_file_cache', {
            created_at: {$lt: threshold}
        });

        for (const file of expiredFiles) {
            try {
                if (fs.existsSync(file.path)) {
                    await fs.promises.unlink(file.path);
                }
            } catch (e) {
                logger.warn(`删除过期文件失败 ${file.path}: ${e}`);
            }
        }

        await ctx.database.remove('sla_file_cache', {
            created_at: {$lt: threshold}
        });

        if (expiredFiles.length > 0) {
            logger.info(`已自动清理 ${expiredFiles.length} 个过期文件。`);
        }
    };

    // 设置定时清理
    if (config.enableCache && config.autoCleanInterval > 0) {
        ctx.setInterval(cleanExpiredCache, config.autoCleanInterval * 60 * 60 * 1000);
    }

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
            type ParserName = typeof parsers_str[number];
            const isValidParser = (name: string): name is ParserName =>
                (parsers_str as readonly string[]).includes(name);

            if (!isValidParser(parser)) return '请输入正确的解析器名称';
            if (!value) return '请输入正确的模式';
            const mode = value.trim().toLowerCase() === 'true'

            const data = await ctx.database.get('sla_group_settings', session.guildId);
            const final_parsers = {...data[0]?.custom_parsers, ...{[parser]: mode}};
            const record = {guildId: session.guildId, custom_parsers: final_parsers};
            await ctx.database.upsert('sla_group_settings', [record]);
        });

    cmd.subcommand('.nsfw [value:string]', '设置是否允许 NSFW 内容', {authority: 1})
        .action(async ({session}, value) => {
            if (!session?.guildId || !session?.userId) return '该指令只能在群组中使用。';
            if (!await isUserAdmin(session, session.userId)) return '权限不足'
            const mode = value.trim().toLowerCase() === 'true'
            const record = {guildId: session.guildId, nsfw_enabled: mode};
            await ctx.database.upsert('sla_group_settings', [record]);
            await session.execute('share');
        });

    cmd.subcommand('.reset', '重置为全局默认设置', {authority: 1})
        .action(async ({session}) => {
            if (!session?.guildId || !session?.userId) return '该指令只能在群组中使用。';
            if (!await isUserAdmin(session, session.userId)) return '权限不足'
            await ctx.database.remove('sla_group_settings', {guildId: session.guildId});
            return '已重置为全局默认设置。';
        });

    // 清除缓存指令
    cmd.subcommand('.clean', '清除所有缓存和文件', {authority: 3})
        .action(async () => {
            await ctx.database.remove('sla_parse_cache', {});

            const allFiles = await ctx.database.get('sla_file_cache', {});
            for (const file of allFiles) {
                try {
                    if (fs.existsSync(file.path)) {
                        await fs.promises.unlink(file.path);
                    }
                } catch {
                }
            }
            await ctx.database.remove('sla_file_cache', {});
            return '缓存及对应文件已清理。';
        });

    cmd.subcommand('.refresh', '强制刷新所有 Cookie', {authority: 3})
        .action(async ({session}) => {
            await session?.send('🔄 开始执行 Cookie 全量刷新流程...');
            let msg = '';

            // 用于记录本次刷新覆盖了哪些平台，避免重复采集
            const refreshedPlatforms = new Set<string>();

            // ------------------------------------------------------
            // 1. 优先尝试云端同步 (CookieCloud)
            // ------------------------------------------------------
            if (config.cookieCloud?.enable) {
                try {
                    // syncCookiesFromCloud 内部已经完成了：获取 -> 比较 -> 存库
                    // 并返回成功获取到的 { platform: cookie }
                    const cloudCookies = await syncCookiesFromCloud(ctx, config);
                    const cloudCount = Object.keys(cloudCookies).length;

                    Object.keys(cloudCookies).forEach(p => refreshedPlatforms.add(p));

                    msg += `☁️ CookieCloud: 同步了 ${cloudCount} 个平台 [${Object.keys(cloudCookies).join(', ')}]\n`;
                } catch (e: any) {
                    msg += `❌ CookieCloud: 同步失败 - ${e.message}\n`;
                }
            } else {
                msg += `⏹ CookieCloud: 未启用\n`;
            }

            // ------------------------------------------------------
            // 2. 本地回退采集 (Local Fallback)
            // 只有当 Cloud 没有获取到某个平台的数据时，才触发本地采集
            // ------------------------------------------------------

            // 筛选出云端没覆盖到的，且支持本地采集的 parser
            const pendingParsers = parsers.filter(p =>
                !refreshedPlatforms.has(p.name) &&
                typeof p.lc_get_cookie === 'function'
            );

            if (pendingParsers.length > 0) {
                msg += `🔍 开始本地采集缺失的平台: [${pendingParsers.map(p => p.name).join(', ')}]\n`;

                // 并行执行本地采集
                const results = await Promise.all(pendingParsers.map(async (parser) => {
                    try {
                        // @ts-ignore (如果你没定义接口)
                        const cookie = await parser.lc_get_cookie(ctx, config);

                        if (cookie) {
                            // 本地采集成功，需要手动写入数据库
                            // 先检查一下是否真的变了（可选，upsert 也可以）
                            await ctx.database.upsert('sla_cookie_cache', [{
                                platform: parser.name,
                                cookie: cookie
                            }]);
                            return {name: parser.name, success: true};
                        }
                        // 获取为空，不做任何操作（保留数据库旧值）
                        return {name: parser.name, success: false, reason: 'Empty'};
                    } catch (e: any) {
                        return {name: parser.name, success: false, reason: e.message};
                    }
                }));

                // 汇总结果
                results.forEach(res => {
                    if (res.success) {
                        msg += `✅ 本地采集 [${res.name}]: 成功更新\n`;
                    } else {
                        // 只有报错或者显式失败才提示，如果是本来就没有则不打扰
                        if (res.reason !== 'Empty') {
                            msg += `❌ 本地采集 [${res.name}]: 失败 (${res.reason})\n`;
                        } else {
                            msg += `⚠️ 本地采集 [${res.name}]: 未获取到有效 Cookie (保持原状)\n`;
                        }
                    }
                });
            } else {
                msg += `✨ 所有支持的平台均已通过云端同步，无需本地采集。\n`;
            }

            return msg;
        });

    const lastProcessedUrls: Record<string, Record<string, number>> = {};

    ctx.on('ready', async () => {
        logger.info('插件启动，开始初始化检查...');

        // 1. 全局初始化
        await init(ctx, config);

        // 2. 尝试从 CookieCloud 同步
        // 获取云端数据 map，用于判断哪些平台已经就绪
        let cloudResult: Record<string, string> = {};
        if (config.cookieCloud?.enable) {
            logger.info('正在检查 CookieCloud...');
            cloudResult = await syncCookiesFromCloud(ctx, config);
        }

        // 3. 检查缺失的平台，触发本地采集
        // 逻辑：遍历所有 Parser，如果 Cloud 没返回它的 Cookie，并且它有 lc_get_cookie 方法，则尝试本地获取
        const localTasks = parsers.map(async (parser) => {
            // 如果云端已经成功拿到了，就跳过本地采集
            if (cloudResult[parser.name]) {
                return;
            }

            // 检查该 parser 是否支持获取 cookie
            if (typeof parser.lc_get_cookie === 'function') {
                try {
                    // 尝试本地获取
                    const localCookie = await parser.lc_get_cookie(ctx, config);

                    if (localCookie) {
                        // 获取成功，写入数据库
                        // 注意：这里我们做一个简单的 diff，如果数据库里已经有了且一样，就不写了（虽然 upsert 也不耗费啥资源）
                        const dbRecords = await ctx.database.get('sla_cookie_cache', {platform: parser.name});
                        if (dbRecords?.[0]?.cookie !== localCookie) {
                            await ctx.database.upsert('sla_cookie_cache', [{
                                platform: parser.name,
                                cookie: localCookie
                            }]);
                            logger.info(`[${parser.name}] 本地采集成功并更新数据库`);
                        }
                    } else {
                        // 既没有云端，本地也没获取到 -> 保持数据库原样 (Silent Fail)
                        logger.debug(`[${parser.name}] 本地采集未返回数据，跳过更新`);
                    }
                } catch (e) {
                    logger.warn(`[${parser.name}] 本地自动采集失败:`, e);
                }
            }
        });

        // 等待所有本地补救措施完成
        await Promise.all(localTasks);

        logger.info('初始化流程结束');
    });

    // 定时任务：每天检查一次 CookieCloud
    ctx.setInterval(async () => {
        logger.info('执行每日 CookieCloud 同步检查...');
        // syncCookiesFromCloud 内部会比对本地 DB，不一致才会更新
        await syncCookiesFromCloud(ctx, config);
    }, 24 * 60 * 60 * 1000);

    ctx.middleware(async (session, next) => {
        if (!session.content || !session.channelId) return next();

        const content = session.content.replace(/\\/g, '').replace(/&amp;/g, '&');
        const channelId = session.channelId;
        const links = await resolveLinks(content, ctx, config);

        if (links.length === 0) return next();

        let linkCount = 0;
        for (const link of links) {
            if (session.guildId) {
                const settings = await getEffectiveSettings(ctx, session.guildId, config)
                if (!settings.parsers[link.platform]) {
                    logger.debug(`根据策略，该链接已被阻止解析：平台：${link.platform}，链接：${link.url}`);
                    if (config.showError) await session.send(`根据策略，该链接已被阻止解析：平台：${link.platform}\n如果你是管理员，你可以通过#help share指令获取更多帮助`);
                    continue
                }
            } else {
                if (!config.default_parsers[link.platform as keyof typeof config.default_parsers]) {
                    logger.debug(`根据策略，该链接已被阻止解析：平台：${link.platform}，链接：${link.url}`);
                    if (config.showError) await session.send(`根据策略，该链接已被阻止解析：平台：${link.platform}`);
                    continue
                }
            }

            if (linkCount >= config.parseLimit) {
                await session.send("已达到单次解析上限…");
                break;
            }

            const now = Date.now();
            if (!lastProcessedUrls[channelId]) lastProcessedUrls[channelId] = {};
            if (now - (lastProcessedUrls[channelId][link.url] || 0) < config.Min_Interval * 1000) {
                logger.debug(`链接 ${link.url} 在冷却时间内，跳过处理。`);
                continue;
            }

            if (config.waitTip_Switch) {
                await session.send(config.waitTip_Switch);
            }

            // === 性能统计变量 ===
            const startTotal = Date.now();
            const timeStats = {downloadTime: 0, sendTime: 0};
            let parseTime = 0;
            let isCache = false;
            let status = "success";
            let errorMsg = "";
            let errorStack = "";

            // === 缓存与并发控制逻辑 ===
            let result: ParsedInfo | null = null;
            const cacheKey = `${link.platform}:${link.id}`;
            let optimisticData: ParsedInfo | null = null; // 用于暂存乐观缓存数据

            try {
                // 1. 查持久化缓存 (DB)
                if (config.enableCache) {
                    const cached = await ctx.database.get('sla_parse_cache', cacheKey);
                    // 检查是否存在
                    if (cached.length > 0) {
                        const entry = cached[0];
                        const ageMs = Date.now() - entry.created_at;

                        // 分别判断是否超过 L1 和 乐观缓存 时效
                        const isExpiredL1 = config.cacheExpiration > 0 && (ageMs > config.cacheExpiration * 60 * 60 * 1000);
                        const isExpiredL2 = config.optimisticExpiration > 0 && (ageMs > config.optimisticExpiration * 60 * 60 * 1000);

                        if (!isExpiredL1) {
                            logger.debug(`使用 L1 缓存解析结果: ${cacheKey}`);
                            result = entry.data;
                            isCache = true;
                        } else if (config.optimisticCache && !isExpiredL2) {
                            logger.debug(`L1 缓存已过期，暂存乐观缓存备用: ${cacheKey}`);
                            optimisticData = entry.data;
                        } else {
                            // 彻底过期，删除
                            await ctx.database.remove('sla_parse_cache', {key: cacheKey});
                        }
                    }
                }

                // 2. 查内存任务队列
                if (!result) {
                    if (pendingChecks.has(cacheKey)) {
                        logger.debug(`检测到正在进行的解析任务，正在等待合并结果: ${cacheKey}`);
                        // 如果有相同的任务正在进行，直接等待它的结果
                        try {
                            result = await pendingChecks.get(cacheKey) || null;
                            if (optimisticData && result === optimisticData) {
                                isCache = true;
                                status = "optimistic_fallback";
                            }
                        } catch (e: any) {
                            // 其他合并请求抛错时触发回退
                            if (optimisticData) {
                                logger.warn(`合并任务失败，触发乐观缓存回退: ${cacheKey}`);
                                result = optimisticData;
                                isCache = true;
                                status = "optimistic_fallback";
                            } else {
                                throw e;
                            }
                        }
                    } else {
                        // 如果没有，创建一个新的 Promise 任务
                        const task = (async () => {
                            const t = Date.now();
                            try {
                                const res = await processLink(ctx, config, link, session);

                                // 判断是否视为解析失败（返回 null）
                                if (!res) {
                                    if (optimisticData) {
                                        logger.warn(`API 返回 null，触发乐观缓存回退: ${cacheKey}`);
                                        return optimisticData;
                                    }
                                    return null;
                                }

                                // 解析成功且开启缓存，则写入 DB，刷新缓存时间戳
                                if (config.enableCache) {
                                    await ctx.database.upsert('sla_parse_cache', [{
                                        key: cacheKey,
                                        data: res,
                                        created_at: Date.now()
                                    }]);
                                }
                                return res;
                            } catch (e: any) {
                                // 抛出异常（网络错误/封禁）时触发乐观回退
                                if (optimisticData) {
                                    logger.warn(`解析抛出异常，触发乐观缓存回退: ${cacheKey} | Error: ${e.message}`);
                                    return optimisticData;
                                }
                                logger.warn(`解析任务出错: ${e}`);
                                throw e;
                            } finally {
                                // 执行上报
                                // 无论成功失败，都在 finally 中上报数据
                                parseTime = Date.now() - t;
                            }
                        })();

                        // 将任务存入 Map
                        pendingChecks.set(cacheKey, task);

                        try {
                            result = await task;
                            // 识别最终是否使用了乐观缓存回退
                            if (optimisticData && result === optimisticData) {
                                isCache = true;
                                status = "optimistic_fallback";
                            }
                        } finally {
                            // 无论成功失败，任务结束后从 Map 中移除
                            pendingChecks.delete(cacheKey);
                        }
                    }
                }
                // === 逻辑结束 ===

                if (result) {
                    lastProcessedUrls[channelId][link.url] = Date.now();
                    await sendResult(ctx, session, config, result, logger, timeStats);
                } else {
                    status = "failed";
                    errorMsg = "parser_returned_null";
                    // 即使没有抛错，如果返回 null，也可以视为一种“软失败”，记录一下
                }
                linkCount++;
            } catch (e: any) {
                status = "error";
                errorMsg = e.message || String(e);
                errorStack = e.stack || String(e);
                logger.warn(`处理异常: ${e}`);
            } finally {
                // 4. 上报数据
                const totalTime = Date.now() - startTotal;

                // 获取内存使用情况 (MB)
                const memoryUsage = process.memoryUsage();
                const rssMB = (memoryUsage.rss / 1024 / 1024).toFixed(2);

                // 截取堆栈前 1000 个字符，防止数据包过大（根据您的后端数据库限制调整）
                const truncatedStack = errorStack.length > 1000 ? errorStack.substring(0, 1000) + "..." : errorStack;

                reportMetric(ctx, config, {
                    type: "link_process", // 业务类型

                    // Tags
                    platform: link.platform,
                    status: status,
                    is_cache: isCache.toString(),
                    using_local: config.usingLocal.toString(),
                    user_id: session.userId || "unknown",

                    // 上下文信息，帮助定位是哪个群/频道
                    guild_id: session.guildId || "private",
                    channel_id: session.channelId || "unknown",

                    // URL
                    target_url: link.url,

                    // 错误信息
                    error_msg: errorMsg,
                    // 建议将堆栈放入 tags (如果数据库支持长文本) 或者单独的 log 字段
                    // 这里放入 tags 供查阅
                    error_stack: status === 'error' ? truncatedStack : "",

                    // 数值/指标
                    time_total_ms: totalTime,
                    time_parse_ms: parseTime,
                    time_download_ms: timeStats.downloadTime,
                    time_send_ms: timeStats.sendTime,

                    // 系统负载指标
                    memory_rss_mb: parseFloat(rssMB), // 当前进程内存占用
                    concurrent_tasks: pendingChecks.size, // 当前正在进行的并发解析数
                });
            }
        }
    });
}
