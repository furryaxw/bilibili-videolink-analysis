// src/types.ts

// 定义解析出的链接基本信息
export interface Link {
  platform: 'bilibili' | 'xiaohongshu';
  type: string;
  id: string;
  url: string;
}

// 定义处理后返回给主逻辑的统一格式
export interface ProcessedLink {
  text: string;
  videoUrl: string | null;
  duration: number | null;
  sourceUrl?: string;
}

// 插件配置接口
export interface PluginConfig {
  // Bilibili & 通用配置
  linktextParsing: boolean;
  VideoParsing_ToLink: '1' | '2' | '3' | '4' | '5';
  Video_ClarityPriority: '1' | '2';
  BVnumberParsing: boolean;
  Maximumduration: number;
  Maximumduration_tip: string;
  MinimumTimeInterval: number;
  waitTip_Switch: false | string;
  parseLimit: number;
  useNumeral: boolean;
  showError: boolean;
  bVideoIDPreference: 'bv' | 'av';
  bVideoImage: boolean;
  bVideoOwner: boolean;
  bVideoDesc: boolean;
  bVideoStat: boolean;
  bVideoExtraStat: boolean;
  bVideoShowLink: boolean;
  userAgent: string;
  loggerinfo: boolean;
}

// Bilibili API 返回的视频信息类型定义 (部分)
export interface BilibiliVideoInfo {
  data: {
    bvid: string;
    aid: number;
    videos: number;
    pic: string;
    title: string;
    pubdate: number;
    ctime: number;
    desc: string;
    duration: number;
    owner: {
      mid: number;
      name: string;
      face: string;
    };
    stat: {
      aid: number;
      view: number;
      danmaku: number;
      reply: number;
      favorite: number;
      coin: number;
      share: number;
      like: number;
    };
    pages: {
      cid: number;
      page: number;
      part: string;
      duration: number;
    }[];
  };
}

// 解决 ctx.BiliBiliVideo 和 ctx.puppeteer 的类型报错
declare module 'koishi' {
  interface Context {
    BiliBiliVideo: any;
    puppeteer?: any; // 将 puppeteer 声明为可选服务
  }
}
