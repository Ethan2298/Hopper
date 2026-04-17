import { WidgetType } from "@codemirror/view"
import type { ReaderUnit, UnitProse, ProseBullet } from "./prose-types"

/**
 * Unit card widget.
 * - level=0 (collapsed): card only; code body is hidden.
 * - level=1 (expanded): card with bullets listed below the summary.
 *   When expanded, the caller drops the body-hiding replace decoration
 *   so the raw code renders natively beneath this widget.
 */
export class CardWidget extends WidgetType {
  constructor(
    readonly unit: ReaderUnit,
    readonly prose: UnitProse | undefined,
    readonly level: 0 | 1,
    readonly onToggle: (unitIndex: number) => void
  ) {
    super()
  }

  eq(other: CardWidget) {
    return (
      other.unit === this.unit &&
      other.prose === this.prose &&
      other.level === this.level
    )
  }

  toDOM() {
    const root = document.createElement("div")
    root.className = `bm-card bm-card-l${this.level} bm-card-${this.unit.kind}`
    root.addEventListener("click", () => this.onToggle(this.unit.index))

    const head = document.createElement("div")
    head.className = "bm-card-head"

    const chev = document.createElement("span")
    chev.className = "bm-chev"
    chev.textContent = this.level === 0 ? "▸" : "▾"
    head.appendChild(chev)

    const sig = document.createElement("code")
    sig.className = "bm-signature"
    sig.textContent = this.signatureLabel()
    head.appendChild(sig)

    const summary = document.createElement("p")
    summary.className = "bm-summary"
    summary.textContent = this.prose?.oneLineSummary || ""
    head.appendChild(summary)

    root.appendChild(head)

    if (this.level === 1 && this.prose && this.prose.bullets.length > 0) {
      const list = document.createElement("ul")
      list.className = "bm-bullets"
      for (const b of this.prose.bullets) {
        list.appendChild(this.renderBullet(b))
      }
      root.appendChild(list)
    }

    return root
  }

  private signatureLabel(): string {
    // Prefer the first line of the unit's source as its header label.
    const firstLine = (this.unit.source || "").split("\n")[0].trim()
    if (firstLine) return firstLine
    return `${this.unit.kind} ${this.unit.name}`
  }

  private renderBullet(bullet: ProseBullet) {
    const li = document.createElement("li")
    li.className = `bm-bullet bm-bullet-${bullet.kind}`

    const dot = document.createElement("span")
    dot.className = "bm-bullet-dot"
    dot.textContent = "•"
    li.appendChild(dot)

    const text = document.createElement("span")
    text.className = "bm-bullet-text"
    text.textContent = bullet.text
    li.appendChild(text)

    return li
  }

  ignoreEvent() {
    return false
  }
}
