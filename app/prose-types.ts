export type ZoomLevel = 0 | 1 | 2 | 3

export type FileNodeKind = "function" | "class" | "variable" | "import" | "export" | "control" | "type"

export interface FileNode {
  kind: FileNodeKind
  name: string
  params: { name: string; type?: string }[]
  returnType?: string
  isAsync: boolean
  isExported: boolean
  keyword: string
  from: number
  to: number
  children: FileNode[]
  childSummary: ChildSummary
}

export interface ChildSummary {
  callCount: number
  conditionCount: number
  loopCount: number
  returnCount: number
  calledFunctions: string[]
}

export interface FileStructure {
  imports: FileNode[]
  exports: FileNode[]
  declarations: FileNode[]
  language: string
}

export interface InlineNote {
  from: number
  to: number
  text: string
}

export interface AnnotatedNode {
  node: FileNode
  summary: string
  detail: string
  inlineNotes: InlineNote[]
  code: string
}

export interface AnnotatedFile {
  fileSummary: string
  outline: string[]
  nodes: AnnotatedNode[]
}

/** AST-derived unit of the file. Line ranges come from Lezer, not the LLM. */
export type ReaderUnitKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "import-block"
  | "other"

export interface ReaderUnit {
  index: number
  kind: ReaderUnitKind
  name: string
  signatureLine: number   // 1-based, line where the declaration starts
  fromLine: number        // 1-based, inclusive (typically = signatureLine)
  toLine: number          // 1-based, inclusive
  isMultiLine: boolean    // fromLine < toLine
  source: string          // the file slice for this unit (sent to the LLM)
}

/**
 * A single NL outline statement covering a logical block of the unit's body.
 * Line numbers are 1-indexed **within the unit's `source`** (not the whole file).
 */
export interface OutlineStatement {
  text: string
  startLine: number
  endLine: number
}

/** LLM-provided prose for one unit, keyed by index. */
export interface UnitProse {
  index: number
  summary: string                 // one-sentence NL description of the unit
  statements: OutlineStatement[]  // sub-bullets; empty if isMultiLine is false
}

export interface BookReaderOutline {
  units: ReaderUnit[]
  prose: Record<number, UnitProse>  // keyed by unit index
}
