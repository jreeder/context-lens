/**
 * Client-side context window waste analysis.
 *
 * Mirrors the logic in src/core/waste.ts but operates on the API types
 * available in the UI (ProjectedEntry from api-types.ts).
 */

import type { CompositionEntry, ProjectedEntry } from '@/api-types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WasteCategory {
  id: 'unused_tools' | 'oversized_results' | 'repeated_system' | 'thinking_spill'
  label: string
  tokens: number
  costUsd: number | null
  perTurn: Array<[number, number]>
  description: string
}

export interface WasteAnalysis {
  totalInputTokens: number
  totalInputCostUsd: number | null
  totalWasteTokens: number
  totalWasteCostUsd: number | null
  wasteRatio: number
  categories: WasteCategory[]
  unusedToolNames: string[]
  turnCount: number
  compactionCount: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OVERSIZED_RESULT_THRESHOLD = 8_000
const THINKING_SPILL_THRESHOLD = 0.4

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function catTokens(composition: CompositionEntry[], cat: CompositionEntry['category']): number {
  return composition.find((c) => c.category === cat)?.tokens ?? 0
}

function totalTokens(composition: CompositionEntry[]): number {
  return composition.reduce((s, c) => s + c.tokens, 0)
}

function isSuccess(e: ProjectedEntry): boolean {
  return e.httpStatus === null || (e.httpStatus >= 200 && e.httpStatus < 300)
}

function definedTools(e: ProjectedEntry): Set<string> {
  const names = new Set<string>()
  for (const t of e.contextInfo.tools ?? []) {
    const tool = t as unknown as Record<string, unknown>
    const name =
      typeof tool.name === 'string'
        ? tool.name
        : typeof (tool.function as Record<string, unknown>)?.name === 'string'
          ? (tool.function as Record<string, unknown>).name as string
          : null
    if (name) names.add(name)
  }
  return names
}

function calledTools(e: ProjectedEntry): Set<string> {
  const names = new Set<string>()
  for (const m of e.contextInfo.messages ?? []) {
    if (!m.contentBlocks) continue
    for (const b of m.contentBlocks) {
      const block = b as unknown as Record<string, unknown>
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        names.add(block.name)
      }
    }
  }
  return names
}

// ---------------------------------------------------------------------------
// Per-category analysers
// ---------------------------------------------------------------------------

function analyseUnusedTools(
  entries: ProjectedEntry[],
  sessionCalled: Set<string>,
): { perTurn: Array<[number, number]>; unusedNames: string[] } {
  const perTurn: Array<[number, number]> = []
  let unusedNames: string[] = []
  let namesComputed = false

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const defined = definedTools(e)
    if (defined.size === 0) { perTurn.push([i, 0]); continue }

    const unused = [...defined].filter((n) => !sessionCalled.has(n))
    if (!namesComputed) { unusedNames = unused; namesComputed = true }

    const unusedFraction = unused.length / defined.size
    const defTokens = catTokens(e.composition, 'tool_definitions')
    perTurn.push([i, Math.round(defTokens * unusedFraction)])
  }

  return { perTurn, unusedNames }
}

function analyseOversized(entries: ProjectedEntry[]): Array<[number, number]> {
  return entries.map((e, i) => {
    const rt = catTokens(e.composition, 'tool_results')
    return [i, Math.max(0, rt - OVERSIZED_RESULT_THRESHOLD)] as [number, number]
  })
}

function analyseRepeatedSystem(entries: ProjectedEntry[]): Array<[number, number]> {
  return entries.map((e, i) => {
    if (i === 0) return [i, 0] as [number, number]
    const sys =
      catTokens(e.composition, 'system_prompt') +
      catTokens(e.composition, 'system_injections')
    return [i, sys] as [number, number]
  })
}

function analyseThinkingSpill(entries: ProjectedEntry[]): Array<[number, number]> {
  return entries.map((e, i) => {
    const total = totalTokens(e.composition)
    if (total === 0) return [i, 0] as [number, number]
    const think = catTokens(e.composition, 'thinking')
    const frac = think / total
    if (frac <= THINKING_SPILL_THRESHOLD) return [i, 0] as [number, number]
    return [i, Math.round(think - total * THINKING_SPILL_THRESHOLD)] as [number, number]
  })
}

