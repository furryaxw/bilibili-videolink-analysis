import {ParsedInfo, PluginConfig} from './types';
import {h, Logger, Session} from "koishi";

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

function escapeHtml(str: string) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function sendResult_plain(session: Session, config: PluginConfig, result: ParsedInfo, logger: Logger) {
  if (config.logLevel === 'full') {
    logger.info('进入普通消息发送');
  }

  let message = config.format;

  // 对所有文本内容进行 HTML 转义
  message = message.replace(/{title}/g, escapeHtml(result.title || ''));
  message = message.replace(/{authorName}/g, escapeHtml(result.authorName || ''));
  message = message.replace(/{description}/g, escapeHtml(result.description ? result.description : ''));
  message = message.replace(/{sourceUrl}/g, escapeHtml(result.sourceUrl || ''));
  message = message.replace(/{cover}/g, result.coverUrl ? h.image(result.coverUrl).toString() : '');
  const imagesText = result.images ? result.images.map(img => h.image(img).toString()).join('\n') : '';
  message = message.replace(/{images}/g, imagesText);
  message = message.replace(/{stats}/g, escapeHtml(result.stats || ''));

  // 只要 videoUrl 存在就处理，仅当 duration 明确超长时才替换为提示
  if (result.videoUrl) {
    message = message.replace(/{videoUrl}/g, escapeHtml(result.videoUrl));
    // 仅当 duration 是有效数字且超长时，才显示提示
    if (typeof result.duration === 'number' && result.duration > config.Maximumduration * 60) {
      const tip = escapeHtml(config.Maximumduration_tip || '');
      message = message.replace(/{video}/g, tip);
    } else {
      // 正常发送视频和链接
      message = message.replace(/{video}/g, h.video(result.videoUrl).toString());
    }
    if (config.logLevel === 'link_only') {
      logger.info(`视频直链 (${result.platform}): ${result.videoUrl}`);
    }
  } else {
    // 没有视频则移除占位符
    message = message.replace(/{video}/g, '');
    message = message.replace(/{videoUrl}/g, '');
  }

  // 过滤空行，保留含有 < 的行（如图片、视频标签）
  const cleanMessage = message.split('\n').filter(line => line.trim() !== '' || line.includes('<')).join('\n');

  if (config.logLevel === 'full') {
    logger.info(`解析结果: \n ${JSON.stringify(result, null, 2)}`);
  }

  if (cleanMessage) {
    await session.send(h.quote(session.messageId) + cleanMessage);
  }

}

export async function sendResult_forward(session: Session, config: PluginConfig, result: ParsedInfo, logger: Logger) {
  if (config.logLevel === 'full') {
    logger.info('进入合并转发发送');
  }

  let message = config.format;

  // Step 1: 替换纯文本字段
  message = message.replace(/{title}/g, escapeHtml(result.title || ''));
  message = message.replace(/{authorName}/g, escapeHtml(result.authorName || ''));
  message = message.replace(/{description}/g, escapeHtml(result.description || ''));
  message = message.replace(/{sourceUrl}/g, escapeHtml(result.sourceUrl || ''));
  message = message.replace(/{stats}/g, escapeHtml(result.stats || ''));
  if (result.videoUrl) {
    message = message.replace(/{videoUrl}/g, escapeHtml(result.videoUrl));
  }
  if (typeof result.duration === 'number' && result.duration > config.Maximumduration * 60) {
    const tip = escapeHtml(config.Maximumduration_tip || '');
    message = message.replace(/{video}/g, tip);
  }

  // Step 2: 检查是否包含视频占位符
  const hasVideoInTemplate = message.includes('{video}');

  // Step 3: 构建富媒体映射
  const mediaMap: Record<string, any[]> = {};

  // 处理封面
  if (result.coverUrl) {
    mediaMap['{cover}'] = [{type: 'image', data: {file: result.coverUrl}}];
  } else {
    mediaMap['{cover}'] = [];
  }

  // 处理图片列表
  if (result.images && result.images.length > 0) {
    mediaMap['{images}'] = result.images.map(img => ({type: 'image', data: {file: img}}));
  } else {
    mediaMap['{images}'] = [];
  }

  // Step 4: 按行处理，仅过滤纯空行，并精确控制换行
  const lines = message.split('\n').filter(line => line.trim() !== '');
  const nonVideoSegments: any[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLastLine = i === lines.length - 1;

    // 按富媒体占位符分割
    const tokens = line.split(/(\{cover\}|\{images\}|\{video\})/g);

    // 用于存储当前行的消息段
    const currentLineSegments: any[] = [];
    let hasTextContent = false; // 新增标志：当前行是否包含纯文本

    for (const token of tokens) {
      if (token === '{cover}' || token === '{images}') {
        // 插入对应的消息段
        currentLineSegments.push(...mediaMap[token]);
      } else if (token === '{video}') {
        // 视频不放入 nonVideoSegments，跳过
      } else if (token.trim() !== '') {
        // 普通文本
        currentLineSegments.push({type: 'text', data: {text: token}});
        hasTextContent = true; // 标记当前行有文本
      }
      // 注意：token 为空字符串时（如占位符在行首/尾），不添加任何内容
    }

    // 只有当 currentLineSegments 不为空时，才将其加入总列表
    if (currentLineSegments.length > 0) {
      nonVideoSegments.push(...currentLineSegments);
    }

    // 如果不是最后一行，且当前行非空，则添加一个换行符
    if (!isLastLine && hasTextContent) {
      nonVideoSegments.push({type: 'text', data: {text: '\n'}});
    }
  }

  // Step 5: 构建转发节点
  const forwardNodes: any[] = [];

  // 非视频内容节点
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

  // 视频节点（仅当模板中有 {video} 且有有效视频时）
  if (hasVideoInTemplate && result.videoUrl) {
    if (typeof result.duration === 'number' && result.duration > config.Maximumduration * 60) {
    } else {
      forwardNodes.push({
        type: 'node',
        data: {
          user_id: session.selfId,
          nickname: '分享助手',
          content: [
            {type: 'video', data: {file: result.videoUrl}},
          ]
        }
      });
    }
    if (config.logLevel === 'link_only') {
      logger.info(`视频直链 (${result.platform}): ${result.videoUrl}`);
    }
  }

  if (forwardNodes.length === 0) return;

  if (config.logLevel === 'full') {
    logger.info(`解析结果: \n ${JSON.stringify(result, null, 2)}`);
  }

  // Step 6: 发送合并转发
  if (!(session.onebot && session.onebot._request)) throw new Error("Onebot is not defined");
  await session.onebot._request('send_group_forward_msg', {
    group_id: session.guildId,
    messages: forwardNodes,
    news: [{text: result.description || '-'}, {text: '点击查看详情 | Powered by furryaxw'}],
    prompt: result.title || '',
    summary: '分享解析',
    source: result.title || ''
  });
}

