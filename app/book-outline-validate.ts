import type { BookOutline, FunctionOutline } from "./prose-types"

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

/**
 * A BookOutline is valid when, for every function, the union of its
 * bullets' [fromLine, toLine] ranges equals [signatureLine+1 .. lastBodyLine]
 * with no gaps or overlaps. Signature line is NOT covered by bullets.
 *
 * lineCount is the total number of lines in the source file (1-based
 * line numbers; lineCount >= any signatureLine or bullet.toLine).
 */
export function validateBookOutline(
  outline: BookOutline,
  lineCount: number
): ValidationResult {
  const errors: string[] = []

  for (const fn of outline.functions) {
    if (fn.signatureLine < 1 || fn.signatureLine > lineCount) {
      errors.push(`function "${fn.name}": signatureLine ${fn.signatureLine} out of range`)
      continue
    }
    if (fn.bullets.length === 0) {
      // Empty bullets means "declaration-only, no body to partition"
      // (e.g. single-line type aliases, bare variable declarations).
      continue
    }

    const sorted = [...fn.bullets].sort((a, b) => a.fromLine - b.fromLine)
    const bodyStart = fn.signatureLine + 1

    // First bullet must start immediately after the signature.
    if (sorted[0].fromLine !== bodyStart) {
      errors.push(
        `function "${fn.name}": first bullet starts at line ${sorted[0].fromLine}, expected ${bodyStart}`
      )
    }

    // Each subsequent bullet must start immediately after the previous one ends.
    for (let i = 1; i < sorted.length; i++) {
      const expected = sorted[i - 1].toLine + 1
      if (sorted[i].fromLine !== expected) {
        errors.push(
          `function "${fn.name}": bullet ${i} starts at line ${sorted[i].fromLine}, expected ${expected}`
        )
      }
    }

    // Each bullet must have fromLine <= toLine.
    for (const b of sorted) {
      if (b.fromLine > b.toLine) {
        errors.push(`function "${fn.name}": bullet "${b.text.slice(0, 30)}" has fromLine > toLine`)
      }
      if (b.toLine > lineCount) {
        errors.push(`function "${fn.name}": bullet toLine ${b.toLine} exceeds lineCount ${lineCount}`)
      }
    }
  }

  if (outline.imports) {
    const imp = outline.imports
    if (imp.fromLine < 1 || imp.toLine > lineCount || imp.fromLine > imp.toLine) {
      errors.push(`imports: invalid range [${imp.fromLine}, ${imp.toLine}]`)
    }
  }

  return { ok: errors.length === 0, errors }
}
