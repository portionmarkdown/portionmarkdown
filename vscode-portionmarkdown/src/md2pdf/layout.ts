/**
 * Layout engine — flow blocks onto pages.
 * Port of Python's _layout() function.
 */

import * as path from "path";
import type { Block, ImageInfo, MarkingDefs, TextRun, RGB } from "./types";
import {
  PAGE_W,
  MARGIN,
  CONTENT_W,
  CONTENT_TOP,
  CONTENT_BOT,
  FOOTER_Y,
  CB_LINE_H,
  PM_SZ,
  CLR_CODE_BG,
  CLR_CODE_LN,
  CLR_HEADING,
  CLR_TEXT,
  CLR_TBL_HDR_BG,
  CLR_TBL_HDR_FG,
  CLR_TBL_LINE,
  CLR_TBL_ALT,
  CLR_RULE,
  CLR_LINK,
} from "./config";
import { textWidth } from "./fontMetrics";
import { highlight } from "./highlight";
import { loadImage } from "./imageLoader";
import { wrap } from "./wrap";
import { Pg } from "./page";

const CLR_BLACK: RGB = [0, 0, 0];

/** Parse simple inline markdown (bold, italic, code, links) into TextRuns. */
function parseInlineMarkdown(text: string): TextRun[] {
  const runs: TextRun[] = [];
  // Regex matches: `code`, [text](url), ***bolditalic***, **bold**, *italic*, or plain text
  const re =
    /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      runs.push({ text: text.slice(last, m.index), font: "Helvetica" });
    }
    if (m[1] != null) {
      // `code`
      runs.push({ text: m[1], font: "Courier" });
    } else if (m[2] != null) {
      // [text](url)
      runs.push({ text: m[2], font: "Helvetica", link: m[3] });
    } else if (m[4] != null) {
      // ***bold italic*** — no bold-oblique font available, use bold
      runs.push({ text: m[4], font: "Helvetica-Bold" });
    } else if (m[5] != null) {
      // **bold**
      runs.push({ text: m[5], font: "Helvetica-Bold" });
    } else if (m[6] != null) {
      // *italic*
      runs.push({ text: m[6], font: "Helvetica-Oblique" });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    runs.push({ text: text.slice(last), font: "Helvetica" });
  }
  return runs;
}

interface BlockLines {
  cbLines: string[];
  cuiLines: string[];
}

