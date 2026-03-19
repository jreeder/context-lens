<script setup lang="ts">
import { computed } from 'vue'
import { fmtTokens, fmtCost, fmtPct } from '@/utils/format'
import type { WasteAnalysis } from '@/utils/waste'

const props = defineProps<{ waste: WasteAnalysis }>()

const pct = computed(() => Math.round(props.waste.wasteRatio * 100))

const ratingClass = computed(() => {
  const p = pct.value
  if (p >= 60) return 'rate-critical'
  if (p >= 35) return 'rate-high'
  if (p >= 15) return 'rate-med'
  return 'rate-low'
})

const categoryIcons: Record<string, string> = {
  unused_tools:      'i-carbon-tools',
  oversized_results: 'i-carbon-overflow-menu-vertical',
  repeated_system:   'i-carbon-repeat',
  thinking_spill:    'i-carbon-idea',
}
</script>

<template>
  <section class="panel panel--waste" v-if="waste.turnCount > 0 && waste.totalWasteTokens > 0">
    <div class="panel-head">
      <span class="panel-title">Context Waste</span>
      <span class="waste-badge" :class="ratingClass">{{ pct }}% waste</span>
    </div>

    <!-- Summary row -->
    <div class="waste-summary">
      <div class="waste-stat">
        <div class="ws-value" :class="ratingClass">{{ fmtTokens(waste.totalWasteTokens) }}</div>
        <div class="ws-label">wasted tokens</div>
        <div class="ws-detail">of {{ fmtTokens(waste.totalInputTokens) }} input</div>
      </div>
      <div class="waste-stat" v-if="waste.totalWasteCostUsd !== null && waste.totalWasteCostUsd > 0">
        <div class="ws-value" :class="ratingClass">{{ fmtCost(waste.totalWasteCostUsd) }}</div>
        <div class="ws-label">estimated waste cost</div>
        <div class="ws-detail" v-if="waste.totalInputCostUsd">of {{ fmtCost(waste.totalInputCostUsd) }} total</div>
      </div>
      <div class="waste-stat" v-if="waste.compactionCount > 0">
        <div class="ws-value">{{ waste.compactionCount }}</div>
        <div class="ws-label">compaction{{ waste.compactionCount !== 1 ? 's' : '' }}</div>
        <div class="ws-detail">context was reset</div>
      </div>
    </div>

    <!-- Stacked bar showing waste composition -->
    <div class="waste-bar-wrap" v-if="waste.categories.length > 0">
      <div class="waste-bar">
        <div
          v-for="cat in waste.categories"
          :key="cat.id"
          class="waste-bar-seg"
          :class="`seg-${cat.id}`"
          :style="{ width: `${Math.round((cat.tokens / waste.totalInputTokens) * 100)}%` }"
          :title="`${cat.label}: ${fmtTokens(cat.tokens)}`"
        />
        <div
          class="waste-bar-seg seg-useful"
          :style="{ width: `${Math.max(0, 100 - Math.round(waste.wasteRatio * 100))}%` }"
          title="Useful tokens"
        />
      </div>
    </div>

    <!-- Category breakdown -->
    <div class="waste-cats">
      <div v-for="cat in waste.categories" :key="cat.id" class="waste-cat">
        <div class="cat-icon" :class="`${categoryIcons[cat.id] ?? 'i-carbon-warning'} seg-${cat.id}-icon`" />
        <div class="cat-body">
          <div class="cat-name">{{ cat.label }}</div>
          <div class="cat-desc">{{ cat.description }}</div>
        </div>
        <div class="cat-right">
          <div class="cat-tokens" :class="`seg-${cat.id}-text`">{{ fmtTokens(cat.tokens) }}</div>
          <div class="cat-pct">{{ fmtPct(cat.tokens / waste.totalInputTokens) }}</div>
        </div>
      </div>
    </div>

    <!-- Compounding callout -->
    <div class="waste-callout" v-if="waste.turnCount > 2 && pct >= 20">
      <i class="i-carbon-lightning" />
      <p>
        Waste compounds: tokens wasted on early turns are re-paid on every subsequent turn.
        Across {{ waste.turnCount }} turns, a single unused tool definition costs
        {{ waste.turnCount }}× its per-turn size.
      </p>
    </div>
  </section>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.panel {
  @include panel;
}

