/** Page geometry, theme colors, and named colors. */

import type { RGB } from "./types";

// ── page geometry (US Letter, points) ──────────────────────────────────
export const PAGE_W = 612;
export const PAGE_H = 792;
export const MARGIN = 72;
export const CONTENT_W = PAGE_W - 2 * MARGIN;
export const HEADER_Y = PAGE_H - 30;
export const CONTENT_TOP = HEADER_Y - 16;
export const CONTENT_BOT = 90;
export const FOOTER_Y = 28;
export const CB_Y_START = 74;
export const CB_LINE_H = 11;

// ── theme colors (RGB 0-1) — GitHub base16 ────────────────────────────
export const CLR_HEADING: RGB = [0.0, 0.0, 0.0]; // black
export const CLR_TEXT: RGB = [0.0, 0.0, 0.0]; // black
export const CLR_CODE_FG: RGB = [0.2, 0.2, 0.2]; // base05 #333333
export const CLR_CODE_BG: RGB = [0.961, 0.961, 0.961]; // base01 #f5f5f5
export const CLR_CODE_LN: RGB = [0.588, 0.596, 0.588]; // base03 #969896
export const CLR_RULE: RGB = [0.784, 0.784, 0.784]; // base02 #c8c8c8
export const CLR_TBL_HDR_BG: RGB = [0.961, 0.961, 0.961]; // base01 #f5f5f5
export const CLR_TBL_HDR_FG: RGB = [0.0, 0.0, 0.0]; // black
export const CLR_TBL_LINE: RGB = [0.784, 0.784, 0.784]; // #c8c8c8
export const CLR_TBL_ALT: RGB = [0.98, 0.98, 0.98]; // #fafafa
export const CLR_PAGE_NUM: RGB = [0.45, 0.45, 0.5];
export const CLR_CB: RGB = [0.0, 0.0, 0.0];
export const CLR_LINK: RGB = [0.133, 0.369, 0.659]; // true blue

// ── named colors (GitHub base16 palette) ──────────────────────────────
export const NAMED_COLORS: Record<string, RGB> = {
  green: [0.239, 0.545, 0.216], // #3d8b37 — green
  red: [0.882, 0.227, 0.353], // #E13A5A — SECRET
  orange: [1.0, 0.459, 0.094], // #FF7518
  yellow: [0.475, 0.365, 0.639], // base0A #795da3
  blue: [0.094, 0.212, 0.569], // base0B #183691
  purple: [0.392, 0.051, 0.373], // #640D5F — CUI/CONFIDENTIAL
  cyan: [0.0, 0.525, 0.702], // base09 #0086b3
  gray: [0.588, 0.596, 0.588], // base03 #969896
};

// ── marking categories ─────────────────────────────────────────────────
export const BASE_LEVELS = [
  "TOP SECRET",
  "CONFIDENTIAL",
  "CONTROLLED",
  "SECRET",
  "CUI",
  "UNCLASSIFIED",
];

export const CLASSIFIED_LEVELS = new Set(["CONFIDENTIAL", "SECRET", "TOP SECRET"]);

export const CUI_LEVELS = new Set(["CUI", "CONTROLLED"]);

export const PM_SZ = 10; // font size for portion-marking labels

export const HEADING_SZ: Record<string, number> = {
  h1: 22,
  h2: 18,
  h3: 15,
  h4: 13,
  h5: 12,
  h6: 11,
};

// ── helpers ────────────────────────────────────────────────────────────

export function autoBannerColor(marking: string, explicitColor: string): RGB {
  if (explicitColor) {
    return NAMED_COLORS[explicitColor] || [0.3, 0.3, 0.3];
  }
  const m = marking.toUpperCase();
  if (m.startsWith("TOP SECRET")) return NAMED_COLORS.orange; // #ed6a43
  if (m.startsWith("SECRET")) return NAMED_COLORS.red; // #a71d5d
  if (m.startsWith("CONFIDENTIAL")) return NAMED_COLORS.purple; // #795da3
  if (m.startsWith("CUI") || m.startsWith("CONTROLLED")) return NAMED_COLORS.purple; // #795da3
  if (m.startsWith("UNCLASSIFIED")) return NAMED_COLORS.green; // #3d8b37
  return [0.3, 0.3, 0.3];
}

export function pmColor(longName: string): RGB {
  const m = longName.trim().toUpperCase();
  if (m.startsWith("TOP SECRET")) return NAMED_COLORS.orange;
  if (m.startsWith("SECRET")) return NAMED_COLORS.red;
  if (m.startsWith("CONFIDENTIAL")) return NAMED_COLORS.purple;
  if (m.startsWith("CUI") || m.startsWith("CONTROLLED")) return NAMED_COLORS.purple;
  if (m.startsWith("UNCLASSIFIED")) return NAMED_COLORS.green;
  return [0.3, 0.3, 0.3];
}

export function parseBase(markingStr: string): {
  base: string;
  caveats: Set<string>;
} {
  const s = markingStr.trim().toUpperCase();
  let base = "UNCLASSIFIED";
  for (const lvl of BASE_LEVELS) {
    if (s.startsWith(lvl)) {
      base = lvl;
      break;
    }
  }
  const remainder = s.slice(base.length);
  const caveats = new Set<string>();
  if (remainder.startsWith("//")) {
    for (const part of remainder.slice(2).split("/")) {
      const p = part.trim();
      if (p) caveats.add(p);
    }
  }
  return { base, caveats };
}

export function isClassified(base: string): boolean {
  return CLASSIFIED_LEVELS.has(base);
}

export function isCui(base: string): boolean {
  return CUI_LEVELS.has(base);
}
