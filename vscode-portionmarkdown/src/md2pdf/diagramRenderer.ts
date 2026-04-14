/**
 * Render Mermaid and PlantUML diagram code blocks to PNG images — locally.
 *
 * Mermaid:  jsdom + vendored mermaid.min.js IIFE bundle + @resvg/resvg-wasm
 * PlantUML: child_process → system `plantuml` command (requires Java)
 *
 * No cloud services. All npm deps are pure JS/WASM, cross-platform.
 */

import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import type { Block, CodeBlock, ImageInfo, MarkingDef } from "./types";
import { loadImageBuffer } from "./imageLoader";

const MERMAID_LANGS = new Set(["mermaid", "mermaidjs"]);
const PLANTUML_LANGS = new Set(["plantuml", "puml"]);
const GRAPHVIZ_LANGS = new Set(["graphviz", "dot"]);

function isDiagramLang(lang: string | null): boolean {
  if (!lang) return false;
  const l = lang.toLowerCase();
  return MERMAID_LANGS.has(l) || PLANTUML_LANGS.has(l) || GRAPHVIZ_LANGS.has(l);
}

function isMermaid(lang: string): boolean {
  return MERMAID_LANGS.has(lang.toLowerCase());
}

function isGraphviz(lang: string): boolean {
  return GRAPHVIZ_LANGS.has(lang.toLowerCase());
}

// ── Mermaid: jsdom + vendored bundle + resvg-wasm ───────────────────

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

let mermaidReady = false;
let jsdomWindow: any = null;
let resvgReady = false;
let ResvgCtor: any = null;

function setupSvgMocks(win: any): void {
  // jsdom lacks SVG geometry methods — provide rough approximations
  // so mermaid can compute layout. resvg re-measures text when
  // rasterising, so minor inaccuracies here are acceptable.

  const svgProto = win.SVGElement?.prototype;
  if (svgProto && !svgProto.getBBox) {
    svgProto.getBBox = function (this: any) {
      const text: string = this.textContent || "";
      const fontSize = parseFloat(this.getAttribute("font-size") || "14");
      const width = text.length * fontSize * 0.6;
      const height = fontSize * 1.45;
      return { x: 0, y: -height * 0.8, width, height };
    };
  }
  if (svgProto && !svgProto.getComputedTextLength) {
    svgProto.getComputedTextLength = function (this: any) {
      const text: string = this.textContent || "";
      const fontSize = parseFloat(this.getAttribute("font-size") || "14");
      return text.length * fontSize * 0.6;
    };
  }
  if (svgProto && !svgProto.getBoundingClientRect) {
    svgProto.getBoundingClientRect = function (this: any) {
      const bb = this.getBBox?.() ?? { x: 0, y: 0, width: 100, height: 40 };
      return {
        ...bb,
        top: bb.y,
        left: bb.x,
        bottom: bb.y + bb.height,
        right: bb.x + bb.width,
      };
    };
  }

  const svgSvgProto = win.SVGSVGElement?.prototype;
  if (svgSvgProto && !svgSvgProto.createSVGPoint) {
    svgSvgProto.createSVGPoint = () => ({
      x: 0,
      y: 0,
      matrixTransform: () => ({ x: 0, y: 0 }),
    });
  }
  if (svgSvgProto && !svgSvgProto.createSVGMatrix) {
    svgSvgProto.createSVGMatrix = () => ({
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 0,
      f: 0,
      multiply: (m: any) => m,
      inverse: function () {
        return this;
      },
      translate: function () {
        return this;
      },
    });
  }
}

