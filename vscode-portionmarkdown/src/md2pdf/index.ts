/**
 * md2pdf — TypeScript port of md2pdf.py
 *
 * Public API: md2pdf(markdownText, options?) → Buffer
 */

import MarkdownIt from "markdown-it";
import markdownItAttrs from "markdown-it-attrs";
import type { DocConfig, ImageInfo, MarkingDefs, Md2PdfOptions } from "./types";
import { autoBannerColor, pmColor } from "./config";
import { parseHtml } from "./htmlParser";
import { layout } from "./layout";
import { buildPdf } from "./serialize";
import { validateMarkings } from "./validate";
import { watermarkPdf } from "./watermark";
import { loadFonts } from "./fonts";
import { initFontMetrics, clearFontMetrics } from "./fontMetrics";

// ── Document metadata parsing ─────────────────────────────────────────

function parseMarkingDefs(text: string): MarkingDefs {
  const defs: MarkingDefs = {};
  const m = text.match(/<!--\s*markings\b([\s\S]*?)-->/);
  if (!m) return defs;
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
    defs[key] = { short, long, color: pmColor(long) };
  }
  return defs;
}

function applyDocMeta(text: string): DocConfig {
  const config: DocConfig = {
    marking: "UNCLASSIFIED",
    markingColor: "",
    classificationBlock: "",
    cuiBlock: "",
    forceShowBlocks: false,
    exampleMode: false,
  };

  let explicitMarking: string | null = null;

  const clsMatch = text.match(/<!--\s*classification\b([\s\S]*?)-->/);
  if (clsMatch) {
    const lines: string[] = [];
    for (const line of clsMatch[1].split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (lower.startsWith("marking:")) {
        explicitMarking = trimmed.split(":").slice(1).join(":").trim();
      } else if (lower.startsWith("show-blocks:")) {
        config.forceShowBlocks = ["true", "yes", "1"].includes(
          trimmed.split(":").slice(1).join(":").trim().toLowerCase(),
        );
      } else if (lower.startsWith("example:")) {
        config.exampleMode = ["true", "yes", "1"].includes(
          trimmed.split(":").slice(1).join(":").trim().toLowerCase(),
        );
      } else {
        lines.push(trimmed);
      }
    }
    if (lines.length > 0) {
      config.classificationBlock = lines.join("\n");
    }
  }

  const cuiMatch = text.match(/<!--\s*cui\b([\s\S]*?)-->/);
  if (cuiMatch) {
    const lines = cuiMatch[1]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length > 0) {
      config.cuiBlock = lines.join("\n");
    }
  }

  if (explicitMarking) {
    config.marking = explicitMarking;
  } else if (config.cuiBlock) {
    config.marking = "CUI";
  }

  return config;
}

function getBlockLines(config: DocConfig): {
  cbLines: string[];
  cuiLines: string[];
} {
  const isUnclass = config.marking.toUpperCase().startsWith("UNCLASSIFIED");
  if (config.forceShowBlocks || !isUnclass) {
    const cb = config.classificationBlock.trim()
      ? config.classificationBlock
          .trim()
          .replace(/<br\s*\/?>/gi, "\n")
          .split("\n")
      : [];
    const cui = config.cuiBlock.trim()
      ? config.cuiBlock
          .trim()
          .replace(/<br\s*\/?>/gi, "\n")
          .split("\n")
      : [];
    return { cbLines: cb, cuiLines: cui };
  }
  return { cbLines: [], cuiLines: [] };
}

// ── Footnote pre-processor ────────────────────────────────────────────

interface FootnoteResult {
  text: string;
  defs: Map<number, string>;
  warnings: string[];
}

