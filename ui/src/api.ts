import type { ApiRequestsResponse, ApiSummaryResponse, ConversationGroup, ContextInfo, TagsResponse } from './api-types'

const BASE = '' // Vite proxy handles /api/* in dev; same-origin in production

export async function fetchRequests(): Promise<ApiRequestsResponse> {
  const res = await fetch(`${BASE}/api/requests`)
  if (!res.ok) throw new Error(`GET /api/requests failed: ${res.status}`)
  return res.json()
}

export async function fetchSummary(): Promise<ApiSummaryResponse> {
  const res = await fetch(`${BASE}/api/requests?summary=true`)
  if (!res.ok) throw new Error(`GET /api/requests?summary=true failed: ${res.status}`)
  return res.json()
}

export async function fetchConversation(id: string): Promise<ConversationGroup> {
  const res = await fetch(`${BASE}/api/conversations/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`GET /api/conversations/${id} failed: ${res.status}`)
  return res.json()
}

export async function fetchEntryDetail(entryId: number): Promise<ContextInfo | null> {
  const res = await fetch(`${BASE}/api/entries/${entryId}/detail`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET /api/entries/${entryId}/detail failed: ${res.status}`)
  const data = await res.json()
  return data.contextInfo ?? null
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`DELETE conversation failed: ${res.status}`)
}

export async function resetAll(): Promise<void> {
  const res = await fetch(`${BASE}/api/reset`, { method: 'POST' })
  if (!res.ok) throw new Error(`POST /api/reset failed: ${res.status}`)
}

export interface ImportSummary {
  source: string
  found: number
  imported: number
  skipped: number
  errors: number
}

export async function scanImport(): Promise<{ summaries: ImportSummary[] }> {
  const res = await fetch(`${BASE}/api/import/scan`, { method: 'POST' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as any).error ?? `POST /api/import/scan failed: ${res.status}`)
  }
  return res.json()
}

export async function pasteRequest(json: string): Promise<{ conversationId: string | null }> {
  let body: unknown
  try {
    body = JSON.parse(json)
  } catch {
    throw new Error('Invalid JSON — paste a raw Anthropic or OpenAI request body')
  }
  const res = await fetch(`${BASE}/api/paste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as any).error ?? `POST /api/paste failed: ${res.status}`)
  }
  return res.json()
}

export type ExportPrivacy = 'minimal' | 'standard' | 'full'

export function getExportUrl(format: 'lhar' | 'lhar.json', conversationId?: string, privacy?: ExportPrivacy): string {
  const params = new URLSearchParams()
  if (conversationId) params.set('conversation', conversationId)
  if (privacy && privacy !== 'standard') params.set('privacy', privacy)
  const qs = params.toString()
  return `${BASE}/api/export/${format}${qs ? `?${qs}` : ''}`
}

// --- contextlens.io upload ---

export interface UploadResult {
  id: string
  url: string
  stats: { total: number; byType: Record<string, number> }
  summary: string
}

const CONTEXTLENS_IO_UPLOAD_URL = 'https://contextlens.io/api/upload'

/**
 * Upload a session's LHAR export to contextlens.io.
 * Returns the shareable URL and redaction summary on success.
 */
export async function uploadToContextlensIo(
  conversationId?: string,
): Promise<UploadResult> {
  // Fetch the LHAR export from the local analysis server.
  const exportUrl = getExportUrl('lhar.json', conversationId, 'standard')
  const exportRes = await fetch(exportUrl)
  if (!exportRes.ok) throw new Error(`Export failed: ${exportRes.status}`)
  const lharBlob = await exportRes.blob()

  // Upload to contextlens.io.
  const form = new FormData()
  form.append('file', lharBlob, conversationId ? `session-${conversationId}.lhar.json` : 'export.lhar.json')

  const uploadRes = await fetch(CONTEXTLENS_IO_UPLOAD_URL, {
    method: 'POST',
    body: form,
  })

  if (!uploadRes.ok) {
    const err = await uploadRes.json().catch(() => ({ error: uploadRes.statusText })) as { error?: string }
    throw new Error(err.error ?? `Upload failed: ${uploadRes.status}`)
  }

  return uploadRes.json() as Promise<UploadResult>
}

// --- Tags ---

export async function fetchTags(): Promise<TagsResponse> {
  const res = await fetch(`${BASE}/api/tags`)
  if (!res.ok) throw new Error(`GET /api/tags failed: ${res.status}`)
  return res.json()
}

export async function setSessionTags(conversationId: string, tags: string[]): Promise<string[]> {
  const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(conversationId)}/tags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags }),
  })
  if (!res.ok) throw new Error(`PATCH tags failed: ${res.status}`)
  const data = await res.json()
  return data.tags
}

export async function addSessionTag(conversationId: string, tag: string): Promise<string[]> {
  const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(conversationId)}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag }),
  })
  if (!res.ok) throw new Error(`POST tag failed: ${res.status}`)
  const data = await res.json()
  return data.tags
}

export async function removeSessionTag(conversationId: string, tag: string): Promise<string[]> {
  const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(conversationId)}/tags/${encodeURIComponent(tag)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`DELETE tag failed: ${res.status}`)
  const data = await res.json()
  return data.tags
}

export async function pruneMessage(conversationId: string, messageId: string): Promise<string[]> {
  const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(conversationId)}/prunes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId }),
  })
  if (!res.ok) throw new Error(`POST prune failed: ${res.status}`)
  const data = await res.json()
  return data.prunedMessages
}