async function ensureMermaid(extensionPath: string): Promise<void> {
  if (mermaidReady) return;

  const { JSDOM } = require("jsdom") as typeof import("jsdom");
  const dom = new JSDOM(
    '<!DOCTYPE html><html><head></head><body><div id="container"></div></body></html>',
    { pretendToBeVisual: true, url: "http://localhost" },
  );
  jsdomWindow = dom.window;

  // Expose DOM globals that mermaid / D3 expect.
  // Use Object.defineProperty for properties like navigator that
  // are read-only getters in Node.js 21+.
  const g = global as any;
  const props: Record<string, unknown> = {
    document: jsdomWindow.document,
    window: jsdomWindow,
    navigator: jsdomWindow.navigator,
    DOMParser: jsdomWindow.DOMParser,
    XMLSerializer: jsdomWindow.XMLSerializer,
    self: jsdomWindow,
  };
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(g, k, { value: v, writable: true, configurable: true });
  }

  setupSvgMocks(jsdomWindow);

  // Eval the vendored mermaid IIFE bundle inside jsdom.
  // The bundle starts with "use strict" which scopes var declarations
  // to the eval — strip it so the globals leak to jsdomWindow.
  const bundlePath = path.join(extensionPath, "lib", "mermaid.min.js");
  let src = fs.readFileSync(bundlePath, "utf-8");
  src = src.replace(/^"use strict";/, "");
  jsdomWindow.eval(src);

  // The bundle ends with: globalThis["mermaid"] = ...default
  // jsdom's eval delegates to Node's eval, so it lands on globalThis.
  const mermaid = (globalThis as any).mermaid;

  if (!mermaid?.initialize) {
    throw new Error("Failed to load mermaid from vendored bundle");
  }

  mermaid.initialize({
    startOnLoad: false,
    theme: "default",
    securityLevel: "loose",
    logLevel: 5, // silent
  });

  // Stash on the window so renderMermaidSvg can find it
  jsdomWindow.__mermaid = mermaid;
  mermaidReady = true;
}

async function renderMermaidSvg(code: string): Promise<string> {
  const mermaid = jsdomWindow.__mermaid;
  jsdomWindow.document.body.innerHTML = '<div id="container"></div>';
  const id = "diagram-" + Math.random().toString(36).slice(2, 10);
  const { svg } = await mermaid.render(id, code);
  return fixSvgViewBox(svg);
}

/**
 * Mermaid's viewBox is wrong under jsdom because getBBox on container
 * elements returns text-content-based sizes instead of layout sizes.
 * Scan the SVG for actual node positions / sizes and rewrite the viewBox.
 */
