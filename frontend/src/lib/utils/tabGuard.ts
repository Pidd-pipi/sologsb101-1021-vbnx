/**
 * 多标签页编辑守卫
 * 另一个标签页保存数据时，本标签页通过 BroadcastChannel + storage 事件感知，
 * 提示「数据已在其他标签页保存，请先刷新」，避免晚保存覆盖先保存。
 */

const CHANNEL_NAME = 'gbsealcarve-tab-guard';
const LEASE_KEY = 'gbsealcarve:edit-lease';

/** 租约有效期：超过该时长未再写入视为失效（毫秒） */
const LEASE_TTL = 30000;

export interface EditLease {
  /** 写入标签页 id */
  tabId: string;
  /** 写入时间戳 */
  at: number;
  /** 写入摘要（如「导入交接包」「保存印石」） */
  reason: string;
}

type GuardListener = (lease: EditLease) => void;

class TabGuard {
  private tabId: string;
  private channel: BroadcastChannel | null = null;
  private listeners = new Set<GuardListener>();
  private externalWrite = false;
  private lastExternalLease: EditLease | null = null;

  constructor() {
    this.tabId = `tab_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    if (typeof window !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(CHANNEL_NAME);
        this.channel.onmessage = (event: MessageEvent) => {
          const lease = event.data as EditLease;
          if (lease && lease.tabId !== this.tabId) this.notify(lease);
        };
      } catch {
        this.channel = null;
      }
      window.addEventListener('storage', (event) => {
        if (event.key !== LEASE_KEY || !event.newValue) return;
        try {
          const lease = JSON.parse(event.newValue) as EditLease;
          if (lease && lease.tabId !== this.tabId) this.notify(lease);
        } catch {
          /* ignore */
        }
      });
    }
  }

  private notify(lease: EditLease): void {
    this.externalWrite = true;
    this.lastExternalLease = lease;
    this.listeners.forEach((listener) => listener(lease));
  }

  /** 本标签页写入数据后调用：通知其他标签页 */
  markLocalWrite(reason: string): void {
    const lease: EditLease = { tabId: this.tabId, at: Date.now(), reason };
    try {
      localStorage.setItem(LEASE_KEY, JSON.stringify(lease));
    } catch {
      /* 隐私模式忽略 */
    }
    try {
      this.channel?.postMessage(lease);
    } catch {
      /* ignore */
    }
  }

  /** 是否存在其他标签页的写入（未刷新前为 true） */
  hasExternalWrite(): boolean {
    return this.externalWrite;
  }

  /** 最近一次外部写入摘要 */
  getExternalLease(): EditLease | null {
    return this.lastExternalLease;
  }

  /** 清除外部写入标记（用户选择继续操作后） */
  clearExternalWrite(): void {
    this.externalWrite = false;
    this.lastExternalLease = null;
  }

  /** 订阅外部写入事件 */
  subscribe(listener: GuardListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get currentTabId(): string {
    return this.tabId;
  }
}

export const tabGuard = new TabGuard();

/** 读取最近一次写入租约（用于判断是否有其他标签页刚写过） */
export function readLease(): EditLease | null {
  try {
    const raw = localStorage.getItem(LEASE_KEY);
    if (!raw) return null;
    const lease = JSON.parse(raw) as EditLease;
    if (typeof lease.at !== 'number') return null;
    if (Date.now() - lease.at > LEASE_TTL) return null;
    return lease;
  } catch {
    return null;
  }
}
