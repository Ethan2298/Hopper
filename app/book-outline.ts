import type { EditorView } from "@codemirror/view"
import type { ReaderUnit, UnitProse, BookReaderOutline } from "./prose-types"
import { extractReaderUnits } from "./book-units"

declare global {
  interface Window {
    ai: {
      describeBookOutline: (opts: {
        filename: string
        units: ReaderUnit[]
      }) => Promise<{
        prose?: Record<number, UnitProse>
        error?: string
        fallback?: boolean
      }>
    }
  }
}

const CACHE_VERSION = "v2-book"
const MAX_CONTENT_SIZE = 30_000

const cache = new Map<string, BookReaderOutline>()

async function hashKey(filename: string, content: string): Promise<string> {
  const data = new TextEncoder().encode(CACHE_VERSION + "\0" + filename + "\0" + content)
  const buf = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export interface FetchResult {
  outline?: BookReaderOutline
  error?: string
  truncated?: boolean
  fallback?: boolean
}

/**
 * Extract AST units from the view, ask the LLM for prose per unit,
 * zip them into a BookReaderOutline. Line numbers are ours;
 * the LLM only supplies prose.
 */
export async function fetchBookOutline(
  view: EditorView,
  filename: string,
  content: string
): Promise<FetchResult> {
  const key = await hashKey(filename, content)
  const cached = cache.get(key)
  if (cached) return { outline: cached }

  const truncated = content.length > MAX_CONTENT_SIZE

  const units = extractReaderUnits(view, filename)
  if (units.length === 0) {
    // No recognizable top-level structure — nothing to render.
    const outline: BookReaderOutline = { units: [], prose: {} }
    cache.set(key, outline)
    return { outline, truncated }
  }

  const res = await window.ai.describeBookOutline({ filename, units })
  if (res.error) return { error: res.error, truncated }

  const prose = res.prose || {}
  const outline: BookReaderOutline = { units, prose }
  cache.set(key, outline)
  return { outline, truncated, fallback: res.fallback }
}