.panel--waste {
  position: relative;
  border-left: none;

  &::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--accent-amber);
    pointer-events: none;
  }
}

.panel-head {
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-dim);
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.panel-title {
  @include section-label;
}

.waste-badge {
  @include mono-text;
  font-size: var(--text-xs);
  padding: 1px 6px;
  border-radius: var(--radius-sm);

  &.rate-low      { background: rgba(16, 185, 129, 0.1); color: #6ee7b7; }
  &.rate-med      { background: rgba(245, 158, 11, 0.1); color: #fbbf24; }
  &.rate-high     { background: rgba(239, 68, 68, 0.08); color: #fca5a5; }
  &.rate-critical { background: rgba(239, 68, 68, 0.14); color: #ef4444; font-weight: 700; }
}

// Summary stats
.waste-summary {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border-dim);
}

.waste-stat {
  flex: 1;
  padding: var(--space-3) var(--space-4);
  border-right: 1px solid var(--border-dim);
  &:last-child { border-right: none; }
}

.ws-value {
  @include mono-text;
  font-size: var(--text-lg);
  font-weight: 700;
  color: var(--text-primary);

  &.rate-high, &.rate-critical { color: var(--accent-red); }
  &.rate-med { color: var(--accent-amber); }
  &.rate-low { color: var(--accent-green); }
}

.ws-label {
  @include sans-text;
  font-size: var(--text-xs);
  color: var(--text-muted);
  margin-top: 1px;
}

.ws-detail {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-ghost);
  margin-top: 1px;
}

// Stacked bar
.waste-bar-wrap {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-dim);
}

.waste-bar {
  height: 8px;
  border-radius: 4px;
  overflow: hidden;
  background: var(--bg-sunken);
  display: flex;
  gap: 1px;
}

.waste-bar-seg {
  border-radius: 2px;
  transition: width 0.4s ease;
  min-width: 2px;
}

// Category colors
.seg-unused_tools       { background: #f59e0b; }
.seg-oversized_results  { background: #ef4444; }
.seg-repeated_system    { background: #6366f1; }
.seg-thinking_spill     { background: #8b5cf6; }
.seg-useful             { background: var(--border-mid); }

.seg-unused_tools-icon      { color: #f59e0b; }
.seg-oversized_results-icon { color: #ef4444; }
.seg-repeated_system-icon   { color: #6366f1; }
.seg-thinking_spill-icon    { color: #8b5cf6; }

.seg-unused_tools-text      { color: #f59e0b; }
.seg-oversized_results-text { color: #ef4444; }
.seg-repeated_system-text   { color: #6366f1; }
.seg-thinking_spill-text    { color: #8b5cf6; }

// Category list
.waste-cats {
  padding: var(--space-2) var(--space-4);
}

.waste-cat {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border-dim);
  &:last-child { border-bottom: none; padding-bottom: 0; }
  &:first-child { padding-top: 0; }
}

.cat-icon {
  font-size: 14px;
  flex-shrink: 0;
  margin-top: 1px;
}

.cat-body { flex: 1; min-width: 0; }

.cat-name {
  @include sans-text;
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-secondary);
}

.cat-desc {
  @include sans-text;
  font-size: var(--text-xs);
  color: var(--text-muted);
  margin-top: 2px;
  line-height: 1.5;
}

.cat-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  flex-shrink: 0;
  gap: 2px;
}

.cat-tokens {
  @include mono-text;
  font-size: var(--text-sm);
  font-weight: 600;
}

.cat-pct {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--text-muted);
}

// Compounding callout
.waste-callout {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
  padding: var(--space-3) var(--space-4);
  background: rgba(245, 158, 11, 0.04);
  border-top: 1px solid var(--border-dim);

  i {
    color: var(--accent-amber);
    font-size: 14px;
    flex-shrink: 0;
    margin-top: 2px;
  }

  p {
    @include sans-text;
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.6;
    margin: 0;
  }
}
</style>
