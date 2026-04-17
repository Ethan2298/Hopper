import type { EditorState } from "@codemirror/state"
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

const CACHE_VERSION = "v5-imperative"

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
  fallback?: boolean
}

/**
 * Extract AST units from the state, ask the LLM for prose per unit,
 * zip them into a BookReaderOutline. Line numbers are ours;
 * the LLM only supplies prose.
 */
export async function fetchBookOutline(
  state: EditorState,
  filename: string,
  content: string
): Promise<FetchResult> {
  const key = await hashKey(filename, content)
  const cached = cache.get(key)
  if (cached) return { outline: cached }

  const units = extractReaderUnits(state, filename)
  if (units.length === 0) {
    const outline: BookReaderOutline = { units: [], prose: {} }
    cache.set(key, outline)
    return { outline }
  }

  const res = await window.ai.describeBookOutline({ filename, units })
  if (res.error) return { error: res.error }

  const prose = res.prose || {}
  const outline: BookReaderOutline = { units, prose }
  cache.set(key, outline)
  return { outline, fallback: res.fallback }
}
