/** Font metrics, text width calculation, PDF string escaping. */

import type { EmbeddedFont } from "./fonts";

let _fonts: Map<string, EmbeddedFont> | null = null;

export function initFontMetrics(fonts: Map<string, EmbeddedFont>): void {
  _fonts = fonts;
}

export function clearFontMetrics(): void {
  _fonts = null;
}

// Font resource names for PDF
export const FONT_RES: Record<string, string> = {
  Helvetica: "F1",
  "Helvetica-Bold": "F2",
  Courier: "F3",
  "Helvetica-Oblique": "F4",
};

// Helvetica character widths (1/1000 em)
// prettier-ignore
const HW: Record<number, number> = {
  32:278,33:278,34:355,35:556,36:556,37:889,38:667,39:191,40:333,41:333,
  42:389,43:584,44:278,45:333,46:278,47:278,48:556,49:556,50:556,51:556,
  52:556,53:556,54:556,55:556,56:556,57:556,58:278,59:278,60:584,61:584,
  62:584,63:556,64:1015,65:667,66:667,67:722,68:722,69:611,70:556,71:778,
  72:722,73:278,74:500,75:667,76:556,77:833,78:722,79:778,80:667,81:778,
  82:722,83:667,84:611,85:722,86:667,87:944,88:667,89:667,90:611,91:278,
  92:278,93:278,94:469,95:556,96:333,97:556,98:556,99:500,100:556,101:556,
  102:278,103:556,104:556,105:222,106:222,107:500,108:222,109:833,110:556,
  111:556,112:556,113:556,114:333,115:500,116:278,117:556,118:500,119:722,
  120:500,121:500,122:500,123:334,124:260,125:334,126:584,
};

// Helvetica-Bold character widths (1/1000 em)
// prettier-ignore
const HBW: Record<number, number> = {
  32:278,33:333,34:474,35:556,36:556,37:889,38:722,39:238,40:333,41:333,
  42:389,43:584,44:278,45:333,46:278,47:278,48:556,49:556,50:556,51:556,
  52:556,53:556,54:556,55:556,56:556,57:556,58:333,59:333,60:584,61:584,
  62:584,63:611,64:975,65:722,66:722,67:722,68:722,69:667,70:611,71:778,
  72:722,73:278,74:556,75:722,76:611,77:833,78:722,79:778,80:667,81:778,
  82:722,83:667,84:611,85:722,86:667,87:944,88:667,89:667,90:611,91:333,
  92:278,93:333,94:584,95:556,96:333,97:556,98:611,99:556,100:611,101:556,
  102:333,103:611,104:611,105:278,106:278,107:556,108:278,109:889,110:611,
  111:611,112:611,113:611,114:389,115:556,116:333,117:611,118:556,119:778,
  120:556,121:556,122:500,123:389,124:280,125:389,126:584,
};

const CW = 600; // Courier is monospace

/** Text width in points. */
export function textWidth(text: string, font: string, size: number): number {
  const ef = _fonts?.get(font);
  if (ef) {
    let total = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      total += (code < 256 ? ef.metrics.widths[code] : 0) || 500;
    }
    return (total * size) / 1000;
  }
  // Fallback to built-in metrics
  if (font === "Courier") {
    return (text.length * CW * size) / 1000;
  }
  const w = font.includes("Bold") ? HBW : HW;
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    total += w[text.charCodeAt(i)] ?? 556;
  }
  return (total * size) / 1000;
}

// cp1252 mapping for characters outside standard ASCII
// Maps Unicode code points to cp1252 bytes for characters 0x80-0x9F
const UNICODE_TO_CP1252: Record<number, number> = {
  0x20ac: 0x80, // €
  0x201a: 0x82, // ‚
  0x0192: 0x83, // ƒ
  0x201e: 0x84, // „
  0x2026: 0x85, // …
  0x2020: 0x86, // †
  0x2021: 0x87, // ‡
  0x02c6: 0x88, // ˆ
  0x2030: 0x89, // ‰
  0x0160: 0x8a, // Š
  0x2039: 0x8b, // ‹
  0x0152: 0x8c, // Œ
  0x017d: 0x8e, // Ž
  0x2018: 0x91, // '
  0x2019: 0x92, // '
  0x201c: 0x93, // "
  0x201d: 0x94, // "
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x02dc: 0x98, // ˜
  0x2122: 0x99, // ™
  0x0161: 0x9a, // š
  0x203a: 0x9b, // ›
  0x0153: 0x9c, // œ
  0x017e: 0x9e, // ž
  0x0178: 0x9f, // Ÿ
};

/** Encode a character to cp1252, returning '?' for unmappable chars. */
function charToCp1252(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code < 0x80) return code;
  if (code >= 0xa0 && code <= 0xff) return code;
  return UNICODE_TO_CP1252[code] ?? 0x3f; // '?'
}

/** Escape text for a PDF string literal (WinAnsiEncoding).
 *  Keeps original Unicode chars — encodeCp1252 does the final byte mapping. */
export function pdfEscape(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") result += "\\\\";
    else if (ch === "(") result += "\\(";
    else if (ch === ")") result += "\\)";
    else result += ch;
  }
  return result;
}

/** Encode a full string to cp1252 as a Buffer. */
export function encodeCp1252(text: string): Buffer {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = charToCp1252(text[i]);
  }
  return Buffer.from(bytes);
}
