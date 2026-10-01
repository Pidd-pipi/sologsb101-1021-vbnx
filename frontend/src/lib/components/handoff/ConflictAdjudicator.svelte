<script lang="ts">
  /**
   * <ConflictAdjudicator> 印石 / 印稿信息冲突裁决
   * 逐字段对比本地与包内值，选择保留哪一边；支持一键全选本地 / 全选包内。
   */
  import { fieldDisplayValue, setAllFieldChoices, setFieldChoice } from '$lib/stores/handoffStore';
  import type { MergeChange } from '$lib/types/batch';

  interface Props {
    change: MergeChange;
  }

  let { change }: Props = $props();

  const changeKey = $derived(`${change.table}:${change.recordId}`);
  const fields = $derived(change.fieldConflicts ?? []);
</script>

<div class="mt-2 rounded-lg border border-seal/30 bg-seal/5 p-3">
  <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
    <span class="text-xs font-medium text-seal">信息冲突，请逐字段裁决保留哪一边</span>
    <div class="flex gap-1">
      <button
        type="button"
        class="rounded border border-line px-2 py-0.5 text-xs text-ink-soft hover:bg-black/5"
        onclick={() => setAllFieldChoices(changeKey, 'local')}
      >
        全选本地
      </button>
      <button
        type="button"
        class="rounded border border-line px-2 py-0.5 text-xs text-ink-soft hover:bg-black/5"
        onclick={() => setAllFieldChoices(changeKey, 'remote')}
      >
        全选包内
      </button>
    </div>
  </div>
  <div class="space-y-1.5">
    {#each fields as fc (fc.field)}
      <div class="grid grid-cols-[80px_1fr_1fr] items-center gap-2 text-xs">
        <span class="text-ink-soft">{fc.fieldLabel}</span>
        <button
          type="button"
          class="rounded border px-2 py-1 text-left transition {fc.choice === 'local'
            ? 'border-jade bg-jade/10 text-jade'
            : 'border-line text-ink hover:bg-black/5'}"
          onclick={() => setFieldChoice(changeKey, fc.field, 'local')}
        >
          <span class="mr-1 opacity-60">本地</span>{fieldDisplayValue(fc, 'local')}
        </button>
        <button
          type="button"
          class="rounded border px-2 py-1 text-left transition {fc.choice === 'remote'
            ? 'border-seal bg-seal/10 text-seal'
            : 'border-line text-ink hover:bg-black/5'}"
          onclick={() => setFieldChoice(changeKey, fc.field, 'remote')}
        >
          <span class="mr-1 opacity-60">包内</span>{fieldDisplayValue(fc, 'remote')}
        </button>
      </div>
    {/each}
  </div>
</div>
