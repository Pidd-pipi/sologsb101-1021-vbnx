/**
 * useTabGuard：多标签页编辑守卫的 Svelte 响应式封装
 * 另一个标签页保存数据时，externalWrite 变为 true，页面提示「请先刷新」。
 */
import { onDestroy, onMount } from 'svelte';
import { writable, type Readable } from 'svelte/store';
import { tabGuard, type EditLease } from '$lib/utils/tabGuard';

export interface UseTabGuardResult {
  /** 是否检测到其他标签页写入 */
  externalWrite: Readable<boolean>;
  /** 最近一次外部写入摘要 */
  externalLease: Readable<EditLease | null>;
  /** 清除标记（用户选择继续） */
  clear: () => void;
}

export function useTabGuard(): UseTabGuardResult {
  const externalWrite = writable(false);
  const externalLease = writable<EditLease | null>(null);

  let stop: (() => void) | null = null;

  onMount(() => {
    stop = tabGuard.subscribe((lease) => {
      externalLease.set(lease);
      externalWrite.set(true);
    });
  });

  onDestroy(() => stop?.());

  return {
    externalWrite,
    externalLease,
    clear: () => {
      tabGuard.clearExternalWrite();
      externalWrite.set(false);
      externalLease.set(null);
    },
  };
}

export default useTabGuard;
