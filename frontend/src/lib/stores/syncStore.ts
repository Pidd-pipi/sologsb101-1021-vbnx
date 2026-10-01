/**
 * 离线交接协同 store
 *
 * - 跨标签页保护：另一个标签页保存数据时，本标签页顶部先提示「数据已在别处更新，请刷新」，
 *   确认后统一重载各 store（印谱条目走 liveQuery 自动刷新）；
 * - 本机写操作（db.ts 的 Dexie 钩子）通过 BroadcastChannel（降级 storage 事件）广播；
 * - 数据版本号写入 localStorage，广播只携带标签页 id，避免误提示自己。
 */
import { writable } from 'svelte/store';
import { onLocalDataWrite } from '$lib/utils/db';
import { loadStones } from './stoneStore';
import { loadDesigns } from './designStore';
import { loadCarves } from './carveStore';
import { loadImpressions } from './impressionStore';

const CHANNEL_NAME = 'gbsealcarve:data-changed';
const LS_TAB_ID = 'gbsealcarve:tab-id';

function getTabId(): string {
  let id = '';
  try {
    id = sessionStorage.getItem(LS_TAB_ID) ?? '';
  } catch {
    /* ignore */
  }
  if (!id) {
    id = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    try {
      sessionStorage.setItem(LS_TAB_ID, id);
    } catch {
      /* ignore */
    }
  }
  return id;
}

const tabId = getTabId();

/** 另一标签页有保存动作，需提示刷新 */
export const remoteDataChanged = writable(false);
/** 最近一次远端更新时间 */
export const remoteChangedAt = writable<number | null>(null);

let initialized = false;

/** 统一重载全部内存 store（印谱 liveQuery 自动更新，无需手动刷新） */
export async function reloadAllData(): Promise<void> {
  await Promise.all([loadStones(), loadDesigns(), loadCarves(), loadImpressions()]);
}

/** 刷新完成后关闭提示横幅 */
export function dismissReloadNotice(): void {
  remoteDataChanged.set(false);
}

/** 用户确认刷新：重载数据后关闭提示（印谱顺序以 IndexedDB 为准由 liveQuery 重算） */
export async function refreshAfterRemoteChange(): Promise<void> {
  await reloadAllData();
  remoteDataChanged.set(false);
}

/**
 * 安装跨标签页监听（App 初始化数据库成功后调用一次）。
 * 本机写 → 广播；收到其它标签页广播 → 置刷新提示。
 */
export function initCrossTabSync(): void {
  if (initialized) return;
  initialized = true;

  const broadcast = (): void => {
    const payload = tabId;
    try {
      channel?.postMessage(payload);
    } catch {
      /* ignore */
    }
    // BroadcastChannel 不可用时的降级通道（storage 事件不触发本标签页）
    try {
      localStorage.setItem('gbsealcarve:data-rev', JSON.stringify({ tabId, at: Date.now() }));
    } catch {
      /* ignore */
    }
  };

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<string>) => {
      if (event.data && event.data !== tabId) {
        remoteChangedAt.set(Date.now());
        remoteDataChanged.set(true);
      }
    };
  }

  // storage 事件降级：仅其它标签页写入同一 localStorage 键时触发
  window.addEventListener('storage', (event) => {
    if (event.key !== 'gbsealcarve:data-rev' || !event.newValue) return;
    try {
      const parsed = JSON.parse(event.newValue) as { tabId?: string };
      if (parsed.tabId && parsed.tabId !== tabId) {
        remoteChangedAt.set(Date.now());
        remoteDataChanged.set(true);
      }
    } catch {
      /* ignore */
    }
  });

  // 本标签页对业务表的任何写操作提交后广播
  onLocalDataWrite(broadcast);
}
