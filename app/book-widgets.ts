import { WidgetType } from "@codemirror/view"
import type { FunctionOutline, Bullet, ImportOutline } from "./prose-types"

/**
 * Level 0 / Level 1 card widget for a function.
 * - level=0: card only (compact); code body is hidden.
 * - level=1: card with all bullets listed below it (bullets collapsed).
 * The card itself is the single clickable target that toggles L0 <-> L1.
 */
export class CardWidget extends WidgetType {
  constructor(
    readonly fn: FunctionOutline,
    readonly level: 0 | 1,
    readonly expandedBulletIds: Set<number>,
    readonly onToggleFunction: (fnName: string) => void,
    readonly onToggleBullet: (fnName: string, bulletIdx: number) => void,
    readonly signatureText: string
  ) {
    super()
  }

  eq(other: CardWidget) {
    if (other.fn !== this.fn || other.level !== this.level) return false
    if (other.expandedBulletIds.size !== this.expandedBulletIds.size) return false
    for (const id of this.expandedBulletIds) {
      if (!other.expandedBulletIds.has(id)) return false
    }
    return true
  }

  toDOM() {
    const root = document.createElement("div")
    root.className = `bm-card bm-card-l${this.level}`

    const head = document.createElement("div")
    head.className = "bm-card-head"
    head.addEventListener("click", () => this.onToggleFunction(this.fn.name))

    const chev = document.createElement("span")
    chev.className = "bm-chev"
    chev.textContent = this.level === 0 ? "▸" : "▾"
    head.appendChild(chev)

    const sig = document.createElement("code")
    sig.className = "bm-signature"
    sig.textContent = this.signatureText
    head.appendChild(sig)

    const summary = document.createElement("p")
    summary.className = "bm-summary"
    summary.textContent = this.fn.oneLineSummary
    head.appendChild(summary)

    root.appendChild(head)

    if (this.level === 1) {
      const list = document.createElement("ul")
      list.className = "bm-bullets"
      this.fn.bullets.forEach((b, idx) => {
        list.appendChild(this.renderBullet(b, idx))
      })
      root.appendChild(list)
    }

    return root
  }

  private renderBullet(bullet: Bullet, idx: number) {
    const li = document.createElement("li")
    li.className = `bm-bullet bm-bullet-${bullet.kind}`
    if (this.expandedBulletIds.has(idx)) li.classList.add("bm-bullet-open")

    const chev = document.createElement("span")
    chev.className = "bm-chev"
    chev.textContent = this.expandedBulletIds.has(idx) ? "▾" : "▸"
    li.appendChild(chev)

    const text = document.createElement("span")
    text.className = "bm-bullet-text"
    text.textContent = bullet.text
    li.appendChild(text)

    li.addEventListener("click", (e) => {
      e.stopPropagation()
      this.onToggleBullet(this.fn.name, idx)
    })

    return li
  }

  ignoreEvent() {
    return false
  }
}

/**
 * Import summary bullet, rendered at the top of the file.
 * Has its own simple click-to-toggle behavior managed by the decoration plugin.
 */
export class ImportWidget extends WidgetType {
  constructor(
    readonly imp: ImportOutline,
    readonly expanded: boolean,
    readonly onToggle: () => void
  ) {
    super()
  }

  eq(other: ImportWidget) {
    return other.imp === this.imp && other.expanded === this.expanded
  }

  toDOM() {
    const root = document.createElement("div")
    root.className = "bm-imports"
    if (this.expanded) root.classList.add("bm-imports-open")

    const chev = document.createElement("span")
    chev.className = "bm-chev"
    chev.textContent = this.expanded ? "▾" : "▸"
    root.appendChild(chev)

    const text = document.createElement("span")
    text.className = "bm-imports-text"
    text.textContent = this.imp.oneLineSummary
    root.appendChild(text)

    root.addEventListener("click", () => this.onToggle())
    return root
  }

  ignoreEvent() {
    return false
  }
}
