// src/parsers/xiaoheihe.ts

import {Context, h, Session} from 'koishi';
import {ContentBlock, Link, ParsedInfo, PluginConfig, XiaoHeiHePostData} from '../types';
import {escapeHtml, getCookie, numeral} from '../utils';
// @ts-ignore
import {HTTPRequest, Page} from 'puppeteer'

export const name = "xiaoheihe";

const linkRules = [
    {
        pattern: /https?:\/\/api.xiaoheihe\.cn\/v3\/bbs\/app\/api\/web\/share\?[\w=&]+/gi,
        type: "bbs_api" as const,
    },
    {
        pattern: /https?:\/\/www.xiaoheihe\.cn\/app\/bbs\/link\/\w+/gi,
        type: "bbs" as const,
    }
];

export async function match(content: string, ctx: Context, config: PluginConfig): Promise<Link[]> {
    const results: Link[] = [];
    const seen = new Set<string>();

    for (const rule of linkRules) {
        let match;
        rule.pattern.lastIndex = 0;
        while ((match = rule.pattern.exec(content)) !== null) {
            const fullUrl = match[0];
            let id: string | undefined;
            if (rule.type == "bbs") id = fullUrl.match(/\w+$/)?.[0];
            else if (rule.type == "bbs_api") id = fullUrl.match(/link_id=\w+/gi)?.[0].slice(8);

            if (id) {
                const key = `${rule.type}:${id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                results.push({platform: name, type: rule.type, id, url: `https://www.xiaoheihe.cn/app/bbs/link/${id}`});
            }
        }
    }
    return results;
}

