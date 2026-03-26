/**
 * Stable message identity for context pruning.
 *
 * Must match the logic in src/proxy/prune.ts exactly, because the proxy
 * uses these IDs to filter outgoing requests and the UI uses them to
 * mark messages as pruned.
 *
 * Identity scheme:
 * - tool_result → "tool_result:{tool_use_id}" (API-assigned, unique)
 * - tool_use    → "tool_use:{id}" (API-assigned, unique)
 * - everything  → "{role}:{index}" (position in messages array, stable
 *                  because old messages never move)
 */

import type { ParsedMessage } from '@/api-types'

/** Derive a stable ID for a message at a given index. */
export function messageIdAt(msg: ParsedMessage, index: number): string {
  if (msg.contentBlocks) {
    for (const block of msg.contentBlocks) {
      const b = block as unknown as Record<string, unknown>
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        return `tool_result:${b.tool_use_id}`
      }
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        return `tool_use:${b.id}`
      }
    }
  }
  return `${msg.role ?? 'unknown'}:${index}`
}

/** Check if a message at a given index is in the pruned set. */
export function isPrunedAt(msg: ParsedMessage, index: number, prunedMessages: string[]): boolean {
  if (prunedMessages.length === 0) return false
  return prunedMessages.includes(messageIdAt(msg, index))
}
