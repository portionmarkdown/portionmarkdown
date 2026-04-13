/**
 * Parse markdown-generated HTML into layout blocks.
 */

import { Parser } from "htmlparser2";
import type { Block, TextRun, TableCell, MarkingDef, MarkingDefs } from "./types";
import { HEADING_SZ, pmColor } from "./config";

export interface ParseResult {
  blocks: Block[];
  footnotes: Map<number, string>;
}

export function parseHtml(html: string, markingDefs: MarkingDefs): ParseResult {
  const blocks: Block[] = [];
  const mdefs = markingDefs;
  const footnotes = new Map<number, string>();

  // State
  const tagStack: string[] = [];
  let runs: TextRun[] = [];
  let bold = false;
  let italic = false;
  let strikethrough = false;
  let code = false;
  let pre = false;
  let preBuf = "";
  let preLang: string | null = null;
  let preLineno: number | null = null;
  const listStack: Array<{ kind: string; idx: number }> = [];
  let btag: string | null = null;
  let bmeta: { pfx?: string; ind?: number } = {};
  let linkHref: string | null = null;
  let suppressText = false;
  let blockquoteDepth = 0;
  let _inTable = false;
  let tableRows: TableCell[][] = [];
  let curRow: TableCell[] = [];
  let _inThead = false;
  let inCell = false;
  const markingStack: MarkingDef[] = [];

  // Footnote ref state
  let fnrefNum: number | null = null;

  function currentMarking(): MarkingDef | null {
    return markingStack.length > 0 ? markingStack[markingStack.length - 1] : null;
  }

  function currentFont(): string {
    if (code || pre) return "Courier";
    if (bold) return "Helvetica-Bold";
    if (italic) return "Helvetica-Oblique";
    return "Helvetica";
  }

  function flush(): void {
    if (inCell) return;
    if (pre && preBuf) {
      blocks.push({
        type: "code",
        text: preBuf.replace(/\n+$/, ""),
        lang: preLang,
        linenoStart: preLineno,
        marking: currentMarking(),
        indent: 0,
        size: 9,
        sb: 3,
        sa: 3,
      });
      preBuf = "";
      preLang = null;
      preLineno = null;
      return;
    }
    if (runs.length === 0) return;
    // Drop runs that are purely whitespace — but keep runs containing \n
    // because those are intentional <br> line breaks (text-node newlines
    // are already normalised to spaces in ontext, so any remaining \n
    // must have come from a <br> tag).
    if (
      runs.every((r) => r.text.trim() === "") &&
      !runs.some((r) => r.text.includes("\n"))
    ) {
      runs = [];
      btag = null;
      bmeta = {};
      return;
    }
    const tag = btag || "p";
    const m = bmeta;
    const bqInd = blockquoteDepth * 36;
    if (tag in HEADING_SZ) {
      const headingRuns = runs.map((r) => {
        const hr: TextRun = { text: r.text, font: "Helvetica-Bold" };
        if (r.footnoteRef != null) hr.footnoteRef = r.footnoteRef;
        return hr;
      });
      blocks.push({
        type: "heading",
        runs: headingRuns,
        marking: currentMarking(),
        size: HEADING_SZ[tag],
        indent: bqInd,
        sb: 8,
        sa: 2,
        ...(blockquoteDepth > 0 && { blockquote: true }),
      });
    } else if (tag === "li") {
      const pfx = m.pfx || "-  ";
      const liRuns: TextRun[] = [{ text: pfx, font: "Helvetica" }, ...runs];
      blocks.push({
        type: "para",
        runs: liRuns,
        marking: currentMarking(),
        isLi: true,
        size: 11,
        indent: (m.ind || 0) + bqInd,
        sb: 1,
        sa: 1,
        ...(blockquoteDepth > 0 && { blockquote: true }),
      });
    } else {
      blocks.push({
        type: "para",
        runs: [...runs],
        marking: currentMarking(),
        isLi: false,
        size: 11,
        indent: bqInd,
        sb: 2,
        sa: 2,
        ...(blockquoteDepth > 0 && { blockquote: true }),
      });
    }
    runs = [];
    btag = null;
    bmeta = {};
  }

  const parser = new Parser(
    {
      onopentag(name: string, attribs: Record<string, string>) {
        tagStack.push(name);

        // Custom footnote reference tag: <fnref num="1">
        if (name === "fnref") {
          const num = parseInt(attribs.num, 10);
          if (!isNaN(num)) fnrefNum = num;
          return;
        }

        if (
          name === "p" ||
          name === "h1" ||
          name === "h2" ||
          name === "h3" ||
          name === "h4" ||
          name === "h5" ||
          name === "h6"
        ) {
          flush();
          btag = name;
        } else if (name === "li") {
          flush();
          btag = "li";
          if (listStack.length > 0) {
            const ls = listStack[listStack.length - 1];
            const d = listStack.length;
            if (ls.kind === "ol") {
              ls.idx++;
              bmeta = { pfx: `${ls.idx}. `, ind: 12 + 36 * (d - 1) };
            } else {
              bmeta = { pfx: "-  ", ind: 12 + 36 * (d - 1) };
            }
          }
        } else if (name === "ul") {
          listStack.push({ kind: "ul", idx: 0 });
        } else if (name === "ol") {
          listStack.push({ kind: "ol", idx: 0 });
        } else if (name === "strong" || name === "b") {
          bold = true;
        } else if (name === "em" || name === "i") {
          italic = true;
        } else if (name === "s" || name === "del") {
          strikethrough = true;
        } else if (name === "code" && pre) {
          if (attribs.class) {
            for (const cls of attribs.class.split(" ")) {
              if (cls.startsWith("language-")) {
                preLang = cls.slice(9);
                break;
              }
            }
          }
          if (attribs.startline) {
            const n = parseInt(attribs.startline, 10);
            if (!isNaN(n)) preLineno = n;
          }
        } else if (name === "code" && !pre) {
          code = true;
        } else if (name === "pre") {
          flush();
          pre = true;
          if (attribs.class && attribs.class.split(" ").includes("linenos")) {
            preLineno = 1;
          }
        } else if (name === "br") {
          if (!pre) {
            runs.push({ text: "\n", font: currentFont() });
          }
        } else if (name === "hr") {
          flush();
          blocks.push({ type: "hr", sb: 4, sa: 4 });
        } else if (name === "pagebreak") {
          flush();
          blocks.push({ type: "pagebreak", sb: 0, sa: 0 });
        } else if (name === "table") {
          flush();
          _inTable = true;
          tableRows = [];
        } else if (name === "thead") {
          _inThead = true;
        } else if (name === "tr") {
          curRow = [];
        } else if (name === "td" || name === "th") {
          runs = [];
          inCell = true;
        } else if (name === "img") {
          flush();
          const src = attribs.src || "";
          const alt = attribs.alt || "";
          let sizing: "original" | "fit" | "pct" = "original";
          let widthPct: number | null = null;
          if (attribs.class && attribs.class.split(" ").includes("fit")) {
            sizing = "fit";
          }
          if (attribs.width) {
            const v = attribs.width.trim();
            if (v.endsWith("%")) {
              const pct = parseFloat(v.slice(0, -1));
              if (!isNaN(pct)) {
                widthPct = pct / 100;
                sizing = "pct";
              }
            }
          }
          if (src) {
            blocks.push({
              type: "image",
              src,
              alt,
              sizing,
              widthPct,
              marking: currentMarking(),
              sb: 4,
              sa: 4,
            });
          }
        } else if (name === "blockquote") {
          flush();
          blockquoteDepth++;
        } else if (name === "a") {
          const href = attribs.href || "";
          if (attribs.class && attribs.class.includes("footnote-backref")) {
            suppressText = true;
          } else if (!href.startsWith("#")) {
            linkHref = href || null;
          }
        } else if (name === "section") {
          flush();
        } else if (name === "div") {
          flush();
          const markingKey = attribs.marking;
          if (markingKey) {
            const key = markingKey.trim();
            if (mdefs[key]) {
              markingStack.push(mdefs[key]);
            } else {
              markingStack.push({
                short: key,
                long: key,
                color: pmColor(key),
              });
            }
          }
        }
      },

      onclosetag(name: string) {
        if (tagStack.length > 0 && tagStack[tagStack.length - 1] === name) {
          tagStack.pop();
        }

        // Custom footnote reference close
        if (name === "fnref") {
          fnrefNum = null;
          return;
        }

        if (name === "div") {
          flush();
          if (markingStack.length > 0) {
            markingStack.pop();
          }
          return;
        }

        if (
          name === "p" ||
          name === "h1" ||
          name === "h2" ||
          name === "h3" ||
          name === "h4" ||
          name === "h5" ||
          name === "h6" ||
          name === "li"
        ) {
          flush();
        } else if ((name === "ul" || name === "ol") && listStack.length > 0) {
          listStack.pop();
        } else if (name === "strong" || name === "b") {
          bold = false;
        } else if (name === "em" || name === "i") {
          italic = false;
        } else if (name === "s" || name === "del") {
          strikethrough = false;
        } else if (name === "blockquote") {
          flush();
          if (blockquoteDepth > 0) blockquoteDepth--;
        } else if (name === "a") {
          linkHref = null;
          suppressText = false;
        } else if (name === "section") {
          flush();
        } else if (name === "code" && !pre) {
          code = false;
        } else if (name === "pre") {
          flush();
          pre = false;
        } else if (name === "td" || name === "th") {
          curRow.push({ runs: [...runs], header: name === "th" });
          runs = [];
          inCell = false;
        } else if (name === "tr") {
          if (curRow.length > 0) {
            tableRows.push(curRow);
          }
          curRow = [];
        } else if (name === "thead") {
          _inThead = false;
        } else if (name === "table") {
          if (tableRows.length > 0) {
            blocks.push({
              type: "table",
              rows: tableRows,
              marking: currentMarking(),
              size: 10,
              sb: 4,
              sa: 4,
            });
          }
          _inTable = false;
          tableRows = [];
        }
      },

      ontext(data: string) {
        if (suppressText) return;

        if (pre) {
          preBuf += data;
        } else if (data) {
          // In HTML, newlines in text nodes are whitespace, not line breaks.
          // Explicit line breaks come from <br> tags (handled in onopentag).
          // Collapse whitespace: \n→space, then merge consecutive spaces
          const text = data.replace(/\s+/g, " ");
          if (!text.trim()) return; // skip whitespace-only text nodes
          const run: TextRun = { text, font: currentFont() };
          if (linkHref) run.link = linkHref;
          if (fnrefNum != null) run.footnoteRef = fnrefNum;
          if (strikethrough) run.strikethrough = true;
          runs.push(run);
        }
      },
    },
    { decodeEntities: true, recognizeSelfClosing: true },
  );

  parser.write(html);
  parser.end();
  flush();

  return { blocks, footnotes };
}