function processFootnotes(markdownText: string): FootnoteResult {
  const rawDefs = new Map<string, string>();
  const warnings: string[] = [];

  // Extract definitions: [^label]: text (single-line)
  const defPattern = /^\[\^([^\]]+)\]:\s*(.+)$/gm;
  let match;
  while ((match = defPattern.exec(markdownText)) !== null) {
    rawDefs.set(match[1], match[2].replace(/<br\s*\/?>/gi, "\n"));
  }

  // Remove definition lines from text
  let cleaned = markdownText.replace(/^\[\^([^\]]+)\]:\s*(.+)$/gm, "");

  // Replace references [^label] → <fnref num="N">N</fnref>
  // Number sequentially by order of first appearance
  const labelToNum = new Map<string, number>();
  let nextNum = 1;

  cleaned = cleaned.replace(/\[\^([^\]]+)\]/g, (_, label: string) => {
    if (!labelToNum.has(label)) {
      labelToNum.set(label, nextNum++);
    }
    const num = labelToNum.get(label)!;
    return `<fnref num="${num}">${num}</fnref>`;
  });

  // Validate: references without definitions
  for (const [label, num] of labelToNum) {
    if (!rawDefs.has(label)) {
      warnings.push(`Footnote [^${label}] (ref ${num}) has no definition`);
    }
  }

  // Validate: definitions without references
  for (const label of rawDefs.keys()) {
    if (!labelToNum.has(label)) {
      warnings.push(`Footnote definition [^${label}] is never referenced`);
    }
  }

  // Build numbered defs
  const defs = new Map<number, string>();
  for (const [label, num] of labelToNum) {
    const text = rawDefs.get(label);
    if (text) defs.set(num, text);
  }

  return { text: cleaned, defs, warnings };
}

// ── Markdown → HTML ───────────────────────────────────────────────────

function renderMarkdown(text: string): string {
  const md = new MarkdownIt({
    html: true,
    linkify: false,
    typographer: false,
  });
  md.use(markdownItAttrs);
  return md.render(text);
}

// ── Public API ────────────────────────────────────────────────────────

export interface Md2PdfResult {
  success: boolean;
  pdf?: Buffer;
  errors?: string[];
  warnings?: string[];
  pageCount?: number;
}

/**
 * Convert Markdown text to PDF.
 *
 * @param markdownText - The Markdown source text
 * @param options - Optional settings (srcDir for image resolution, watermark text)
 * @returns Result with PDF buffer or errors
 */
export function md2pdf(markdownText: string, options: Md2PdfOptions = {}): Md2PdfResult {
  // Load fonts based on selected font family
  const useEmbeddedFonts = options.font === "Computer Modern";
  let fonts;
  if (useEmbeddedFonts) {
    const fontsBasePath = options.extensionPath || __dirname;
    try {
      fonts = loadFonts(fontsBasePath);
      initFontMetrics(fonts);
    } catch {
      fonts = undefined;
    }
  } else {
    fonts = undefined;
    clearFontMetrics();
  }

  const config = applyDocMeta(markdownText);
  const mdefs = parseMarkingDefs(markdownText);

  // Validate markings
  const errors = validateMarkings(markdownText, mdefs, config);
  if (errors.length > 0) {
    return { success: false, errors };
  }

  // Pre-process footnotes
  const fnResult = processFootnotes(markdownText);
  if (fnResult.warnings.length > 0) {
    return { success: false, errors: fnResult.warnings };
  }

  // Parse markdown → HTML → blocks
  const html = renderMarkdown(fnResult.text);
  const { blocks, footnotes } = parseHtml(html, mdefs);

  // Merge pre-processed footnote defs with any parsed from HTML
  for (const [num, text] of fnResult.defs) {
    if (!footnotes.has(num)) footnotes.set(num, text);
  }

  // Layout
  const images: ImageInfo[] = [];
  const blockLines = getBlockLines(config);
  const bannerColor = autoBannerColor(config.marking, config.markingColor);
  const pages = layout(
    blocks,
    options.srcDir || null,
    images,
    mdefs,
    blockLines,
    footnotes,
  );

  // Build PDF
  let pdf = buildPdf(
    pages,
    images,
    {
      marking: config.marking,
      bannerColor,
      cbLines: blockLines.cbLines,
      cuiLines: blockLines.cuiLines,
    },
    fonts,
  );

  // Apply watermark if requested
  if (options.watermark) {
    pdf = watermarkPdf(pdf, options.watermark);
  }

  return { success: true, pdf, pageCount: pages.length };
}

// Re-export types
export type { Md2PdfOptions, DocConfig, MarkingDefs } from "./types";
