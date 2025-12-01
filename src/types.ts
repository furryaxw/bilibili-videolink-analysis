// src/types.ts

let session_global;

// 定义解析出的链接基本信息
export interface Link {
  platform: string;
  type: string;
  id: string;
  url: string;
}

// 定义解析器处理后返回的统一结构化数据格式
export interface ParsedInfo {
  platform: string;
  title: string;
  authorName: string;
  mainbody?: string;
  coverUrl?: string;
  files: FileInfo[];
  sourceUrl: string;
  stats: string;
}

export interface FileInfo {
  type: 'video' | 'audio' | 'generic'
  url: string;
}

// 插件配置接口
export interface PluginConfig {
  // 通用配置
  Video_ClarityPriority: '1' | '2';
  Max_size: number;
  Min_Interval: number;
  waitTip_Switch: false | string;
  useForward: 'plain' | 'forward'|'mixed';
  sendFiles: boolean;
  sendLinks: boolean;

  // 格式化配置
  format: string; // 主格式化模板

  // 高级设置
  parseLimit: number;
  useNumeral: boolean;
  showError: boolean;

  // 代理设置
  proxy: string;
  proxy_settings: object;
  default_parsers: object;
  allow_sensitive: boolean;

  // 跨环境路径映射设置
  onebotReadDir: string;
  localDownloadDir: string;

  // 调试设置
  userAgent: string;
  logLevel: 'none' | 'link_only' | 'full';
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
