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

