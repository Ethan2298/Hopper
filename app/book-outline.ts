import type { BookOutline } from "./prose-types"
import { validateBookOutline } from "./book-outline-validate"

declare global {
  interface Window {
    ai: {
      describeBookOutline: (opts: {
        filename: string
        fileContent: string
      }) => Promise<{
        outline?: BookOutline
        error?: string
        truncated?: boolean
        fallback?: boolean
        errors?: string[]
      }>
    }
  }
}

const CACHE_VERSION = "v1-book"
const MAX_CONTENT_SIZE = 30_000

const cache = new Map<string, BookOutline>()

async function hashKey(filename: string, content: string): Promise<string> {
  const data = new TextEncoder().encode(CACHE_VERSION + "\0" + filename + "\0" + content)
  const buf = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export interface FetchResult {
  outline?: BookOutline
  error?: string
  truncated?: boolean
  fallback?: boolean
}

export async function fetchBookOutline(
  filename: string,
  content: string
): Promise<FetchResult> {
  const key = await hashKey(filename, content)
  const cached = cache.get(key)
  if (cached) return { outline: cached }

  let fileContent = content
  let truncated = false
  if (fileContent.length > MAX_CONTENT_SIZE) {
    fileContent = fileContent.slice(0, MAX_CONTENT_SIZE)
    truncated = true
  }

  const res = await window.ai.describeBookOutline({ filename, fileContent })
  if (res.error) return { error: res.error, truncated: truncated || res.truncated }
  if (!res.outline) return { error: "Empty outline response" }

  // Defensive revalidation on client (catches stale cache across schema bumps).
  const lineCount = fileContent.split("\n").length
  const v = validateBookOutline(res.outline, lineCount)
  if (!v.ok && !res.fallback) {
    // Main process should have retried; if still invalid, surface error.
    return { error: `Invalid outline: ${v.errors[0]}` }
  }

  cache.set(key, res.outline)
  return {
    outline: res.outline,
    truncated: truncated || res.truncated,
    fallback: res.fallback,
  }
}
