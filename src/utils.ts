import { PluginConfig } from './types';

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
