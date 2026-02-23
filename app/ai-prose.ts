declare global {
  interface Window {
    ai: {
      describe: (opts: {
        filename: string
        fileContent: string
        projectFiles: string[]
        outline?: string
      }) => Promise<{ text?: string; error?: string }>
    }
  }
}

const cache = new Map<string, string>()

const CACHE_VERSION = "v5-prose"

async function hashKey(filename: string, content: string): Promise<string> {
  const data = new TextEncoder().encode(CACHE_VERSION + "\0" + filename + "\0" + content)
  const buf = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

const MAX_CONTENT_SIZE = 30_000

export async function describeFile(
  filename: string,
  content: string,
  projectFiles: string[],
  outline: string = ""
): Promise<{ text?: string; error?: string; truncated?: boolean }> {
  const key = await hashKey(filename, content)

  const cached = cache.get(key)
  if (cached) return { text: cached }

  let fileContent = content
  let truncated = false
  if (fileContent.length > MAX_CONTENT_SIZE) {
    fileContent = fileContent.slice(0, MAX_CONTENT_SIZE)
    truncated = true
  }

  const result = await window.ai.describe({ filename, fileContent, projectFiles, outline })

  if (result.text) {
    cache.set(key, result.text)
  }

  return { ...result, truncated }
}
