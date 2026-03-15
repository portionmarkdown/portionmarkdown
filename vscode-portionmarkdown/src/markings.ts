/**
 * Parse <!-- markings -->, <!-- classification -->, and <!-- cui --> blocks
 * from Markdown document text.  Also provides classification-level helpers.
 */

// ── Classification categories ────────────────────────────────────────────

// Longest first so "TOP SECRET" matches before "SECRET", and "CONTROLLED"
// doesn't collide with "CONFIDENTIAL".
const BASE_LEVELS = [
  "TOP SECRET",
  "CONFIDENTIAL",
  "CONTROLLED",
  "SECRET",
  "CUI",
  "UNCLASSIFIED",
];

const CLASSIFIED_LEVELS = new Set(["CONFIDENTIAL", "SECRET", "TOP SECRET"]);
const CUI_LEVELS = new Set(["CUI", "CONTROLLED"]);

export function parseBase(markingStr: string): string {
  const s = markingStr.trim().toUpperCase();
  for (const lvl of BASE_LEVELS) {
    if (s.startsWith(lvl)) return lvl;
  }
  return "UNCLASSIFIED";
}

export function isClassified(base: string): boolean {
  return CLASSIFIED_LEVELS.has(base);
}

export function isCui(base: string): boolean {
  return CUI_LEVELS.has(base);
}

export function longToColor(long: string): string {
  const m = long.trim().toUpperCase();
  if (m.startsWith("TOP SECRET")) return "orange";
  if (m.startsWith("SECRET")) return "red";
  if (m.startsWith("CONFIDENTIAL")) return "blue";
  if (m.startsWith("CUI") || m.startsWith("CONTROLLED")) return "purple";
  if (m.startsWith("UNCLASSIFIED")) return "green";
  return "gray";
}

// ── Interfaces ───────────────────────────────────────────────────────────

export interface MarkingDef {
  key: string;
  short: string;
  long: string;
}

export interface DocMeta {
  marking: string;
  markingDefs: MarkingDef[];
  classificationBlock: string[];
  cuiBlock: string[];
  showBlocks: boolean;
  exampleMode: boolean;
}

// ── Parsing ──────────────────────────────────────────────────────────────

/**
 * Extract marking definitions from a `<!-- markings ... -->` comment.
 * Format per line: `KEY: SHORT | LONG`
 */
export function parseMarkingDefs(text: string): MarkingDef[] {
  const m = text.match(/<!--\s*markings\b([\s\S]*?)-->/);
  if (!m) return [];
  const defs: MarkingDef[] = [];
  for (const line of m[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1);
    const pipeIdx = rest.indexOf("|");
    if (pipeIdx < 0) continue;
    const short = rest.slice(0, pipeIdx).trim();
    const long = rest.slice(pipeIdx + 1).trim();
    defs.push({ key, short, long });
  }
  return defs;
}

/**
 * Parse the `<!-- classification ... -->` comment.  Returns the explicit
 * marking (if any), classification authority lines, and flags.
 */
function parseClassificationComment(text: string): {
  explicitMarking: string | null;
  authorityLines: string[];
  showBlocks: boolean;
  exampleMode: boolean;
} {
  const result = {
    explicitMarking: null as string | null,
    authorityLines: [] as string[],
    showBlocks: false,
    exampleMode: false,
  };
  const m = text.match(/<!--\s*classification\b([\s\S]*?)-->/);
  if (!m) return result;
  for (const line of m[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("marking:")) {
      result.explicitMarking = trimmed.split(":").slice(1).join(":").trim();
    } else if (lower.startsWith("show-blocks:")) {
      result.showBlocks = ["true", "yes", "1"].includes(
        trimmed.split(":").slice(1).join(":").trim().toLowerCase(),
      );
    } else if (lower.startsWith("example:")) {
      result.exampleMode = ["true", "yes", "1"].includes(
        trimmed.split(":").slice(1).join(":").trim().toLowerCase(),
      );
    } else {
      result.authorityLines.push(trimmed);
    }
  }
  return result;
}

/**
 * Parse the `<!-- cui ... -->` comment body lines.
 */
function parseCuiComment(text: string): string[] {
  const m = text.match(/<!--\s*cui\b([\s\S]*?)-->/);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Extract the banner marking: explicit > infer from CUI block > UNCLASSIFIED.
 */
export function parseBannerMarking(text: string): string {
  const cls = parseClassificationComment(text);
  if (cls.explicitMarking) return cls.explicitMarking;
  if (parseCuiComment(text).length > 0) return "CUI";
  return "UNCLASSIFIED";
}

/**
 * Parse full document metadata.
 */
export function parseDocMeta(text: string): DocMeta {
  const cls = parseClassificationComment(text);
  const cuiLines = parseCuiComment(text);
  let marking: string;
  if (cls.explicitMarking) {
    marking = cls.explicitMarking;
  } else if (cuiLines.length > 0) {
    marking = "CUI";
  } else {
    marking = "UNCLASSIFIED";
  }
  return {
    marking,
    markingDefs: parseMarkingDefs(text),
    classificationBlock: cls.authorityLines,
    cuiBlock: cuiLines,
    showBlocks: cls.showBlocks,
    exampleMode: cls.exampleMode,
  };
}

/**
 * Determine which info blocks should be visible, matching _block_lines()
 * in md2pdf.py.  UNCLASSIFIED suppresses both unless showBlocks is true.
 */
export function visibleBlocks(meta: DocMeta): {
  cbLines: string[];
  cuiLines: string[];
} {
  const isUnclass = meta.marking.trim().toUpperCase().startsWith("UNCLASSIFIED");
  if (meta.showBlocks || !isUnclass) {
    return {
      cbLines: meta.classificationBlock,
      cuiLines: meta.cuiBlock,
    };
  }
  return { cbLines: [], cuiLines: [] };
}
