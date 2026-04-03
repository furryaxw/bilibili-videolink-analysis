// src/parsers/github.ts

import {Context, Session} from 'koishi';
import {Link, ParsedInfo, PluginConfig} from '../types';
import {escapeHtml, numeral} from '../utils';

export const name = "github";

// 过滤掉 GitHub 官方的一些非仓库根路径
const IGNORE_OWNERS = [
    'settings', 'pulls', 'issues', 'search', 'notifications',
    'explore', 'topics', 'trending', 'collections', 'events',
    'sponsors', 'features', 'enterprise', 'team', 'pricing',
    'about', 'contact', 'login', 'join'
];

/**
 * 在文本中匹配 GitHub 仓库链接
 */
export async function match(content: string, ctx: Context, config: PluginConfig): Promise<Link[]> {
    const results: Link[] = [];
    const seen = new Set<string>();

    // 匹配 github.com/owner/repo
    const repoPattern = /(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9_.-]+)/gi;
    let m;

    while ((m = repoPattern.exec(content)) !== null) {
        const owner = m[1];
        const repo = m[2];

        if (IGNORE_OWNERS.includes(owner.toLowerCase())) continue;

        const id = `${owner}/${repo}`;
        if (!seen.has(id)) {
            seen.add(id);
            results.push({platform: name, type: 'repo', id, url: `https://github.com/${id}`});
        }
    }

    return results;
}

/**
 * 处理单个 GitHub 链接
 */
export async function process(
    ctx: Context,
    config: PluginConfig,
    link: Link,
    session: Session
): Promise<ParsedInfo | null> {
    const logger = ctx.logger(`share-links-analysis:${name}`);

    // 使用 GitHub 官方开放 API（免鉴权，有速率限制）
    const repoUrl = `https://api.github.com/repos/${link.id}`;

    try {
        logger.debug(`正在请求 GitHub API: ${repoUrl}`);

        const reqOptions: any = {
            headers: {
                'User-Agent': config.userAgent,
                'Accept': 'application/vnd.github.v3+json'
            }
        };

        // 适配插件全局配置里的代理选项
        if (config.proxy_settings[name] && config.proxy) {
            reqOptions.proxyAgent = config.proxy;
        }

        // 核心请求
        const res = await ctx.http.get(repoUrl, reqOptions);

        if (!res || !res.full_name) {
            throw new Error('GitHub API 返回数据无效或仓库不存在');
        }

        // 尝试获取最新 Release（如果失败静默忽略，防止因限流导致整个卡片解析失败）
        let latestRelease = '';
        try {
            const releaseRes = await ctx.http.get(`${repoUrl}/releases/latest`, reqOptions);
            if (releaseRes && releaseRes.tag_name) {
                latestRelease = releaseRes.tag_name;
            }
        } catch (e) {
            logger.debug(`获取 Release 失败或触发限流: ${link.id}`);
        }

        const title = res.full_name;
        const authorName = res.owner?.login || 'Unknown';

        // 提取高价值静态数据
        const topics = res.topics && res.topics.length > 0 ? res.topics.slice(0, 5).join(', ') : '';
        const updatedAt = new Date(res.pushed_at || res.updated_at).toLocaleString('zh-CN', {hour12: false});

        const stars = numeral(res.stargazers_count, config);
        const forks = numeral(res.forks_count, config);
        const watchers = numeral(res.subscribers_count || res.watchers_count, config);
        const issues = numeral(res.open_issues_count, config);

        const statsString = `Stars: ${stars} | Forks: ${forks} | Watchers: ${watchers} | Issues: ${issues}`;

        // 组装精炼的正文排版
        let finalBody = res.description ? escapeHtml(res.description) : '暂无描述';

        // 补充 Fork 信息：判断是否为派生仓库
        if (res.fork && res.parent?.full_name) {
            finalBody = `Forked from: ${res.parent.full_name}\n\n` + finalBody;
        }

        if (topics) {
            finalBody += `\n标签: ${escapeHtml(topics)}`;
        }

        finalBody += `\n\n更新时间: ${updatedAt}`;

        const metaInfo = [];
        if (res.language) metaInfo.push(`语言: ${res.language}`);
        if (latestRelease) metaInfo.push(`版本: ${latestRelease}`);
        if (res.license?.spdx_id) metaInfo.push(`协议: ${res.license.spdx_id}`);

        if (metaInfo.length > 0) {
            finalBody += `\n` + metaInfo.join(' | ');
        }

        return {
            platform: name,
            title: title,
            authorName: authorName,
            mainbody: finalBody,
            coverUrl: '',
            files: [],
            sourceUrl: res.html_url,
            stats: statsString,
        };

    } catch (error: any) {
        logger.error(`GitHub 解析失败: ${error.message}`);
        return null;
    }
}