export async function process(
    ctx: Context,
    config: PluginConfig,
    link: Link,
    session: Session
): Promise<ParsedInfo | null> {
    const logger = ctx.logger(`share-links-analysis:${name}`);

    const url = link.url
    let page: Page | null = null;
    try {
        page = await ctx.puppeteer.page();
        await page.setUserAgent(config.userAgent)

        // 加载并注入 Cookie
        const cookieStr = await getCookie(ctx, config, name);
        if (cookieStr) {
            // Puppeteer 需要对象数组格式的 Cookie
            const cookies = cookieStr.split(';').map(pair => {
                const [cookieName, ...cookieValue] = pair.trim().split('=');
                return {
                    name: cookieName,
                    value: cookieValue.join('='),
                    domain: '.xiaoheihe.cn' // 必须指定正确的 domain
                };
            }).filter(c => c.name); // 过滤空值

            if (cookies.length > 0) {
                await page.setCookie(...cookies);
            }
        }

        // 设置请求拦截（阻止非必要资源加载加速解析）
        await page.setRequestInterception(true)
        page.on('request', (req: HTTPRequest) => {
            const resourceType = req.resourceType()

            // 必须加载的资源
            if (url.includes('/app/community/detail/') ||
                url.includes('heybox-bbs') ||
                url.includes('heybox-common') ||
                resourceType === 'xhr' ||
                resourceType === 'script') {
                req.continue()
                return
            }

            // 阻止非必要资源
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType) &&
                !url.includes('avatar') &&
                !url.includes('thumb')) {
                req.abort()
            } else {
                req.continue()
            }
        })

        // 导航到目标页面
        const response = await Promise.race([
            page.goto(link.url, {waitUntil: 'networkidle2', timeout: 10000}),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('页面加载超时')), 10000)
            )
        ])

        if (!response || response.status() !== 200) {
            throw new Error(`页面加载失败，状态码: ${response?.status() || '未知'}`)
        }

        // 智能等待 - 适配三种布局
        await Promise.race([
            page.waitForFunction(() => {
                const hasImageText = !!document.querySelector('.hb-bbs-image-text');
                const hasPost = !!document.querySelector('.hb-bbs-post');

                const videoBox = document.querySelector('.hb-bbs__video');
                let isVideoReady = false;
                if (videoBox) {
                    const v = videoBox.querySelector('video') as HTMLVideoElement;
                    // 只要 video 标签有了 src，或者它内部长出了带有 src 的 source 标签，就判定为就绪
                    if (v && (v.src || v.querySelector('source')?.getAttribute('src'))) {
                        isVideoReady = true;
                    }
                }

                return hasImageText || hasPost || isVideoReady;
            }, {timeout: 30000}),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('核心内容容器未找到')), 30000)
            )
        ])

        // 全面解析页面内容
        const postData = await page.evaluate((): Promise<XiaoHeiHePostData | null> => {
            // 1. 检测页面类型
            const isImageTextType = !!document.querySelector('.hb-bbs-image-text');
            const isPostType = !!document.querySelector('.hb-bbs-post');
            const isVideoBbsType = !!document.querySelector('.hb-bbs__video');

            if (!isImageTextType && !isPostType && !isVideoBbsType) {
                throw new Error('不支持的页面结构');
            }

            // 2. 基础数据解析（通用）
            let title = '';
            let username = '未知用户';
            let level = 'Lv.0';
            let time = '未知时间';
            let ip = '未知地区';
            const tags: string[] = [];
            const contentBlocks: ContentBlock[] = [];
            let authorSection: Element | null = null;
            let coverImage = '';
            let videoUrl = '';

            // 3. 操作数据解析（通用）
            let likeCount = '0';
            let favoriteCount = '0';
            let commentCount = '0';

            const operationBox = document.querySelector('.link-reply__operation-box');
            if (operationBox) {
                const buttons = operationBox.querySelectorAll('button');
                buttons.forEach((button) => {
                    const icon = button.querySelector('i');
                    const countSpan = button.querySelector('.link-reply__operation-desc');
                    const count = countSpan?.textContent?.trim() || '0';

                    if (icon) {
                        const className = icon.className || '';
                        if (className.includes('thumbs-up')) {
                            likeCount = count;
                        } else if (className.includes('star')) {
                            favoriteCount = count;
                        } else if (className.includes('comment')) {
                            commentCount = count;
                        }
                    }
                });
            }

            // 4. 按类型解析内容
            if (isImageTextType) {
                // ===== 旧结构解析 (.hb-bbs-image-text) =====
                const container = document.querySelector('.hb-bbs-image-text')!;

                // 标题
                title = container.querySelector('.section-title__content')?.textContent?.trim() || '无标题';

                // 作者信息
                authorSection = container.querySelector('.link-section-user');
                if (authorSection) {
                    username = authorSection.querySelector('.link-user__username')?.textContent?.trim() || '未知用户';
                    level = authorSection.querySelector('.level-tag__wrapper')?.textContent?.trim() || 'Lv.0';
                    time = authorSection.querySelector('.link-data__time')?.textContent?.trim() || '未知时间';
                    ip = authorSection.querySelector('.link-data__ip')?.textContent?.trim() || '未知地区';
                }

                // 标签
                container.querySelectorAll('.link-section-tags .content-tag-text').forEach(tag => {
                    const text = tag.textContent?.trim();
                    if (text) tags.push(text);
                });

                // 内容
                const mainContent = container.querySelector('.image-text__content')?.textContent?.trim() || '';
                contentBlocks.push({type: 'text', content: mainContent});

                // 图片（轮播图）
                container.querySelectorAll('.header-image__item-image img').forEach((img) => {
                    const src = (img as HTMLImageElement).src.replace(/\?.*$/, '');
                    contentBlocks.push({type: 'image', content: src});
                });

            } else if (isPostType) {
                const container = document.querySelector('.hb-bbs-post')!;
                const postContainer = container.querySelector('.post__container')!;

                // 标题
                title = postContainer.querySelector('.section-title__content')?.textContent?.trim() || '无标题';

                // 作者信息
                authorSection = postContainer.querySelector('.link-section-user');
                if (authorSection) {
                    username = authorSection.querySelector('.link-user__username')?.textContent?.trim() || '未知用户';
                    level = authorSection.querySelector('.level-tag__wrapper')?.textContent?.trim() || 'Lv.0';

                    // 时间/IP 在子元素中
                    const metaData = authorSection.querySelector('.user-info__line-2');
                    if (metaData) {
                        time = metaData.querySelector('.link-data__time')?.textContent?.trim() || '未知时间';
                        ip = metaData.querySelector('.link-data__ip')?.textContent?.replace('·', '').trim() || '未知地区';
                    }
                }

                // 标签（使用第一个标签区域）
                postContainer.querySelectorAll('.link-section-tags:first-of-type .content-tag-text').forEach(tag => {
                    const text = tag.textContent?.trim();
                    if (text) tags.push(text);
                });

                // 封面图片
                const headerImageContainer = container.querySelector('.post__header-image');
                if (headerImageContainer) {
                    const headerImage = headerImageContainer.querySelector('img');
                    if (headerImage) {
                        coverImage = headerImage.src.replace(/\?.*$/, '');
                    }
                }

                // 正文内容
                const contentContainer = postContainer.querySelector('.post__content');
                if (contentContainer) {
                    // 遍历所有子节点保持顺序
                    Array.from(contentContainer.childNodes).forEach(node => {
                        if (node.nodeType !== Node.ELEMENT_NODE) return;

                        const el = node as HTMLElement;

                        // 文本段落
                        if (el.matches('p.com-text, p.com-origin-source')) {
                            let text = el.textContent?.trim() || '';
                            // 特殊处理来源声明
                            if (el.classList.contains('com-origin-source')) {
                                text = `🔖 ${text}`;
                            }
                            if (text) contentBlocks.push({type: 'text', content: text});
                        }

                        // 图片
                        else if (el.matches('div.com-img, div.hb-cpt__image')) {
                            // 优先查找带'show'类的图片
                            const img = el.querySelector('img.hb-cpt__image-elem.show') ||
                                el.querySelector('img.hb-cpt__image-elem');

                            if (img) {
                                const src = (img as HTMLImageElement).src.replace(/\?.*$/, '');
                                contentBlocks.push({type: 'image', content: src});
                            }
                        }
                    });
                }
            } else if (isVideoBbsType) {
                // ===== 纯视频贴结构解析 (.hb-bbs__video) =====
                const container = document.querySelector('.hb-bbs__video')!;

                // 提取视频节点与封面
                const videoEl = container.querySelector('video') as HTMLVideoElement;
                if (videoEl) {
                    videoUrl = videoEl.currentSrc || videoEl.src || videoEl.querySelector('source')?.getAttribute('src') || videoEl.getAttribute('src') || '';
                    coverImage = videoEl.getAttribute('poster') || '';
                }

                // 正文描述 (纯视频贴通常没有单独的 title，把这段描述作为内容)
                const contentWrapper = container.querySelector('.bbs-video__content-wrapper');
                if (contentWrapper) {
                    title = contentWrapper.textContent?.trim() || '分享视频';
                    contentBlocks.push({type: 'text', content: title});
                }

                // 作者信息
                authorSection = container.querySelector('.link-section-user');
                if (authorSection) {
                    username = authorSection.querySelector('.link-user__username')?.textContent?.trim() || '未知用户';
                    level = authorSection.querySelector('.level-tag__wrapper')?.textContent?.trim() || 'Lv.0';
                }

                // 独立的时间与地区信息
                const dataSection = container.querySelector('.link-section-link-data');
                if (dataSection) {
                    time = dataSection.querySelector('.link-data__time')?.textContent?.trim() || '未知时间';
                    ip = dataSection.querySelector('.link-data__ip')?.textContent?.trim() || '未知地区';
                }

                // 标签
                container.querySelectorAll('.link-section-tags .content-tag-text').forEach(tag => {
                    const text = tag.textContent?.trim();
                    if (text) tags.push(text);
                });
            }

            return {
                // @ts-ignore
                isImageTextType,
                isPostType,
                title,
                username,
                level,
                time,
                ip,
                tags,
                contentBlocks,
                likeCount,
                favoriteCount,
                commentCount,
                coverImage,
                videoUrl
            };
        });

        if (!postData) throw new Error('未找到有效内容');

        // 确保页面关闭
        if (page) await page.close().catch(() => {
        })

        // 5. 构建消息
        let mainbody: string = ""

        // 内容块
        postData.contentBlocks.forEach((block: ContentBlock) => {
            if (block.type === 'text') {
                mainbody += escapeHtml(block.content + "\n");
            } else if (block.type === 'image') {
                mainbody += h.image(block.content).toString();
            }
        });

        const tag = postData.tags.length ? `标签：${postData.tags.join(' | ')}\n` : ''
        const status = `点赞: ${numeral(postData.likeCount, config)} | 收藏: ${numeral(postData.favoriteCount, config)} | 评论: ${numeral(postData.commentCount, config)}`

        return {
            platform: name,
            title: postData.title,
            authorName: postData.username,
            mainbody: mainbody + tag,
            sourceUrl: link.url,
            stats: status,
            coverUrl: postData.coverImage,
            files: postData.videoUrl ? [{ type: 'video', url: postData.videoUrl }] : []
        };
    } catch (error) {
        logger.error('解析失败:', error)
        return null
    }
}
