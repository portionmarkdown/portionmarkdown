/** Shared types for the md2pdf TypeScript port. */

export type RGB = [number, number, number];

export interface MarkingDef {
  short: string;
  long: string;
  color: RGB;
}

export interface MarkingDefs {
  [key: string]: MarkingDef;
}

export interface TextRun {
  text: string;
  font: string;
  link?: string;
  footnoteRef?: number;
  strikethrough?: boolean;
}

export interface TableCell {
  runs: TextRun[];
  header: boolean;
}

export interface BlockBase {
  sb: number;
  sa: number;
}

export interface HrBlock extends BlockBase {
  type: "hr";
}

export interface PagebreakBlock extends BlockBase {
  type: "pagebreak";
}

export interface CodeBlock extends BlockBase {
  type: "code";
  text: string;
  lang: string | null;
  linenoStart: number | null;
  marking: MarkingDef | null;
  indent: number;
  size: number;
}

export interface ImageBlock extends BlockBase {
  type: "image";
  src: string;
  alt: string;
  sizing: "original" | "fit" | "pct";
  widthPct: number | null;
  marking: MarkingDef | null;
}

export interface TableBlock extends BlockBase {
  type: "table";
  rows: TableCell[][];
  marking: MarkingDef | null;
  size: number;
}

export interface ParaBlock extends BlockBase {
  type: "para";
  runs: TextRun[];
  marking: MarkingDef | null;
  isLi: boolean;
  size: number;
  indent: number;
  blockquote?: boolean;
}

export interface HeadingBlock extends BlockBase {
  type: "heading";
  runs: TextRun[];
  marking: MarkingDef | null;
  size: number;
  indent: number;
  blockquote?: boolean;
}

export type Block =
  | HrBlock
  | PagebreakBlock
  | CodeBlock
  | ImageBlock
  | TableBlock
  | ParaBlock
  | HeadingBlock;

export interface ImageInfo {
  data: Buffer;
  width: number;
  height: number;
  cs: string;
  bpc: number;
  filter: string;
  name?: string;
  objNum?: number;
}

export interface DocConfig {
  marking: string;
  markingColor: string;
  classificationBlock: string;
  cuiBlock: string;
  forceShowBlocks: boolean;
  exampleMode: boolean;
}

export interface Md2PdfOptions {
  inputPath?: string;
  outputPath?: string;
  srcDir?: string;
  watermark?: string | null;
  extensionPath?: string;
  font?: string;
}
