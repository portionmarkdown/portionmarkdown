/**
 * PDF serializer — assemble PDF objects from pages.
 * Port of Python's _build_pdf() function.
 */

import * as zlib from "zlib";
import type { RGB, ImageInfo } from "./types";
import type { EmbeddedFont } from "./fonts";
import {
  PAGE_W,
  PAGE_H,
  MARGIN,
  CONTENT_W,
  FOOTER_Y,
  HEADER_Y,
  CB_LINE_H,
  CLR_PAGE_NUM,
  CLR_CB,
} from "./config";
import { FONT_RES, textWidth, encodeCp1252, pdfEscape } from "./fontMetrics";
import { Pg } from "./page";

// Re-export autoBannerColor so the caller can compute CLR_BANNER
export { autoBannerColor } from "./config";

interface BuildConfig {
  marking: string;
  bannerColor: RGB;
  cbLines: string[];
  cuiLines: string[];
}

/** Wrap plain text lines to fit within maxW at the given font/size. */
function wrapBlockLines(
  lines: string[],
  maxW: number,
  font: string,
  size: number,
): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (textWidth(line, font, size) <= maxW) {
      out.push(line);
      continue;
    }
    const words = line.split(" ");
    let cur = "";
    let curW = 0;
    for (const word of words) {
      const ww = textWidth(word, font, size);
      const sw = textWidth(" ", font, size);
      if (cur && curW + sw + ww > maxW) {
        out.push(cur);
        cur = word;
        curW = ww;
      } else {
        cur = cur ? cur + " " + word : word;
        curW = cur ? curW + sw + ww : ww;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

export function buildPdf(
  pages: Pg[],
  images: ImageInfo[],
  config: BuildConfig,
  fonts?: Map<string, EmbeddedFont>,
): Buffer {
  const total = pages.length;
  const boxPad = 4;
  const boxFontSz = 8;
  const maxBlockW = CONTENT_W * 0.55;

  // Stamp headers, footers, classification block onto each page
  for (let pi = 0; pi < pages.length; pi++) {
    const pg = pages[pi];
    const pageNum = pi + 1;

    // Top/bottom marking — centered, bold, scaled to fit
    // Bottom has page number on the right — banner must not overlap it
    const pn = `Page ${pageNum} of ${total}`;
    const pnW = textWidth(pn, "Helvetica", 9) + 8;
    // Max banner width so centered text doesn't hit the page number:
    // right edge of centered banner = (PAGE_W + cw)/2 must be < PAGE_W - MARGIN - pnW
    // => cw < PAGE_W - 2*MARGIN - 2*pnW
    const maxBannerW = PAGE_W - 2 * MARGIN - 2 * pnW;
    let bannerSz = 10;
    while (
      textWidth(config.marking, "Helvetica-Bold", bannerSz) > maxBannerW &&
      bannerSz > 5
    ) {
      bannerSz -= 0.5;
    }
    const cw = textWidth(config.marking, "Helvetica-Bold", bannerSz);
    pg.text(
      (PAGE_W - cw) / 2,
      HEADER_Y,
      config.marking,
      "Helvetica-Bold",
      bannerSz,
      config.bannerColor,
    );

    // Bottom marking — centered, bold
    pg.text(
      (PAGE_W - cw) / 2,
      FOOTER_Y,
      config.marking,
      "Helvetica-Bold",
      bannerSz,
      config.bannerColor,
    );

    // Page number — bottom right
    pg.text(
      PAGE_W - MARGIN - textWidth(pn, "Helvetica", 9),
      FOOTER_Y,
      pn,
      "Helvetica",
      9,
      CLR_PAGE_NUM,
    );

    // Classification + CUI blocks — first page, right-aligned above footer
    if (pageNum === 1) {
      const boxX = PAGE_W - MARGIN;

      function blockH(lines: string[]): number {
        if (lines.length === 0) return 0;
        return boxFontSz + (lines.length - 1) * CB_LINE_H + 2 * boxPad;
      }

      const wrappedCui = wrapBlockLines(
        config.cuiLines,
        maxBlockW - 2 * boxPad,
        "Helvetica",
        boxFontSz,
      );
      const wrappedCb = wrapBlockLines(
        config.cbLines,
        maxBlockW - 2 * boxPad,
        "Helvetica",
        boxFontSz,
      );
      const cuiH = blockH(wrappedCui);
      const cuiW =
        wrappedCui.length > 0
          ? Math.max(...wrappedCui.map((ln) => textWidth(ln, "Helvetica", boxFontSz))) +
            2 * boxPad
          : 0;
      const cbH = blockH(wrappedCb);
      const cbW =
        wrappedCb.length > 0
          ? Math.max(...wrappedCb.map((ln) => textWidth(ln, "Helvetica", boxFontSz))) +
            2 * boxPad
          : 0;

      const boxW = Math.max(cbW, cuiW);
      let curY = FOOTER_Y + 14;

      function drawBlock(lines: string[], blkH: number): void {
        const blkY = curY;
        let ty = blkY + blkH - boxPad - boxFontSz;
        for (const cl of lines) {
          pg.text(boxX - boxW + boxPad, ty, cl, "Helvetica", boxFontSz, CLR_CB);
          ty -= CB_LINE_H;
        }
        pg.rectStroke(boxX - boxW, blkY, boxW, blkH);
        curY += blkH;
      }

      if (wrappedCui.length > 0) {
        drawBlock(wrappedCui, cuiH);
      }
      if (wrappedCb.length > 0) {
        drawBlock(wrappedCb, cbH);
      }
    }
  }

  // ── Assemble PDF objects ──────────────────────────────────────────────
  const objs: Buffer[] = [];

  function addObj(data: Buffer): number {
    objs.push(data);
    return objs.length;
  }

  // Fonts
  const fontOrder = ["Helvetica", "Helvetica-Bold", "Courier", "Helvetica-Oblique"];
  const fontObjNums: Record<string, number> = {};

  for (const fontName of fontOrder) {
    const ef = fonts?.get(fontName);
    if (ef) {
      const m = ef.metrics;
      // Compressed font stream
      const compressed = zlib.deflateSync(ef.ttfData);
      const streamObj = addObj(
        Buffer.concat([
          Buffer.from(
            `<< /Length ${compressed.length} /Length1 ${ef.ttfData.length} /Filter /FlateDecode >>\nstream\n`,
          ),
          compressed,
          Buffer.from("\nendstream"),
        ]),
      );
      // Font descriptor
      const descObj = addObj(
        Buffer.from(
          `<< /Type /FontDescriptor /FontName /${m.postscriptName}` +
            ` /Flags ${m.flags}` +
            ` /FontBBox [${m.bbox.join(" ")}]` +
            ` /ItalicAngle ${m.italicAngle}` +
            ` /Ascent ${m.ascent} /Descent ${m.descent}` +
            ` /CapHeight ${m.capHeight} /StemV ${m.stemV}` +
            ` /FontFile2 ${streamObj} 0 R >>`,
        ),
      );
      // Font dictionary
      fontObjNums[fontName] = addObj(
        Buffer.from(
          `<< /Type /Font /Subtype /TrueType` +
            ` /BaseFont /${m.postscriptName}` +
            ` /FirstChar 0 /LastChar 255` +
            ` /Widths [${m.widths.join(" ")}]` +
            ` /FontDescriptor ${descObj} 0 R` +
            ` /Encoding /WinAnsiEncoding >>`,
        ),
      );
    } else {
      // Fallback to built-in Type1
      const baseFont = fontName === "Courier" ? "Courier" : fontName;
      fontObjNums[fontName] = addObj(
        Buffer.from(
          `<< /Type /Font /Subtype /Type1 /BaseFont /${baseFont} /Encoding /WinAnsiEncoding >>`,
        ),
      );
    }
  }

  const fd = fontOrder.map((n) => `/${FONT_RES[n]} ${fontObjNums[n]} 0 R`).join(" ");

  // Image XObjects
  for (const img of images) {
    const imgHdr = Buffer.from(
      `<< /Type /XObject /Subtype /Image ` +
        `/Width ${img.width} /Height ${img.height} ` +
        `/ColorSpace /${img.cs} /BitsPerComponent ${img.bpc} ` +
        `/Filter /${img.filter} /Length ${img.data.length} >>\n` +
        `stream\n`,
    );
    img.objNum = addObj(Buffer.concat([imgHdr, img.data, Buffer.from("\nendstream")]));
  }
  const xoEntries = images.map((img) => `/${img.name} ${img.objNum} 0 R`).join(" ");
  const xod = images.length > 0 ? ` /XObject << ${xoEntries} >>` : "";

  // Content streams
  const sns: number[] = [];
  for (const pg of pages) {
    const cs = encodeCp1252(pg.stream());
    sns.push(
      addObj(
        Buffer.concat([
          Buffer.from(`<< /Length ${cs.length} >>\nstream\n`),
          cs,
          Buffer.from("\nendstream"),
        ]),
      ),
    );
  }

  // Link annotation objects (per page)
  const pageAnnotRefs: string[][] = [];
  for (const pg of pages) {
    const refs: string[] = [];
    for (const lk of pg.links) {
      const x1 = lk.x;
      const y1 = lk.y;
      const x2 = lk.x + lk.w;
      const y2 = lk.y + lk.h;
      const n = addObj(
        Buffer.from(
          `<< /Type /Annot /Subtype /Link ` +
            `/Rect [${x1.toFixed(1)} ${y1.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}] ` +
            `/Border [0 0 0] ` +
            `/A << /Type /Action /S /URI /URI (${pdfEscape(lk.url)}) >> >>`,
        ),
      );
      refs.push(`${n} 0 R`);
    }
    pageAnnotRefs.push(refs);
  }

  // Page objects
  const pagesNum = objs.length + pages.length + 1;
  const pns: number[] = [];
  for (let pi = 0; pi < sns.length; pi++) {
    const sn = sns[pi];
    const annotRefs = pageAnnotRefs[pi];
    const annots = annotRefs.length > 0 ? ` /Annots [${annotRefs.join(" ")}]` : "";
    pns.push(
      addObj(
        Buffer.from(
          `<< /Type /Page /Parent ${pagesNum} 0 R ` +
            `/MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
            `/Contents ${sn} 0 R` +
            `${annots} ` +
            `/Resources << /Font << ${fd} >>${xod} >> >>`,
        ),
      ),
    );
  }

  // Pages
  const kids = pns.map((n) => `${n} 0 R`).join(" ");
  const pgs = addObj(Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${total} >>`));

  // Catalog
  const cat = addObj(Buffer.from(`<< /Type /Catalog /Pages ${pgs} 0 R >>`));

  // ── Serialize ─────────────────────────────────────────────────────────
  const parts: Buffer[] = [];
  // PDF header with binary comment (raw bytes, not UTF-8)
  parts.push(
    Buffer.from([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3,
      0x0a,
    ]),
  );
  const offs: number[] = [];
  let currentLen = parts[0].length;

  for (let i = 0; i < objs.length; i++) {
    offs.push(currentLen);
    const header = Buffer.from(`${i + 1} 0 obj\n`);
    const footer = Buffer.from("\nendobj\n");
    parts.push(header, objs[i], footer);
    currentLen += header.length + objs[i].length + footer.length;
  }

  const xref = currentLen;
  const xrefHeader = Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`);
  parts.push(xrefHeader);
  currentLen += xrefHeader.length;

  for (const off of offs) {
    const entry = Buffer.from(`${off.toString().padStart(10, "0")} 00000 n \n`);
    parts.push(entry);
    currentLen += entry.length;
  }

  const trailer = Buffer.from(
    `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\n` +
      `startxref\n${xref}\n%%EOF\n`,
  );
  parts.push(trailer);

  return Buffer.concat(parts);
}