export function layout(
  blocks: Block[],
  srcDir: string | null,
  images: ImageInfo[],
  markingDefs: MarkingDefs,
  blockLines: BlockLines,
  footnoteDefs?: Map<number, string>,
  preloadedImages?: Map<string, ImageInfo>,
): Pg[] {
  // Build lookup for in-cell portion marking detection
  const cellPm: Record<string, RGB> = {};
  for (const md of Object.values(markingDefs)) {
    cellPm[`(${md.short})`] = md.color;
  }

  const pages: Pg[] = [new Pg()];
  let y = CONTENT_TOP;
  const LH = 1.25;
  const pmLh = PM_SZ * LH;

  // ── Classification/CUI block geometry (page 1) ─────────────────────
  const boxPad = 4;
  const boxFs = 8;
  const { cbLines, cuiLines } = blockLines;
  const maxBlockW = CONTENT_W * 0.55;

  /** Wrap plain text lines to fit within maxW at the given font/size. */
  function wrapBlkLines(lines: string[], maxW: number): string[] {
    const out: string[] = [];
    for (const line of lines) {
      if (textWidth(line, "Helvetica", boxFs) <= maxW) {
        out.push(line);
        continue;
      }
      const words = line.split(" ");
      let cur = "";
      let curW = 0;
      for (const word of words) {
        const ww = textWidth(word, "Helvetica", boxFs);
        const sw = textWidth(" ", "Helvetica", boxFs);
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

  const wrappedCb = wrapBlkLines(cbLines, maxBlockW - 2 * boxPad);
  const wrappedCui = wrapBlkLines(cuiLines, maxBlockW - 2 * boxPad);

  function blkH(lines: string[]): number {
    return lines.length > 0 ? boxFs + (lines.length - 1) * CB_LINE_H + 2 * boxPad : 0;
  }

  const blocksH = blkH(wrappedCb) + blkH(wrappedCui);

  // Width of the cls/cui block column (right-aligned)
  const cbW =
    wrappedCb.length > 0
      ? Math.max(...wrappedCb.map((ln) => textWidth(ln, "Helvetica", boxFs))) + 2 * boxPad
      : 0;
  const cuiW =
    wrappedCui.length > 0
      ? Math.max(...wrappedCui.map((ln) => textWidth(ln, "Helvetica", boxFs))) +
        2 * boxPad
      : 0;
  const clsBlockW = Math.max(cbW, cuiW);

  // ── Footnote tracking ──────────────────────────────────────────────
  const FN_SZ = 8;
  const FN_LH = FN_SZ * LH;
  const FN_BASE = FOOTER_Y + 14; // footnotes anchor just above footer

  interface PageFootnote {
    num: number;
    lines: TextRun[][];
  }

  const pageFn: PageFootnote[][] = [[]];

  function fnAreaHeight(): number {
    const fns = pageFn[pageFn.length - 1];
    if (fns.length === 0) return 0;
    const totalLines = fns.reduce((s, f) => s + f.lines.length, 0);
    return 8 + totalLines * FN_LH;
  }

  function addFootnote(num: number): void {
    const fns = pageFn[pageFn.length - 1];
    if (fns.some((f) => f.num === num)) return;
    const text = footnoteDefs?.get(num);
    if (!text) return;
    // On page 1 with cls/cui blocks, use narrower width so footnotes
    // don't collide with the right-aligned blocks
    const fnW =
      pages.length === 1 && clsBlockW > 0 ? CONTENT_W - clsBlockW - 8 : CONTENT_W;
    const fnRuns: TextRun[] = [
      { text: `${num}. `, font: "Helvetica-Bold" },
      ...parseInlineMarkdown(text),
    ];
    const lines = wrap(fnRuns, fnW, FN_SZ);
    fns.push({ num, lines });
  }

  function removeFootnote(num: number): void {
    const fns = pageFn[pageFn.length - 1];
    const idx = fns.findIndex((f) => f.num === num);
    if (idx >= 0) fns.splice(idx, 1);
  }

  function collectFootnoteRefs(lineRuns: TextRun[]): number[] {
    const refs: number[] = [];
    for (const r of lineRuns) {
      if (r.footnoteRef != null && !refs.includes(r.footnoteRef)) {
        refs.push(r.footnoteRef);
      }
    }
    return refs;
  }

  // Content bottom: content must clear both cls/cui blocks AND footnotes
  const contentBotP1 = Math.max(FN_BASE + blocksH + 10, CONTENT_BOT);

  function getContentBot(): number {
    const fnTop = FN_BASE + fnAreaHeight();
    if (pages.length === 1) {
      return Math.max(contentBotP1, fnTop, CONTENT_BOT);
    }
    return Math.max(fnTop, CONTENT_BOT);
  }

  function newPage(): void {
    pages.push(new Pg());
    pageFn.push([]);
    y = CONTENT_TOP;
  }

  for (const b of blocks) {
    const sb = b.sb;
    const sa = b.sa;
    const sz = "size" in b ? b.size : 11;
    const ind = "indent" in b ? b.indent : 0;
    const lh = sz * LH;

    if (b.type === "pagebreak") {
      newPage();
      continue;
    }

    if (b.type === "hr") {
      y -= sb;
      if (y < getContentBot()) newPage();
      pages[pages.length - 1].line(MARGIN, y, PAGE_W - MARGIN, y, 0.6, CLR_RULE);
      y -= sa;
      continue;
    }

    if (b.type === "code") {
      const rawHlLines = highlight(b.text, b.lang);
      const lineno = b.linenoStart;
      const pm = b.marking;
      let gutterW = 0;
      if (lineno !== null) {
        const maxLn = lineno + rawHlLines.length - 1;
        gutterW = textWidth(String(maxLn), "Courier", sz) + 10;
      }
      // Wrap long code lines to fit within available width
      const codeMaxW = CONTENT_W - ind - gutterW + 4;
      const charW = textWidth("x", "Courier", sz); // monospace
      const maxChars = Math.max(1, Math.floor(codeMaxW / charW));
      type HlToken = { text: string; color: RGB };
      const hlLines: HlToken[][] = [];
      for (const line of rawHlLines) {
        // Measure total chars in this line
        const totalText = line.map((t) => t.text).join("");
        if (totalText.length <= maxChars) {
          hlLines.push(line);
        } else {
          // Split tokens into chunks that fit maxChars
          const remaining: HlToken[] = [...line];
          while (remaining.length > 0) {
            const row: HlToken[] = [];
            let used = 0;
            while (remaining.length > 0 && used < maxChars) {
              const tok = remaining[0];
              const avail = maxChars - used;
              if (tok.text.length <= avail) {
                row.push(tok);
                used += tok.text.length;
                remaining.shift();
              } else {
                row.push({ text: tok.text.slice(0, avail), color: tok.color });
                remaining[0] = { text: tok.text.slice(avail), color: tok.color };
                used = maxChars;
              }
            }
            hlLines.push(row);
          }
        }
      }
      y -= sb;

      // Top portion marking
      if (pm) {
        if (y - pmLh < getContentBot()) newPage();
        y -= pmLh;
        const prefix = "Figure is ";
        const pg = pages[pages.length - 1];
        let lx = MARGIN + ind;
        pg.text(lx, y, prefix, "Helvetica-Bold", PM_SZ, CLR_BLACK);
        lx += textWidth(prefix, "Helvetica-Bold", PM_SZ);
        pg.text(lx, y, pm.long, "Helvetica-Bold", PM_SZ, pm.color);
        y -= 3;
      }

      // Track per-page rect regions for code background (inserted behind text)
      const codeRects: {
        pageIdx: number;
        opsIdx: number;
        topY: number;
        botY: number;
      }[] = [];

      // Only break page if we can't fit at least one line (not the whole block)
      if (y - lh < getContentBot()) newPage();

      let rectTop = y;
      let rectPageIdx = pages.length - 1;
      let rectOpsIdx = pages[rectPageIdx].ops.length;

      for (let li = 0; li < hlLines.length; li++) {
        if (y - lh < getContentBot()) {
          // Close rect on current page before breaking
          codeRects.push({
            pageIdx: rectPageIdx,
            opsIdx: rectOpsIdx,
            topY: rectTop,
            botY: y,
          });
          // Draw bottom PM on current page
          if (pm) {
            y -= pmLh;
            const prefix = "Figure is ";
            const fullW = textWidth(prefix + pm.long, "Helvetica-Bold", PM_SZ);
            let lx = Math.max(MARGIN, MARGIN + CONTENT_W - fullW);
            const pg = pages[pages.length - 1];
            pg.text(lx, y, prefix, "Helvetica-Bold", PM_SZ, CLR_BLACK);
            lx += textWidth(prefix, "Helvetica-Bold", PM_SZ);
            pg.text(lx, y, pm.long, "Helvetica-Bold", PM_SZ, pm.color);
          }
          newPage();
          // Draw top PM on new page (continued)
          if (pm) {
            y -= pmLh;
            const prefix = "Figure is ";
            const pg = pages[pages.length - 1];
            let lx = MARGIN + ind;
            pg.text(lx, y, prefix, "Helvetica-Bold", PM_SZ, CLR_BLACK);
            lx += textWidth(prefix, "Helvetica-Bold", PM_SZ);
            pg.text(lx, y, pm.long + " (continued)", "Helvetica-Bold", PM_SZ, pm.color);
            y -= 3;
          }
          rectTop = y;
          rectPageIdx = pages.length - 1;
          rectOpsIdx = pages[rectPageIdx].ops.length;
        }
        y -= lh;
        let x = MARGIN + ind;
        if (lineno !== null) {
          const lnStr = String(lineno + li);
          const lnW = textWidth(lnStr, "Courier", sz);
          pages[pages.length - 1].text(
            x + gutterW - lnW - 6,
            y,
            lnStr,
            "Courier",
            sz,
            CLR_CODE_LN,
          );
          x += gutterW;
        }
        for (const tok of hlLines[li]) {
          pages[pages.length - 1].text(x, y, tok.text, "Courier", sz, tok.color);
          x += textWidth(tok.text, "Courier", sz);
        }
      }

      // Close final rect segment and insert background rects behind text
      codeRects.push({
        pageIdx: rectPageIdx,
        opsIdx: rectOpsIdx,
        topY: rectTop,
        botY: y - 3,
      });
      for (const cr of codeRects) {
        const h = cr.topY - cr.botY;
        if (h > 0) {
          const rx = MARGIN + ind - 4;
          const rw = CONTENT_W - ind + 8;
          const c = `${CLR_CODE_BG[0].toFixed(3)} ${CLR_CODE_BG[1].toFixed(3)} ${CLR_CODE_BG[2].toFixed(3)}`;
          const op = `q ${c} rg ${rx.toFixed(1)} ${cr.botY.toFixed(1)} ${rw.toFixed(1)} ${h.toFixed(1)} re f Q`;
          pages[cr.pageIdx].ops.splice(cr.opsIdx, 0, op);
        }
      }

      // Bottom portion marking
      if (pm) {
        y -= 6;
        y -= pmLh;
        const prefix = "Figure is ";
        const fullW = textWidth(prefix + pm.long, "Helvetica-Bold", PM_SZ);
        // Right-align to content edge, but clamp to left margin
        let lx = Math.max(MARGIN, MARGIN + CONTENT_W - fullW);
        const pg = pages[pages.length - 1];
        pg.text(lx, y, prefix, "Helvetica-Bold", PM_SZ, CLR_BLACK);
        lx += textWidth(prefix, "Helvetica-Bold", PM_SZ);
        pg.text(lx, y, pm.long, "Helvetica-Bold", PM_SZ, pm.color);
      }
      y -= sa;
      continue;
    }

    if (b.type === "image") {
      const imgSrc = decodeURIComponent(b.src);
      let imgInfo = preloadedImages?.get(imgSrc) ?? null;
      if (!imgInfo) {
        const imgPath = path.isAbsolute(imgSrc)
          ? imgSrc
          : path.join(srcDir || ".", imgSrc);
        imgInfo = loadImage(imgPath);
      }
      if (!imgInfo) {
        // Show placeholder for missing image
        const msg = `[Image not found: ${imgSrc}]`;
        y -= sb;
        if (y - lh < getContentBot()) newPage();
        y -= lh;
        const CLR_ERR: RGB = [0.8, 0, 0];
        pages[pages.length - 1].text(
          MARGIN + ind,
          y,
          msg,
          "Helvetica-Oblique",
          sz,
          CLR_ERR,
        );
        y -= sa;
        continue;
      }

      const pm = b.marking;
      const imgName = `Im${images.length + 1}`;
      imgInfo.name = imgName;
      images.push(imgInfo);

      let scale: number;
      if (b.sizing === "fit") {
        scale = CONTENT_W / imgInfo.width;
      } else if (b.sizing === "pct") {
        scale = (CONTENT_W * (b.widthPct || 1.0)) / imgInfo.width;
      } else {
        scale = Math.min(CONTENT_W / imgInfo.width, 1.0);
      }

      // Clamp: never exceed content width
      scale = Math.min(scale, CONTENT_W / imgInfo.width);
      let dispW = imgInfo.width * scale;
      let dispH = imgInfo.height * scale;
      const maxH = CONTENT_TOP - getContentBot() - 40;
      if (dispH > maxH) {
        const s2 = maxH / dispH;
        dispW *= s2;
        dispH *= s2;
      }

      let totalH = dispH;
      if (pm) totalH += 2 * pmLh + 4;

      y -= sb;
      if (y - totalH < getContentBot()) newPage();

      if (pm) {
        y -= pmLh;
        const prefix = "Figure is ";
        const pg = pages[pages.length - 1];
        let lx = MARGIN;
        pg.text(lx, y, prefix, "Helvetica-Bold", PM_SZ, CLR_BLACK);
        lx += textWidth(prefix, "Helvetica-Bold", PM_SZ);
        pg.text(lx, y, pm.long, "Helvetica-Bold", PM_SZ, pm.color);
        y -= 3;
      }

      pages[pages.length - 1].image(MARGIN, y - dispH, dispW, dispH, imgName);
      y -= dispH;

      if (pm) {
        y -= pmLh;
        const prefix = "Figure is ";
        const fullW = textWidth(prefix + pm.long, "Helvetica-Bold", PM_SZ);
        // Right-align to image edge, but clamp to left margin if label is wider
        let lx = fullW > dispW ? MARGIN : MARGIN + dispW - fullW;
        const pg = pages[pages.length - 1];
        pg.text(lx, y, prefix, "Helvetica-Bold", PM_SZ, CLR_BLACK);
        lx += textWidth(prefix, "Helvetica-Bold", PM_SZ);
        pg.text(lx, y, pm.long, "Helvetica-Bold", PM_SZ, pm.color);
      }
      y -= sa;
      continue;
    }

    if (b.type === "table") {
      const rows = b.rows;
      const ncols = Math.max(...rows.map((r) => r.length), 0);
      if (ncols === 0) continue;

      const pm = b.marking;
      const cellPadding = 6;

      // Measure natural and minimum widths
      const nat = new Array(ncols).fill(0);
      const minCw = new Array(ncols).fill(0);
      for (const row of rows) {
        for (let ci = 0; ci < Math.min(row.length, ncols); ci++) {
          const cell = row[ci];
          let cellRuns = cell.runs;
          if (cell.header) {
            cellRuns = cellRuns.map((r) => ({
              text: r.text,
              font: "Helvetica-Bold",
            }));
          }
          nat[ci] = Math.max(
            nat[ci],
            cellRuns.reduce((s, r) => s + textWidth(r.text, r.font, sz), 0) +
              2 * cellPadding,
          );
          for (const r of cellRuns) {
            for (const word of r.text.split(" ")) {
              if (word) {
                minCw[ci] = Math.max(
                  minCw[ci],
                  textWidth(word, r.font, sz) + 2 * cellPadding,
                );
              }
            }
          }
        }
      }

      // Ensure minimums
      for (let ci = 0; ci < ncols; ci++) {
        minCw[ci] = Math.max(minCw[ci], 30);
      }

      // Allocate column widths
      const totalMin = minCw.reduce((a, b) => a + b, 0);
      let colW: number[];
      if (totalMin >= CONTENT_W) {
        colW = minCw.map((m) => (m * CONTENT_W) / totalMin);
      } else {
        const extra = CONTENT_W - totalMin;
        const want = nat.map((n, ci) => Math.max(n - minCw[ci], 0));
        const tw = want.reduce((a, b) => a + b, 0) || 1;
        colW = minCw.map((m, ci) => m + (extra * want[ci]) / tw);
      }
      const tableW = colW.reduce((a, b) => a + b, 0);

      y -= sb;

      // Top portion marking
      if (pm) {
        if (y - pmLh < getContentBot()) newPage();
        y -= pmLh;
        const prefix = "Table is ";
        const pg = pages[pages.length - 1];
        let lx = MARGIN;
        pg.text(lx, y, prefix, "Helvetica-Bold", PM_SZ, CLR_BLACK);
        lx += textWidth(prefix, "Helvetica-Bold", PM_SZ);
        pg.text(lx, y, pm.long, "Helvetica-Bold", PM_SZ, pm.color);
        y -= 3;
      }

      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        const isHdr = row.some((c) => c.header);

        // Wrap cells and compute row height
        const cellsWrapped: TextRun[][][] = [];
        let maxNlines = 1;
        for (let ci = 0; ci < ncols; ci++) {
          let w: TextRun[][];
          if (ci < row.length) {
            const cell = row[ci];
            let cellRuns = cell.runs;
            if (cell.header) {
              cellRuns = cellRuns.map((r) => ({
                text: r.text,
                font: "Helvetica-Bold",
              }));
            }
            w = wrap(cellRuns, Math.max(colW[ci] - 2 * cellPadding, 10), sz);
          } else {
            w = [[{ text: "", font: "Helvetica" }]];
          }
          cellsWrapped.push(w);
          maxNlines = Math.max(maxNlines, w.length);
        }

        const topPad = 2;
        const rowH = maxNlines * lh + topPad + cellPadding;

        // Helper to draw table PM labels
        function drawTblPmBot(): void {
          if (!pm) return;
          y -= pmLh;
          const prefix = "Table is ";
          const fullW = textWidth(prefix + pm.long, "Helvetica-Bold", PM_SZ);
          const lx = Math.max(MARGIN, MARGIN + tableW - fullW);
          const pg2 = pages[pages.length - 1];
          pg2.text(lx, y, prefix, "Helvetica-Bold", PM_SZ, CLR_BLACK);
          pg2.text(
            lx + textWidth(prefix, "Helvetica-Bold", PM_SZ),
            y,
            pm.long,
            "Helvetica-Bold",
            PM_SZ,
            pm.color,
          );
        }
        function drawTblPmTop(): void {
          if (!pm) return;
          y -= pmLh;
          const prefix = "Table is ";
          const pg2 = pages[pages.length - 1];
          pg2.text(MARGIN, y, prefix, "Helvetica-Bold", PM_SZ, CLR_BLACK);
          pg2.text(
            MARGIN + textWidth(prefix, "Helvetica-Bold", PM_SZ),
            y,
            pm.long + " (continued)",
            "Helvetica-Bold",
            PM_SZ,
            pm.color,
          );
          y -= 3;
        }

        // Check if row fits on current page
        if (y - rowH < getContentBot()) {
          // If row fits on a fresh page, just break
          const freshPageSpace = CONTENT_TOP - CONTENT_BOT;
          if (rowH <= freshPageSpace) {
            drawTblPmBot();
            newPage();
            drawTblPmTop();
          } else {
            // Row is taller than a page — render line by line with page breaks
            drawTblPmBot();
            newPage();
            drawTblPmTop();
            const txtClr = isHdr ? CLR_TBL_HDR_FG : CLR_TEXT;
            for (let lineIdx = 0; lineIdx < maxNlines; lineIdx++) {
              if (y - lh < getContentBot()) {
                drawTblPmBot();
                newPage();
                drawTblPmTop();
              }
              y -= lh;
              let x = MARGIN;
              const pg2 = pages[pages.length - 1];
              for (let ci = 0; ci < cellsWrapped.length; ci++) {
                const clines = cellsWrapped[ci];
                const cw = colW[ci];
                if (lineIdx < clines.length) {
                  let tx = x + cellPadding;
                  for (const r of clines[lineIdx]) {
                    if (r.footnoteRef != null) {
                      addFootnote(r.footnoteRef);
                      const supSz = sz * 0.65;
                      const rw = textWidth(r.text, r.font, supSz);
                      pg2.text(tx, y + sz * 0.35, r.text, r.font, supSz, txtClr);
                      tx += rw;
                      continue;
                    }
                    const rw = textWidth(r.text, r.font, sz);
                    const c =
                      r.font === "Helvetica-Bold" && r.text in cellPm
                        ? cellPm[r.text]
                        : null;
                    if (r.link && !c) {
                      pg2.text(tx, y, r.text, r.font, sz, CLR_LINK);
                      pg2.line(tx, y - 1, tx + rw, y - 1, 0.4, CLR_LINK);
                      pg2.addLink(tx, y - 2, rw, sz + 2, r.link);
                    } else {
                      pg2.text(tx, y, r.text, r.font, sz, c || txtClr);
                      if (r.strikethrough) {
                        pg2.line(
                          tx,
                          y + sz * 0.3,
                          tx + rw,
                          y + sz * 0.3,
                          0.5,
                          c || txtClr,
                        );
                      }
                    }
                    tx += rw;
                  }
                }
                x += cw;
              }
            }
            continue; // skip normal row rendering below
          }
        }

        const pg = pages[pages.length - 1];

        // Row background — sized to actual table width
        if (isHdr) {
          pg.rect(MARGIN, y - rowH, tableW, rowH, CLR_TBL_HDR_BG);
        } else if (ri % 2 === 0) {
          pg.rect(MARGIN, y - rowH, tableW, rowH, CLR_TBL_ALT);
        }

        // Draw cells
        let x = MARGIN;
        const txtClr = isHdr ? CLR_TBL_HDR_FG : CLR_TEXT;
        for (let ci = 0; ci < cellsWrapped.length; ci++) {
          const clines = cellsWrapped[ci];
          const cw = colW[ci];
          // Horizontal lines
          if (ri === 0) {
            pg.line(x, y, x + cw, y, 0.3, CLR_TBL_LINE);
          }
          pg.line(x, y - rowH, x + cw, y - rowH, 0.3, CLR_TBL_LINE);
          // Vertical edges
          pg.line(x, y, x, y - rowH, 0.3, CLR_TBL_LINE);
          pg.line(x + cw, y, x + cw, y - rowH, 0.3, CLR_TBL_LINE);

          let ty = y - topPad;
          for (const lr of clines) {
            ty -= lh;
            let tx = x + cellPadding;
            for (const r of lr) {
              // Footnote refs: register and render as superscript
              if (r.footnoteRef != null) {
                addFootnote(r.footnoteRef);
                const supSz = sz * 0.65;
                const supY = ty + sz * 0.35;
                const rw = textWidth(r.text, r.font, supSz);
                pg.text(tx, supY, r.text, r.font, supSz, txtClr);
                tx += rw;
                continue;
              }
              const rw = textWidth(r.text, r.font, sz);
              // Color bold runs that match a portion marking short form
              const c =
                r.font === "Helvetica-Bold" && r.text in cellPm ? cellPm[r.text] : null;
              if (r.link && !c) {
                pg.text(tx, ty, r.text, r.font, sz, CLR_LINK);
                pg.line(tx, ty - 1, tx + rw, ty - 1, 0.4, CLR_LINK);
                pg.addLink(tx, ty - 2, rw, sz + 2, r.link);
              } else {
                pg.text(tx, ty, r.text, r.font, sz, c || txtClr);
                if (r.strikethrough) {
                  pg.line(tx, ty + sz * 0.3, tx + rw, ty + sz * 0.3, 0.5, c || txtClr);
                }
              }
              tx += rw;
            }
          }
          x += cw;
        }
        y -= rowH;
      }

      // Bottom portion marking
      if (pm) {
        if (y - pmLh < getContentBot()) newPage();
        y -= pmLh;
        const prefix = "Table is ";
        const fullW = textWidth(prefix + pm.long, "Helvetica-Bold", PM_SZ);
        let lx = Math.max(MARGIN, MARGIN + tableW - fullW);
        const pg = pages[pages.length - 1];
        pg.text(lx, y, prefix, "Helvetica-Bold", PM_SZ, CLR_BLACK);
        lx += textWidth(prefix, "Helvetica-Bold", PM_SZ);
        pg.text(lx, y, pm.long, "Helvetica-Bold", PM_SZ, pm.color);
      }
      y -= sa;
      continue;
    }

    // paragraph / heading
    if (b.type === "para" || b.type === "heading") {
      let runs = b.runs;
      if (runs.length === 0) continue;

      const pm = b.marking;
      const pmWords = new Set<string>();
      const isBq = b.blockquote === true;

      if (pm) {
        const pmPrefix = `(${pm.short})`;
        runs = [...runs];
        if (b.type === "para" && b.isLi && runs.length > 0) {
          runs.splice(1, 0, {
            text: pmPrefix + " ",
            font: "Helvetica-Bold",
          });
        } else {
          runs.unshift({ text: pmPrefix + " ", font: "Helvetica-Bold" });
        }
        pmWords.add(pmPrefix);
      }

      const mw = CONTENT_W - ind;
      const wrapped = wrap(runs, mw, sz);
      const clr = b.type === "heading" ? CLR_HEADING : CLR_TEXT;

      y -= isBq ? Math.max(sb, 6) : sb;

      // Draw blockquote background before text
      if (isBq) {
        const bqH = wrapped.length * lh + 6;
        const bqX = MARGIN + ind - 12;
        const bqW = CONTENT_W - ind + 16;
        if (y - bqH < getContentBot()) newPage();
        pages[pages.length - 1].rect(bqX, y - bqH, bqW, bqH, CLR_CODE_BG);
        pages[pages.length - 1].line(bqX, y, bqX, y - bqH, 2, CLR_RULE);
      }

      for (let li = 0; li < wrapped.length; li++) {
        // Add any footnotes referenced on this line before checking fit
        const fnRefs = collectFootnoteRefs(wrapped[li]);
        for (const ref of fnRefs) addFootnote(ref);
        if (!isBq && y - lh < getContentBot()) {
          // Line doesn't fit — remove tentative footnotes, move to new page
          for (const ref of fnRefs) removeFootnote(ref);
          newPage();
          for (const ref of fnRefs) addFootnote(ref);
        }
        y -= lh;
        let x = MARGIN + ind;
        const pg = pages[pages.length - 1];
        for (const r of wrapped[li]) {
          if (r.footnoteRef != null) {
            // Render as superscript: smaller + raised
            const supSz = sz * 0.65;
            const supY = y + sz * 0.35;
            pg.text(x, supY, r.text, r.font, supSz, clr);
            x += textWidth(r.text, r.font, supSz);
          } else if (r.link) {
            const rw = textWidth(r.text, r.font, sz);
            pg.text(x, y, r.text, r.font, sz, CLR_LINK);
            pg.line(x, y - 1, x + rw, y - 1, 0.4, CLR_LINK);
            pg.addLink(x, y - 2, rw, sz + 2, r.link);
            x += rw;
          } else {
            const rw = textWidth(r.text, r.font, sz);
            pg.text(x, y, r.text, r.font, sz, clr);
            if (r.strikethrough) {
              pg.line(x, y + sz * 0.3, x + rw, y + sz * 0.3, 0.5, clr);
            }
            x += rw;
          }
        }
      }
      y -= sa;
    }
  }

  // ── Render footnotes at the bottom-left of each page ────────────────
  for (let pi = 0; pi < pages.length; pi++) {
    const fns = pageFn[pi];
    if (fns.length === 0) continue;

    const pg = pages[pi];
    const totalLines = fns.reduce((s, f) => s + f.lines.length, 0);
    const areaH = 8 + totalLines * FN_LH;

    // Footnotes anchor at FN_BASE, growing upward
    let fy = FN_BASE + areaH - 4;
    pg.line(MARGIN, fy, MARGIN + CONTENT_W / 3, fy, 0.4, CLR_RULE);
    fy -= 4;

    for (const fn of fns) {
      for (const line of fn.lines) {
        fy -= FN_LH;
        let fx = MARGIN;
        for (const r of line) {
          const rw = textWidth(r.text, r.font, FN_SZ);
          if (r.link) {
            pg.text(fx, fy, r.text, r.font, FN_SZ, CLR_LINK);
            pg.line(fx, fy - 1, fx + rw, fy - 1, 0.3, CLR_LINK);
            pg.addLink(fx, fy - 2, rw, FN_SZ + 2, r.link);
          } else {
            pg.text(fx, fy, r.text, r.font, FN_SZ, CLR_TEXT);
          }
          fx += rw;
        }
      }
    }
  }

  return pages;
}