function fixSvgViewBox(svg: string): string {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  // Collect translate positions
  for (const m of svg.matchAll(
    /transform="translate\(\s*([\d.e+-]+)[\s,]+([\d.e+-]+)\s*\)"/g,
  )) {
    const x = parseFloat(m[1]);
    const y = parseFloat(m[2]);
    if (isFinite(x) && isFinite(y)) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  // Collect rect dimensions (nodes have explicit width/height)
  for (const m of svg.matchAll(
    /<rect[^>]*?(?:x="([\d.e+-]+)")?[^>]*?(?:y="([\d.e+-]+)")?[^>]*?width="([\d.e+-]+)"[^>]*?height="([\d.e+-]+)"/g,
  )) {
    const rx = parseFloat(m[1] || "0");
    const ry = parseFloat(m[2] || "0");
    const rw = parseFloat(m[3]);
    const rh = parseFloat(m[4]);
    if (isFinite(rw) && isFinite(rh)) {
      maxX = Math.max(maxX, rx + rw);
      maxY = Math.max(maxY, ry + rh);
      minX = Math.min(minX, rx);
      minY = Math.min(minY, ry);
    }
  }

  if (!isFinite(minX)) return svg; // nothing found, leave as-is

  const pad = 20;
  const vbX = minX - pad;
  const vbY = minY - pad;
  const vbW = maxX - minX + 2 * pad;
  const vbH = maxY - minY + 2 * pad;

  // Replace viewBox and strip max-width (which is also wrong)
  let fixed = svg.replace(/viewBox="[^"]*"/, `viewBox="${vbX} ${vbY} ${vbW} ${vbH}"`);
  fixed = fixed.replace(/style="[^"]*max-width:[^"]*"/, `style="max-width: ${vbW}px;"`);
  return fixed;
}

async function ensureResvg(extensionPath: string): Promise<void> {
  if (resvgReady) return;
  const resvgWasm = require("@resvg/resvg-wasm");
  ResvgCtor = resvgWasm.Resvg;
  const wasmPath = path.join(
    extensionPath,
    "node_modules",
    "@resvg",
    "resvg-wasm",
    "index_bg.wasm",
  );
  const wasmBuf = fs.readFileSync(wasmPath);
  await resvgWasm.initWasm(wasmBuf);
  resvgReady = true;
}

async function svgToPng(svgString: string): Promise<Buffer> {
  const resvg = new ResvgCtor(svgString, {
    fitTo: { mode: "width" as const, value: 800 },
    background: "#ffffff",
  });
  const rendered = resvg.render();
  return Buffer.from(rendered.asPng());
}

async function renderMermaidLocal(code: string, extensionPath: string): Promise<Buffer> {
  await ensureMermaid(extensionPath);
  await ensureResvg(extensionPath);
  const svg = await renderMermaidSvg(code);
  return svgToPng(svg);
}

/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

// ── PlantUML: subprocess ────────────────────────────────────────────

function findPlantUML(configuredPath: string | undefined): string | null {
  // 1. Explicit user setting
  if (configuredPath) return configuredPath;
  // 2. PLANTUML_JAR env var
  if (process.env.PLANTUML_JAR) return process.env.PLANTUML_JAR;
  // 3. plantuml on PATH
  try {
    child_process.execFileSync("plantuml", ["-version"], { stdio: "ignore" });
    return "plantuml";
  } catch {
    /* not on path */
  }
  return null;
}

function renderPlantUMLLocal(
  code: string,
  plantumlBin: string,
  javaPath?: string,
): Promise<Buffer> {
  // Ensure @startuml / @enduml wrapper
  let input = code.trim();
  if (!input.startsWith("@start")) {
    input = `@startuml\n${input}\n@enduml`;
  }

  return new Promise((resolve, reject) => {
    let cmd: string;
    let args: string[];
    if (plantumlBin.endsWith(".jar")) {
      cmd = javaPath || "java";
      args = ["-jar", plantumlBin, "-tpng", "-pipe"];
    } else {
      cmd = plantumlBin;
      args = ["-tpng", "-pipe"];
    }

    const proc = child_process.spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => errChunks.push(c));

    proc.on("error", (err) =>
      reject(new Error(`Failed to run PlantUML (${cmd}): ${err.message}`)),
    );
    proc.on("close", (exitCode) => {
      if (exitCode !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf-8").slice(0, 500);
        reject(new Error(`PlantUML exited ${exitCode}: ${stderr}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

// ── Graphviz/dot: subprocess ─────────────────────────────────────────

function findGraphviz(configuredPath: string | undefined): string | null {
  if (configuredPath) return configuredPath;
  // Try "dot" on PATH
  try {
    child_process.execFileSync("dot", ["-V"], { stdio: "ignore" });
    return "dot";
  } catch {
    /* not on path */
  }
  return null;
}

function renderGraphvizLocal(code: string, dotBin: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn(dotBin, ["-Tpng"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => errChunks.push(c));

    proc.on("error", (err) =>
      reject(new Error(`Failed to run Graphviz (${dotBin}): ${err.message}`)),
    );
    proc.on("close", (exitCode) => {
      if (exitCode !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf-8").slice(0, 500);
        reject(new Error(`Graphviz exited ${exitCode}: ${stderr}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    proc.stdin.write(code);
    proc.stdin.end();
  });
}

// ── Public API ──────────────────────────────────────────────────────

export interface DiagramResult {
  blocks: Block[];
  preloadedImages: Map<string, ImageInfo>;
  warnings: string[];
}

export async function renderDiagrams(
  blocks: Block[],
  extensionPath: string,
  plantumlPath: string | undefined,
  javaPath: string | undefined,
  graphvizPath: string | undefined,
): Promise<DiagramResult> {
  const warnings: string[] = [];
  const preloadedImages = new Map<string, ImageInfo>();

  // Quick exit when there are no diagrams
  const hasDiagrams = blocks.some((b) => b.type === "code" && isDiagramLang(b.lang));
  if (!hasDiagrams) {
    return { blocks, preloadedImages, warnings };
  }

  // Collect diagram jobs
  interface Job {
    blockIndex: number;
    lang: string;
    block: CodeBlock;
  }
  const jobs: Job[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "code" && isDiagramLang(b.lang)) {
      jobs.push({ blockIndex: i, lang: b.lang!.toLowerCase(), block: b });
    }
  }

  // Resolve external binaries only if needed
  const hasPlantUML = jobs.some((j) => !isMermaid(j.lang) && !isGraphviz(j.lang));
  const hasGraphviz = jobs.some((j) => isGraphviz(j.lang));
  const pumlBin = hasPlantUML ? findPlantUML(plantumlPath) : null;
  const dotBin = hasGraphviz ? findGraphviz(graphvizPath) : null;

  // Render each diagram
  const results = await Promise.allSettled(
    jobs.map(async (job): Promise<Buffer> => {
      if (isMermaid(job.lang)) {
        return renderMermaidLocal(job.block.text, extensionPath);
      }
      if (isGraphviz(job.lang)) {
        if (!dotBin) {
          throw new Error(
            "Graphviz not found. Install Graphviz or set portionmarkdown.graphvizPath.",
          );
        }
        return renderGraphvizLocal(job.block.text, dotBin);
      }
      // PlantUML
      if (!pumlBin) {
        throw new Error(
          "PlantUML not found. Install PlantUML or set portionmarkdown.plantumlPath.",
        );
      }
      return renderPlantUMLLocal(job.block.text, pumlBin, javaPath);
    }),
  );

  // Build replacement map
  let diagramIdx = 0;
  const replacements = new Map<
    number,
    { src: string; marking: MarkingDef | null; sb: number; sa: number }
  >();

  for (let j = 0; j < jobs.length; j++) {
    const job = jobs[j];
    const result = results[j];

    if (result.status === "rejected") {
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      warnings.push(`Failed to render ${job.lang} diagram: ${reason}`);
      continue;
    }

    const imgInfo = loadImageBuffer(result.value);
    if (!imgInfo) {
      warnings.push(`Failed to parse rendered ${job.lang} image`);
      continue;
    }

    const src = `__diagram_${diagramIdx++}__`;
    preloadedImages.set(src, imgInfo);
    replacements.set(job.blockIndex, {
      src,
      marking: job.block.marking,
      sb: job.block.sb,
      sa: job.block.sa,
    });
  }

  // Swap diagram CodeBlocks for ImageBlocks
  const newBlocks: Block[] = blocks.map((b, i) => {
    const rep = replacements.get(i);
    if (rep) {
      return {
        type: "image" as const,
        src: rep.src,
        alt: "",
        sizing: "fit" as const,
        widthPct: null,
        marking: rep.marking,
        sb: rep.sb,
        sa: rep.sa,
      };
    }
    return b;
  });

  return { blocks: newBlocks, preloadedImages, warnings };
}

/**
 * Render a single diagram to PNG. Exported for the "Save Diagram as PNG" command.
 */
export async function renderSingleDiagram(
  lang: string,
  code: string,
  extensionPath: string,
  plantumlPath: string | undefined,
  javaPath: string | undefined,
  graphvizPath: string | undefined,
): Promise<Buffer> {
  if (isMermaid(lang)) {
    return renderMermaidLocal(code, extensionPath);
  }
  if (isGraphviz(lang)) {
    const dotBin = findGraphviz(graphvizPath);
    if (!dotBin) {
      throw new Error(
        "Graphviz not found. Install Graphviz or set portionmarkdown.graphvizPath.",
      );
    }
    return renderGraphvizLocal(code, dotBin);
  }
  const pumlBin = findPlantUML(plantumlPath);
  if (!pumlBin) {
    throw new Error(
      "PlantUML not found. Install PlantUML or set portionmarkdown.plantumlPath.",
    );
  }
  return renderPlantUMLLocal(code, pumlBin, javaPath);
}
