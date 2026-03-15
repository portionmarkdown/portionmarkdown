/** Load and cache embedded TrueType fonts for PDF generation. */

import * as fs from "fs";
import * as path from "path";
import { parseTtf, TtfMetrics } from "./ttfParser";

export interface EmbeddedFont {
  ttfData: Buffer;
  metrics: TtfMetrics;
}

const FONT_FILES: Record<string, string> = {
  Helvetica: "cmunrm.ttf",
  "Helvetica-Bold": "cmunbx.ttf",
  "Helvetica-Oblique": "cmunti.ttf",
  Courier: "cmuntt.ttf",
};

let cached: Map<string, EmbeddedFont> | null = null;

export function loadFonts(basePath: string): Map<string, EmbeddedFont> {
  if (cached) return cached;

  const fonts = new Map<string, EmbeddedFont>();
  const fontsDir = path.join(basePath, "fonts");

  for (const [logicalName, fileName] of Object.entries(FONT_FILES)) {
    const ttfPath = path.join(fontsDir, fileName);
    const ttfData = fs.readFileSync(ttfPath);
    const metrics = parseTtf(ttfData);
    fonts.set(logicalName, { ttfData, metrics });
  }

  cached = fonts;
  return fonts;
}
