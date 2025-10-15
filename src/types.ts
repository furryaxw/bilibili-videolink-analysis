// src/types.ts

let session_global;

// 定义解析出的链接基本信息
export interface Link {
  platform: 'bilibili' | 'xiaohongshu';
  type: string;
  id: string;
  url: string;
}

// 定义解析器处理后返回的统一结构化数据格式
export interface ParsedInfo {
  platform: 'bilibili' | 'xiaohongshu';
  title: string;
  authorName: string;
  description?: string;
  coverUrl?: string;
  videoUrl?: string | null;
  duration?: number | null;
  sourceUrl: string;
  stats: string;
  images?: string[];
}

// 插件配置接口
export interface PluginConfig {
  // 通用配置
  Video_ClarityPriority: '1' | '2';
  Maximumduration: number;
  Maximumduration_tip: string;
  MinimumTimeInterval: number;
  waitTip_Switch: false | string;
  useForward: boolean;

  // 格式化配置
  format: string; // 【恢复】主格式化模板
  bilibiliStatsFormat: string; // 【新增】B站数据统计格式
  xiaohongshuStatsFormat: string; // 【新增】小红书数据统计格式

  // 高级设置
  parseLimit: number;
  useNumeral: boolean;
  showError: boolean;
  bVideoIDPreference: 'bv' | 'av';

  // 调试设置
  userAgent: string;
  logLevel: 'none' | 'link_only' | 'full'; // 【新增】日志等级替换原布尔值
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
    puppeteer?: any;
  }
  interface Tables {
    sla_cookie_cache: {
      platform: string;
      cookie: string;
    }
  }
}

// 为小红书笔记数据定义更详细的类型接口
export interface XhsImageInfo {
  imageScene: string;
  url: string;
}

export interface XhsImage {
  infoList: XhsImageInfo[];
  url_default: string;
}

export interface XhsNoteData {
  title: string;
  desc: string;
  type: 'video' | 'normal';
  user: {
    nickname: string;
    avatar: string;
  };
  interactInfo: {
    likedCount: string;
    collectedCount: string;
    commentCount: string;
    shareCount: string;
  };
  imageList?: XhsImage[];
  video?: {
    media: {
      duration: number;
      stream: {
        h264: { masterUrl: string }[];
      };
    };
  };
}

export interface XhsInitialState {
  note: {
    noteDetailMap: {
      [key: string]: {
        note: XhsNoteData;
      };
    };
  };
}
