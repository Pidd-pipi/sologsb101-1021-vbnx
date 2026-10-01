<script lang="ts">
  /**
   * 离线交接 · 冲突裁决列表
   * 展示双方都改过的记录（印石信息冲突必须逐项裁决），字段级对比本机/对方取值。
   */
  import {
    TABLE_LABEL,
    diffFields,
    rowTitle,
    designTextOf,
    buildRowContext,
    type RowContext,
  } from '$lib/utils/handoffView';
  import { fieldOf, type ConflictItem, type ConflictResolution, type LocalData } from '$lib/utils/sync';

  interface Props {
    conflicts: ConflictItem[];
    local: LocalData;
    resolutions: Record<string, ConflictResolution>;
    machineName: string;
  }

  let { conflicts, local, resolutions, machineName }: Props = $props();

  const context: RowContext = $derived(buildRowContext(local));

  const REASON_TEXT: Record<string, string> = {
    'both-modified': '两边都改过',
    'local-modified-remote-withdrawn': '本机改过 · 对方撤回',
    'local-withdrawn-remote-modified': '本机撤回 · 对方改过',
  };

  function reasonText(reason: string): string {
    return REASON_TEXT[reason] ?? reason;
  }

  function choose(id: string, resolution: ConflictResolution): void {
    // 父组件以 $state 代理对象传入，直接改字段即响应式（Svelte 5 深响应）
    resolutions[id] = resolution;
  }
</script>

<div class="space-y-3">
  {#each conflicts as conflict (conflict.table + conflict.id)}
    {@const diffs = diffFields(conflict.table, conflict.local, conflict.incoming)}
    {@const chosen = resolutions[conflict.id] ?? conflict.resolution}
    {@const isStone = conflict.table === 'stones'}
    {@const parentDesign =
      conflict.table === 'carves' || conflict.table === 'impressions' || conflict.table === 'catalogs'
        ? designTextOf(context, fieldOf(conflict.local, 'designId') ?? fieldOf(conflict.incoming, 'designId'))
        : ''}
    <section
      class="rounded-xl border p-3 {isStone
        ? 'border-seal/50 bg-seal/[0.04]'
        : 'border-amber/40 bg-amber/[0.06]'}"
    >
      <header class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span class="rounded bg-ink/10 px-1.5 py-0.5 text-xs text-ink-soft">{TABLE_LABEL[conflict.table]}</span>
          <span class="ml-2 text-sm font-medium text-ink">
            {rowTitle(conflict.table, conflict.incoming.withdrawn ? conflict.local : conflict.incoming)}
          </span>
          {#if parentDesign}<span class="ml-2 text-xs text-ink-soft">印稿：{parentDesign}</span>{/if}
        </div>
        <span class="text-xs {isStone ? 'text-seal' : 'text-amber'}">{reasonText(conflict.reason)}</span>
      </header>

      {#if diffs.length > 0}
        <div class="mt-2 overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr class="text-ink-soft">
                <th class="w-24 px-2 py-1 text-left font-normal">字段</th>
                <th class="px-2 py-1 text-left font-normal">本机</th>
                <th class="px-2 py-1 text-left font-normal">{machineName}（对方）</th>
              </tr>
            </thead>
            <tbody>
              {#each diffs as diff (diff.field)}
                <tr class="border-t border-line/60">
                  <td class="px-2 py-1 text-ink-soft">{diff.label}</td>
                  <td class="px-2 py-1 {chosen === 'local' ? 'font-medium text-jade' : 'text-ink'}">{diff.local}</td>
                  <td class="px-2 py-1 {chosen === 'incoming' ? 'font-medium text-seal' : 'text-ink'}">
                    {diff.incoming}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="mt-2 text-xs text-ink-soft">
          {conflict.incoming.withdrawn
            ? `对方撤回了该${TABLE_LABEL[conflict.table]}，但本机做过修改。`
            : '两边业务字段相同，仅同步状态不同。'}
        </p>
      {/if}

      <div class="mt-2 flex flex-wrap gap-4 text-sm">
        <label class="flex cursor-pointer items-center gap-1.5">
          <input
            type="radio"
            name={`conflict-${conflict.table}-${conflict.id}`}
            checked={chosen === 'local'}
            onchange={() => choose(conflict.id, 'local')}
          />
          <span class={chosen === 'local' ? 'text-jade' : ''}>保留本机</span>
        </label>
        <label class="flex cursor-pointer items-center gap-1.5">
          <input
            type="radio"
            name={`conflict-${conflict.table}-${conflict.id}`}
            checked={chosen === 'incoming'}
            onchange={() => choose(conflict.id, 'incoming')}
          />
          <span class={chosen === 'incoming' ? 'text-seal' : ''}>采用对方（{machineName}）</span>
        </label>
        {#if isStone}
          <span class="text-xs text-seal">印石信息冲突需逐项裁决后方可生效</span>
        {/if}
      </div>
    </section>
  {/each}
</div>