export async function sendResult_mixed(session: Session, config: PluginConfig, result: ParsedInfo, logger: Logger) {
  if (config.logLevel === 'full') {
    logger.info('进入混合转发发送');
  }

  let message = config.format;

  // Step 1: 替换纯文本字段
  message = message.replace(/{title}/g, escapeHtml(result.title || ''));
  message = message.replace(/{authorName}/g, escapeHtml(result.authorName || ''));
  message = message.replace(/{description}/g, escapeHtml(result.description || ''));
  message = message.replace(/{sourceUrl}/g, escapeHtml(result.sourceUrl || ''));
  message = message.replace(/{stats}/g, escapeHtml(result.stats || ''));
  if (result.videoUrl) {
    message = message.replace(/{videoUrl}/g, escapeHtml(result.videoUrl));
  }
  if (typeof result.duration === 'number' && result.duration > config.Maximumduration * 60) {
    const tip = escapeHtml(config.Maximumduration_tip || '');
    message = message.replace(/{video}/g, tip);
  }

  // Step 2: 检查是否包含视频占位符
  const hasVideoInTemplate = message.includes('{video}');

  // Step 3: 构建富媒体映射
  const mediaMap: Record<string, any[]> = {};

  // 处理封面
  if (result.coverUrl) {
    mediaMap['{cover}'] = [{type: 'image', data: {file: result.coverUrl}}];
  } else {
    mediaMap['{cover}'] = [];
  }

  // 处理图片列表
  if (result.images && result.images.length > 0) {
    mediaMap['{images}'] = result.images.map(img => ({type: 'image', data: {file: img}}));
  } else {
    mediaMap['{images}'] = [];
  }

  // Step 4: 按行处理，仅过滤纯空行，并精确控制换行
  const lines = message.split('\n').filter(line => line.trim() !== '');
  const nonVideoSegments: any[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLastLine = i === lines.length - 1;

    // 按富媒体占位符分割
    const tokens = line.split(/(\{cover\}|\{images\}|\{video\})/g);

    // 用于存储当前行的消息段
    const currentLineSegments: any[] = [];
    let hasTextContent = false; // 新增标志：当前行是否包含纯文本

    for (const token of tokens) {
      if (token === '{cover}' || token === '{images}') {
        // 插入对应的消息段
        currentLineSegments.push(...mediaMap[token]);
      } else if (token === '{video}') {
        // 视频不放入 nonVideoSegments，跳过
      } else if (token.trim() !== '') {
        // 普通文本
        currentLineSegments.push({type: 'text', data: {text: token}});
        hasTextContent = true; // 标记当前行有文本
      }
      // 注意：token 为空字符串时（如占位符在行首/尾），不添加任何内容
    }

    // 只有当 currentLineSegments 不为空时，才将其加入总列表
    if (currentLineSegments.length > 0) {
      nonVideoSegments.push(...currentLineSegments);
    }

    // 如果不是最后一行，且当前行非空，则添加一个换行符
    if (!isLastLine && hasTextContent) {
      nonVideoSegments.push({type: 'text', data: {text: '\n'}});
    }
  }

  // Step 5: 构建转发节点
  const forwardNodes: any[] = [];

  // 非视频内容节点
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

  let video;
  // 视频节点（仅当模板中有 {video} 且有有效视频时）
  if (hasVideoInTemplate && result.videoUrl) {
    if (typeof result.duration === 'number' && result.duration > config.Maximumduration * 60) {
    } else {
      video = h.video(result.videoUrl).toString();
    }
    if (config.logLevel === 'link_only') {
      logger.info(`视频直链 (${result.platform}): ${result.videoUrl}`);
    }
  }

  if (forwardNodes.length === 0) return;

  if (config.logLevel === 'full') {
    logger.info(`解析结果: \n ${JSON.stringify(result, null, 2)}`);
  }

  // Step 6: 发送合并转发
  if (!(session.onebot && session.onebot._request)) throw new Error("Onebot is not defined");

  const promises = [];
  promises.push(session.onebot._request('send_group_forward_msg', {
    group_id: session.guildId,
    messages: forwardNodes,
    news: [{text: result.description || '-'}, {text: '点击查看详情 | Powered by furryaxw'}],
    prompt: result.title || '',
    summary: '分享解析',
    source: result.title || ''
  }));
  if (video) promises.push(session.send(video));
  await Promise.all(promises);
}
