import { WidgetType } from "@codemirror/view"
import type { ReaderUnit, OutlineStatement } from "./prose-types"

/**
 * Invisible filler used to replace lines that aren't owned by any unit
 * (top-level comments, whitespace, stray expressions). Keeps the book view
 * strictly outline-only.
 */
export class GapWidget extends WidgetType {
  eq(_other: GapWidget) {
    return true
  }
  toDOM() {
    const el = document.createElement("div")
    el.className = "bm-outline-gap"
    return el
  }
  ignoreEvent() {
    return true
  }
}

/**
 * One top-level bullet per unit, with its NL summary as the bullet text and
 * the unit's statements as indented sub-bullets. Clicking any bullet reveals
 * that bullet's code chunk in a markdown-style fenced block underneath.
 *
 * Statement index convention: -1 means the unit-level bullet (reveals full
 * unit source); 0..N-1 are the statement bullets (reveal their chunk).
 */
export class UnitOutlineWidget extends WidgetType {
  constructor(
    readonly unit: ReaderUnit,
    readonly summary: string,
    readonly statements: OutlineStatement[],
    readonly expandedSignature: string, // "U|01010…" serialization for eq()
    readonly expandedSet: Set<string>,
    readonly onToggle: (unitIndex: number, statementIndex: number) => void
  ) {
    super()
  }

  eq(other: UnitOutlineWidget) {
    return (
      other.unit === this.unit &&
      other.summary === this.summary &&
      other.statements === this.statements &&
      other.expandedSignature === this.expandedSignature
    )
  }

  toDOM() {
    const list = document.createElement("ul")
    list.className = `bm-outline-list bm-outline-list-root bm-outline-list-${this.unit.kind}`

    const unitOpen = this.expandedSet.has(`${this.unit.index}:-1`)

    const topItem = document.createElement("li")
    topItem.className = "bm-outline-item bm-outline-item-unit"
    topItem.appendChild(
      this.buildRow(this.summaryText(), unitOpen, () => this.onToggle(this.unit.index, -1), 0)
    )
    if (unitOpen) topItem.appendChild(this.buildCodeBlock(this.unit.source))

    // Sub-bullets: one per NL statement.
    if (this.statements.length > 0) {
      const subList = document.createElement("ul")
      subList.className = "bm-outline-list bm-outline-list-sub"
      for (let i = 0; i < this.statements.length; i++) {
        const stmt = this.statements[i]
        const key = `${this.unit.index}:${i}`
        const open = this.expandedSet.has(key)

        const subItem = document.createElement("li")
        subItem.className = "bm-outline-item"
        subItem.appendChild(
          this.buildRow(stmt.text, open, () => this.onToggle(this.unit.index, i), 1)
        )
        if (open) subItem.appendChild(this.buildCodeBlock(this.sliceCode(stmt)))
        subList.appendChild(subItem)
      }
      topItem.appendChild(subList)
    }

    list.appendChild(topItem)
    return list
  }

  private buildRow(text: string, open: boolean, onClick: () => void, _depth: number) {
    const row = document.createElement("div")
    row.className = "bm-outline-row"
    if (open) row.classList.add("open")
    row.addEventListener("click", onClick)

    const bullet = document.createElement("span")
    bullet.className = "bm-outline-bullet"
    bullet.textContent = "•"
    row.appendChild(bullet)

    const label = document.createElement("span")
    label.className = "bm-outline-text"
    label.textContent = text
    row.appendChild(label)

    return row
  }

  private buildCodeBlock(text: string): HTMLElement {
    const pre = document.createElement("pre")
    pre.className = "bm-code-block"
    const code = document.createElement("code")
    code.textContent = text
    pre.appendChild(code)
    return pre
  }

  private summaryText(): string {
    if (this.summary) return this.summary
    if (this.unit.kind === "import-block") return "Import dependencies."
    const firstLine = (this.unit.source || "").split("\n")[0].trim()
    if (firstLine) return firstLine
    return `${this.unit.kind} ${this.unit.name}`
  }

  private sliceCode(stmt: OutlineStatement): string {
    const lines = (this.unit.source || "").split("\n")
    const start = Math.max(0, stmt.startLine - 1)
    const end = Math.min(lines.length, stmt.endLine)
    if (start >= end) return ""
    const slice = lines.slice(start, end)
    const indents = slice
      .filter((l) => l.trim().length > 0)
      .map((l) => l.match(/^\s*/)?.[0].length ?? 0)
    const minIndent = indents.length ? Math.min(...indents) : 0
    return slice.map((l) => l.slice(minIndent)).join("\n")
  }

  ignoreEvent() {
    return false
  }
}
