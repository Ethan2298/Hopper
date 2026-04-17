import { EditorView } from "@codemirror/view"
import { Compartment } from "@codemirror/state"

export type ThemeSetting = "light" | "dark" | "system"
export type ResolvedTheme = "light" | "dark"

let currentSetting: ThemeSetting = "system"
let editorViewRef: EditorView | null = null

export const themeCompartment = new Compartment()

// --- Resolve theme ---

export function getResolvedTheme(): ResolvedTheme {
  if (currentSetting === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  }
  return currentSetting
}

function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.dataset.theme = resolved
  if (editorViewRef) {
    editorViewRef.dispatch({
      effects: themeCompartment.reconfigure(getEditorTheme(resolved)),
    })
  }
}

// --- Init ---

export function initTheme() {
  const stored = localStorage.getItem("hopper-theme") as ThemeSetting | null
  currentSetting = stored || "system"
  applyTheme(getResolvedTheme())

  // Listen for OS theme changes when in system mode
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentSetting === "system") {
      applyTheme(getResolvedTheme())
    }
  })

  // Listen for IPC theme changes from native menu
  if (window.theme) {
    window.theme.onChange((setting: ThemeSetting) => {
      setTheme(setting)
    })
  }
}

export function setTheme(setting: ThemeSetting) {
  currentSetting = setting
  localStorage.setItem("hopper-theme", setting)
  applyTheme(getResolvedTheme())
}

export function setEditorView(view: EditorView) {
  editorViewRef = view
}

// --- CodeMirror themes ---