// Very rough cost estimate: assume $3/M input (Sonnet-class as baseline).
// Real cost is already in entry.costUsd; this is only for waste-token pricing.
function roughCostForTokens(tokens: number, model: string): number {
  // Cheap heuristic: try to infer price tier from model name
  let pricePerM = 3.0 // Sonnet default
  if (model.includes('haiku')) pricePerM = 0.8
  else if (model.includes('opus')) pricePerM = 15
  else if (model.includes('gpt-4o-mini')) pricePerM = 0.15
  else if (model.includes('gpt-4o') || model.includes('gpt-4.1')) pricePerM = 2.5
  else if (model.includes('gemini-2.5-pro')) pricePerM = 1.25
  else if (model.includes('gemini-2.5-flash') || model.includes('gemini-2.0-flash')) pricePerM = 0.3
  return Math.round((tokens / 1_000_000) * pricePerM * 1_000_000) / 1_000_000
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function computeWasteAnalysis(entries: ProjectedEntry[]): WasteAnalysis {
  const good = entries.filter(isSuccess)

  if (good.length === 0) {
    return {
      totalInputTokens: 0, totalInputCostUsd: null,
      totalWasteTokens: 0, totalWasteCostUsd: null,
      wasteRatio: 0, categories: [], unusedToolNames: [],
      turnCount: 0, compactionCount: 0,
    }
  }

  // Compaction detection
  let compactionCount = 0
  for (let i = 1; i < good.length; i++) {
    const prev = totalTokens(good[i - 1].composition)
    const cur = totalTokens(good[i].composition)
    if (prev > 0 && cur < prev * 0.7) compactionCount++
  }

  // Session-wide called tools
  const sessionCalled = new Set<string>()
  for (const e of good) for (const n of calledTools(e)) sessionCalled.add(n)

  // Total billed input tokens + cost
  let totalInputTokens = 0
  let totalInputCostUsd: number | null = 0
  const model = good[0].contextInfo.model
  for (const e of good) {
    totalInputTokens += e.usage?.inputTokens ?? e.contextInfo.totalTokens
    if (e.costUsd !== null && totalInputCostUsd !== null) totalInputCostUsd += e.costUsd
    else if (e.costUsd === null) totalInputCostUsd = null
  }

  // Per-category analysis
  const { perTurn: unusedPerTurn, unusedNames } = analyseUnusedTools(good, sessionCalled)
  const oversizedPerTurn = analyseOversized(good)
  const systemPerTurn = analyseRepeatedSystem(good)
  const thinkingPerTurn = analyseThinkingSpill(good)

  function buildCat(
    id: WasteCategory['id'],
    label: string,
    description: string,
    perTurn: Array<[number, number]>,
  ): WasteCategory {
    const tokens = perTurn.reduce((s, [, t]) => s + t, 0)
    const costUsd = tokens > 0 ? roughCostForTokens(tokens, model) : 0
    return { id, label, description, tokens, costUsd, perTurn }
  }

  const categories: WasteCategory[] = [
    buildCat(
      'unused_tools',
      'Unused tool definitions',
      `Tool definitions carried on every turn but never called. ${unusedNames.length > 0 ? `Never called: ${unusedNames.slice(0, 5).join(', ')}${unusedNames.length > 5 ? ` +${unusedNames.length - 5} more` : ''}.` : ''}`,
      unusedPerTurn,
    ),
    buildCat(
      'oversized_results',
      'Oversized tool results',
      `Tool results over ${Math.round(OVERSIZED_RESULT_THRESHOLD / 1000)}K tokens — file dumps or large outputs that could be trimmed.`,
      oversizedPerTurn,
    ),
    buildCat(
      'repeated_system',
      'Repeated system prompt',
      'System prompt re-sent on every turn after the first. Structural overhead, but quantified here.',
      systemPerTurn,
    ),
    buildCat(
      'thinking_spill',
      'Excess thinking tokens',
      `Thinking tokens above ${THINKING_SPILL_THRESHOLD * 100}% of context — marginal value unclear at this ratio.`,
      thinkingPerTurn,
    ),
  ].filter((c) => c.tokens > 0)

  const totalWasteTokens = categories.reduce((s, c) => s + c.tokens, 0)
  const totalWasteCostUsd: number | null = categories.reduce<number | null>((s, c) => {
    if (s === null || c.costUsd === null) return null
    return s + c.costUsd
  }, 0)

  return {
    totalInputTokens,
    totalInputCostUsd,
    totalWasteTokens,
    totalWasteCostUsd,
    wasteRatio: totalInputTokens > 0 ? totalWasteTokens / totalInputTokens : 0,
    categories,
    unusedToolNames: unusedNames,
    turnCount: good.length,
    compactionCount,
  }
}