const inkLight = EditorView.theme(
  {
    "&": { backgroundColor: "#ffffff", color: "#0d0d0d" },
    ".cm-content": { caretColor: "#0d0d0d" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#0d0d0d" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "#cfe3f7",
    },
    ".cm-panels": { backgroundColor: "#f7f7f7", color: "#0d0d0d" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid #e5e5e5" },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid #e5e5e5" },
    ".cm-searchMatch": { backgroundColor: "#d9ebff", outline: "1px solid #b4d4f7" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#b4d4f7" },
    ".cm-activeLine": { backgroundColor: "#f0f0f008" },
    ".cm-selectionMatch": { backgroundColor: "#e5efff" },
    "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
      backgroundColor: "#e5e5e5",
    },
    ".cm-gutters": { backgroundColor: "#f7f7f7", color: "#737373", borderRight: "1px solid #e5e5e5" },
    ".cm-activeLineGutter": { backgroundColor: "#ececec" },
    ".cm-foldPlaceholder": { backgroundColor: "transparent", border: "none", color: "#737373" },
    ".cm-tooltip": { border: "1px solid #e5e5e5", backgroundColor: "#f7f7f7" },
    ".cm-tooltip .cm-tooltip-arrow:before": { borderTopColor: "transparent", borderBottomColor: "transparent" },
    ".cm-tooltip .cm-tooltip-arrow:after": { borderTopColor: "#f7f7f7", borderBottomColor: "#f7f7f7" },
    ".cm-tooltip-autocomplete": { "& > ul > li[aria-selected]": { backgroundColor: "#ececec", color: "#0d0d0d" } },
  },
  { dark: false }
)

const inkDark = EditorView.theme(
  {
    "&": { backgroundColor: "#111111", color: "#fcfcfc" },
    ".cm-content": { caretColor: "#fcfcfc" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#fcfcfc" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "#14365c",
    },
    ".cm-panels": { backgroundColor: "#0d0d0d", color: "#fcfcfc" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid #1f1f1f" },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid #1f1f1f" },
    ".cm-searchMatch": { backgroundColor: "#0f2a47", outline: "1px solid #184a7a" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#184a7a" },
    ".cm-activeLine": { backgroundColor: "#1a1a1a08" },
    ".cm-selectionMatch": { backgroundColor: "#0f2a47" },
    "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
      backgroundColor: "#1f1f1f",
    },
    ".cm-gutters": { backgroundColor: "#0d0d0d", color: "#737373", borderRight: "1px solid #1f1f1f" },
    ".cm-activeLineGutter": { backgroundColor: "#1a1a1a" },
    ".cm-foldPlaceholder": { backgroundColor: "transparent", border: "none", color: "#737373" },
    ".cm-tooltip": { border: "1px solid #1f1f1f", backgroundColor: "#0d0d0d" },
    ".cm-tooltip .cm-tooltip-arrow:before": { borderTopColor: "transparent", borderBottomColor: "transparent" },
    ".cm-tooltip .cm-tooltip-arrow:after": { borderTopColor: "#0d0d0d", borderBottomColor: "#0d0d0d" },
    ".cm-tooltip-autocomplete": { "& > ul > li[aria-selected]": { backgroundColor: "#1a1a1a", color: "#fcfcfc" } },
  },
  { dark: true }
)

export function getEditorTheme(resolved: ResolvedTheme) {
  return resolved === "light" ? inkLight : inkDark
}

// --- File-type icons ---

export function fileIcon(filename: string, isDir: boolean, isOpen?: boolean): string {
  if (isDir) {
    if (isOpen) {
      // Lucide "folder-open" icon
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--folder-icon)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>`
    }
    // Lucide "folder" icon
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--folder-icon)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`
  }

  const ext = filename.includes(".") ? "." + filename.split(".").pop()!.toLowerCase() : ""

  // Also check full filename for dotfiles and special names
  const name = filename.toLowerCase()

  // Special named files
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return badge("DK", "#2496ed", "#fff")
  if (name === "makefile" || name === "gnumakefile") return badge("MK", "#6d8086", "#fff")
  if (name === ".gitignore" || name === ".gitattributes" || name === ".gitmodules") return badge("GI", "#f05032", "#fff")
  if (name === ".env" || name.startsWith(".env.")) return badge("EN", "#ecd53f", "#1a1a18")
  if (name === "license" || name === "licence" || name === "license.md" || name === "licence.md") return badge("LI", "#6d8086", "#fff")

  switch (ext) {
    // JavaScript / TypeScript
    case ".ts":
    case ".tsx":
      return badge("TS", "#3178c6", "#fff")
    case ".js":
    case ".jsx":
      return badge("JS", "#e8d44d", "#1a1a18")
    case ".mjs":
    case ".cjs":
      return badge("JS", "#e8d44d", "#1a1a18")
    case ".d.ts":
      return badge("DT", "#3178c6", "#fff")

    // Web
    case ".html":
    case ".htm":
      return badge("HT", "#e34c26", "#fff")
    case ".css":
      return badge("CS", "#264de4", "#fff")
    case ".scss":
      return badge("SC", "#c6538c", "#fff")
    case ".sass":
      return badge("SA", "#c6538c", "#fff")
    case ".less":
      return badge("LE", "#1d365d", "#fff")
    case ".styl":
    case ".stylus":
      return badge("ST", "#333", "#fff")

    // Frameworks
    case ".svelte":
      return badge("SV", "#ff3e00", "#fff")
    case ".vue":
      return badge("VU", "#42b883", "#fff")
    case ".astro":
      return badge("AS", "#ff5d01", "#fff")
    case ".angular":
      return badge("NG", "#dd0031", "#fff")

    // Data / Config
    case ".json":
      return badge("JS", "#6d8086", "#fff")
    case ".jsonc":
      return badge("JC", "#6d8086", "#fff")
    case ".yaml":
    case ".yml":
      return badge("YM", "#cb171e", "#fff")
    case ".toml":
      return badge("TM", "#9c4121", "#fff")
    case ".xml":
      return badge("XM", "#e37933", "#fff")
    case ".csv":
      return badge("CV", "#237346", "#fff")
    case ".ini":
    case ".cfg":
    case ".conf":
      return badge("CF", "#6d8086", "#fff")
    case ".env":
      return badge("EN", "#ecd53f", "#1a1a18")

    // Systems languages
    case ".py":
      return badge("PY", "#3572a5", "#fff")
    case ".rs":
      return badge("RS", "#de5722", "#fff")
    case ".go":
      return badge("GO", "#00add8", "#fff")
    case ".c":
      return badge("C", "#555555", "#fff")
    case ".h":
      return badge("H", "#555555", "#fff")
    case ".cpp":
    case ".cc":
    case ".cxx":
      return badge("C+", "#f34b7d", "#fff")
    case ".hpp":
    case ".hh":
    case ".hxx":
      return badge("H+", "#f34b7d", "#fff")
    case ".cs":
      return badge("C#", "#178600", "#fff")
    case ".java":
      return badge("JA", "#b07219", "#fff")
    case ".kt":
    case ".kts":
      return badge("KT", "#a97bff", "#fff")
    case ".scala":
      return badge("SC", "#c22d40", "#fff")
    case ".swift":
      return badge("SW", "#f05138", "#fff")
    case ".m":
    case ".mm":
      return badge("OC", "#438eff", "#fff")
    case ".zig":
      return badge("ZG", "#f7a41d", "#1a1a18")
    case ".nim":
      return badge("NM", "#ffe953", "#1a1a18")
    case ".v":
      return badge("V", "#5d87bf", "#fff")
    case ".odin":
      return badge("OD", "#60b5cc", "#fff")

    // Scripting
    case ".rb":
      return badge("RB", "#cc342d", "#fff")
    case ".php":
      return badge("PH", "#4f5d95", "#fff")
    case ".pl":
    case ".pm":
      return badge("PL", "#0298c3", "#fff")
    case ".lua":
      return badge("LU", "#000080", "#fff")
    case ".r":
    case ".rmd":
      return badge("R", "#276dc3", "#fff")
    case ".jl":
      return badge("JL", "#9558b2", "#fff")
    case ".ex":
    case ".exs":
      return badge("EX", "#6e4a7e", "#fff")
    case ".erl":
    case ".hrl":
      return badge("ER", "#b83998", "#fff")
    case ".clj":
    case ".cljs":
    case ".cljc":
      return badge("CL", "#63b132", "#fff")
    case ".hs":
    case ".lhs":
      return badge("HS", "#5e5086", "#fff")
    case ".ml":
    case ".mli":
      return badge("ML", "#e98407", "#fff")
    case ".fs":
    case ".fsx":
      return badge("F#", "#b845fc", "#fff")
    case ".dart":
      return badge("DA", "#00b4ab", "#fff")

    // Shell
    case ".sh":
    case ".bash":
    case ".zsh":
    case ".fish":
      return badge("SH", "#4eaa25", "#fff")
    case ".ps1":
    case ".psm1":
      return badge("PS", "#012456", "#fff")
    case ".bat":
    case ".cmd":
      return badge("BT", "#c1f12e", "#1a1a18")

    // Markup / Docs
    case ".md":
    case ".mdx":
      return badge("MD", "#6d8086", "#fff")
    case ".tex":
    case ".latex":
      return badge("TX", "#008080", "#fff")
    case ".rst":
      return badge("RS", "#141414", "#fff")
    case ".adoc":
      return badge("AD", "#e40046", "#fff")
    case ".txt":
      return badge("TX", "#6d8086", "#fff")

    // DevOps / Infra
    case ".tf":
    case ".tfvars":
      return badge("TF", "#7b42bc", "#fff")
    case ".hcl":
      return badge("HC", "#7b42bc", "#fff")
    case ".nix":
      return badge("NX", "#5277c3", "#fff")

    // Database
    case ".sql":
      return badge("SQ", "#e38c00", "#fff")
    case ".prisma":
      return badge("PR", "#2d3748", "#fff")
    case ".graphql":
    case ".gql":
      return badge("GQ", "#e535ab", "#fff")

    // Build / Package
    case ".lock":
      return badge("LK", "#6d8086", "#fff")
    case ".gradle":
      return badge("GR", "#02303a", "#fff")

    // Wasm
    case ".wasm":
    case ".wat":
      return badge("WA", "#654ff0", "#fff")

    // Images
    case ".svg":
      return badge("SV", "#ffb13b", "#1a1a18")
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".webp":
    case ".bmp":
    case ".ico":
      return badge("IM", "#a074c4", "#fff")

    // Fonts
    case ".ttf":
    case ".otf":
    case ".woff":
    case ".woff2":
      return badge("FN", "#6d8086", "#fff")

    // Archives
    case ".zip":
    case ".tar":
    case ".gz":
    case ".bz2":
    case ".xz":
    case ".7z":
    case ".rar":
      return badge("ZP", "#6d8086", "#fff")

    // Binary / Compiled
    case ".exe":
    case ".dll":
    case ".so":
    case ".dylib":
      return badge("BN", "#6d8086", "#fff")

    // Testing
    case ".test.ts":
    case ".test.js":
    case ".spec.ts":
    case ".spec.js":
      return badge("TE", "#15c213", "#fff")

    default:
      return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 1h5l3 3v8H3V1z" stroke="var(--muted)" stroke-width="1.2" fill="none"/><path d="M8 1v3h3" stroke="var(--muted)" stroke-width="1.2" fill="none"/></svg>`
  }
}

function badge(label: string, bg: string, fg: string): string {
  return `<svg width="14" height="14" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg"><rect x="0.5" y="2" width="13" height="10" rx="2" fill="${bg}"/><text x="7" y="9.5" text-anchor="middle" font-family="Inter, sans-serif" font-size="7" font-weight="700" fill="${fg}">${label}</text></svg>`
}
