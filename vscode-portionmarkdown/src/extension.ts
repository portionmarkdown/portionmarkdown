import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { parseMarkingDefs, MarkingDef } from "./markings";
import { updateDiagnostics } from "./diagnostics";
import { MarkingDivHighlightProvider } from "./highlighter";
import { md2pdf } from "./md2pdf";

let previewPanel: vscode.WebviewPanel | undefined;
let previewReady = false;
let pendingBase64: string | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let _ctx: vscode.ExtensionContext;

// ── MRU helpers ─────────────────────────────────────────────────────────

const MRU_MAX = 5;
const MRU_MARKINGS_KEY = "mru.markings";
const MRU_CLASS_KEY = "mru.classificationBlocks";
const MRU_CUI_KEY = "mru.cuiBlocks";

interface MruBlock {
  name: string;
  body: string;
}

function getMruList<T>(key: string): T[] {
  return _ctx.globalState.get<T[]>(key) ?? [];
}

function pushMru<T>(key: string, entry: T, identify: (a: T, b: T) => boolean) {
  const list = getMruList<T>(key).filter((e) => !identify(e, entry));
  list.unshift(entry);
  if (list.length > MRU_MAX) list.length = MRU_MAX;
  _ctx.globalState.update(key, list);
}

function pushMruMarking(markingKey: string) {
  pushMru<string>(MRU_MARKINGS_KEY, markingKey, (a, b) => a === b);
}

function pushMruBlock(stateKey: string, name: string, body: string) {
  pushMru<MruBlock>(stateKey, { name, body }, (a, b) => a.body === b.body);
}

// ── Config helpers ──────────────────────────────────────────────────────

function cfg<T>(key: string): T {
  return vscode.workspace.getConfiguration("portionmarkdown").get<T>(key) as T;
}

interface ClassBlockCfg {
  name: string;
  marking?: string;
  classifiedBy?: string;
  derivedFrom?: string;
  declassifyOn?: string;
}

interface CuiBlockCfg {
  name: string;
  controlledBy?: string;
  categories?: string;
  distribution?: string;
  poc?: string;
}

function buildClassBlock(c: ClassBlockCfg): string {
  const lines = ["<!-- classification"];
  lines.push(`marking: ${c.marking || "UNCLASSIFIED"}`);
  if (c.classifiedBy) lines.push(`Classified By: ${c.classifiedBy}`);
  if (c.derivedFrom) lines.push(`Derived From: ${c.derivedFrom}`);
  if (c.declassifyOn) lines.push(`Declassify On: ${c.declassifyOn}`);
  lines.push("-->");
  return lines.join("\n");
}

function buildCuiBlock(c: CuiBlockCfg): string {
  const lines = ["<!-- cui"];
  if (c.controlledBy) lines.push(`Controlled By: ${c.controlledBy}`);
  if (c.categories) lines.push(`Categories: ${c.categories}`);
  if (c.distribution) lines.push(`Distribution: ${c.distribution}`);
  if (c.poc) lines.push(`POC: ${c.poc}`);
  lines.push("-->");
  return lines.join("\n");
}

// ── Blank templates ─────────────────────────────────────────────────────

const BLANK_CLASS = [
  "<!-- classification",
  "marking: UNCLASSIFIED",
  "Classified By: ",
  "Derived From: ",
  "Declassify On: ",
  "-->",
].join("\n");

const BLANK_CUI = [
  "<!-- cui",
  "Controlled By: ",
  "Categories: ",
  "Distribution: ",
  "POC: ",
  "-->",
].join("\n");

const BLANK_MARKINGS = [
  "<!-- markings",
  "TS: TS | TOP SECRET",
  "S: S | SECRET",
  "C: C | CONFIDENTIAL",
  "U: U | UNCLASSIFIED",
  "-->",
].join("\n");

// ── Quick-pick item with payload ────────────────────────────────────────

interface BlockPickItem extends vscode.QuickPickItem {
  body: string;
  mruName?: string;
}

// ── Activation ──────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  _ctx = context;

  // ── Diagnostics ────────────────────────────────────────────────────
  const diagCollection = vscode.languages.createDiagnosticCollection("portionmarkdown");
  context.subscriptions.push(diagCollection);

  if (vscode.window.activeTextEditor) {
    updateDiagnostics(vscode.window.activeTextEditor.document, diagCollection);
  }
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) updateDiagnostics(editor.document, diagCollection);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      updateDiagnostics(e.document, diagCollection);
      // Trigger PDF preview refresh on change
      if (previewPanel && e.document.languageId === "markdown") {
        schedulePreviewRefresh(e.document, context);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagCollection.delete(doc.uri);
    }),
  );

  // ── Div highlight provider ────────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerDocumentHighlightProvider(
      { language: "markdown" },
      new MarkingDivHighlightProvider(),
    ),
  );

  // ── Wrap selection command ────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("portionmarkdown.wrapMarking", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const text = editor.document.getText();
      const docDefs = parseMarkingDefs(text);
      const settingsDefs: MarkingDef[] = cfg<MarkingDef[]>("commonMarkings") ?? [];

      // Merge: doc defs are authoritative, settings fill gaps
      const seen = new Set(docDefs.map((d) => d.key));
      const extraDefs = settingsDefs.filter((d) => !seen.has(d.key));
      const allDefs = [...docDefs, ...extraDefs];

      // Build quick-pick: Empty + up to 5 markings (MRU first, then doc defs)
      const SLOT_MAX = 5;
      const mruKeys = getMruList<string>(MRU_MARKINGS_KEY);
      const items: (vscode.QuickPickItem & { key: string })[] = [];

      // Always offer an empty (unmarked) wrapper first
      items.push({
        label: "$(circle-slash) Empty",
        description: "No portion marking",
        key: "__empty__",
      });

      // Collect up to 5 unique marking keys: MRU first, then fill from allDefs
      const picked = new Set<string>();
      const slots: MarkingDef[] = [];

      for (const k of mruKeys) {
        if (slots.length >= SLOT_MAX) break;
        const def = allDefs.find((d) => d.key === k);
        if (def && !picked.has(def.key)) {
          picked.add(def.key);
          slots.push(def);
        }
      }
      for (const def of allDefs) {
        if (slots.length >= SLOT_MAX) break;
        if (!picked.has(def.key)) {
          picked.add(def.key);
          slots.push(def);
        }
      }

      for (const d of slots) {
        items.push({
          label: `(${d.short})`,
          description: d.long,
          key: d.key,
        });
      }

      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Select classification level",
      });
      if (!pick) return;

      const selection = editor.selection;
      const selected = editor.document.getText(selection);

      if (pick.key === "__empty__") {
        await editor.edit((editBuilder) => {
          editBuilder.replace(
            selection,
            `<div marking="" markdown="1">\n\n${selected}\n\n</div>`,
          );
        });
      } else {
        pushMruMarking(pick.key);
        await editor.edit((editBuilder) => {
          editBuilder.replace(
            selection,
            `<div marking="${pick.key}" markdown="1">\n\n${selected}\n\n</div>`,
          );
        });
      }
    }),
  );

  // ── Insert template block commands ───────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("portionmarkdown.insertClassification", () =>
      insertBlockWithPicker("classification"),
    ),
    vscode.commands.registerCommand("portionmarkdown.insertCui", () =>
      insertBlockWithPicker("cui"),
    ),
    vscode.commands.registerCommand("portionmarkdown.insertMarkings", () =>
      insertMarkingsBlock(),
    ),
  );

  // ── Preview PDF command ───────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("portionmarkdown.previewPdf", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "markdown") {
        vscode.window.showWarningMessage("Open a Markdown file first.");
        return;
      }

      if (previewPanel) {
        previewPanel.reveal(vscode.ViewColumn.Beside);
      } else {
        previewPanel = vscode.window.createWebviewPanel(
          "portionmarkdown.preview",
          "PDF Preview",
          vscode.ViewColumn.Beside,
          {
            enableScripts: true,
            localResourceRoots: [
              vscode.Uri.file(
                path.join(context.extensionPath, "node_modules", "pdfjs-dist"),
              ),
            ],
          },
        );
        previewReady = false;
        pendingBase64 = undefined;
        previewPanel.webview.onDidReceiveMessage((msg) => {
          if (msg.type === "ready") {
            previewReady = true;
            if (pendingBase64) {
              previewPanel?.webview.postMessage({
                type: "pdf",
                base64: pendingBase64,
              });
              pendingBase64 = undefined;
            }
          }
        });
        previewPanel.onDidDispose(() => {
          previewPanel = undefined;
          previewReady = false;
          pendingBase64 = undefined;
        });

        const pdfjsUri = previewPanel.webview.asWebviewUri(
          vscode.Uri.file(
            path.join(
              context.extensionPath,
              "node_modules",
              "pdfjs-dist",
              "build",
              "pdf.min.mjs",
            ),
          ),
        );
        const workerUri = previewPanel.webview.asWebviewUri(
          vscode.Uri.file(
            path.join(
              context.extensionPath,
              "node_modules",
              "pdfjs-dist",
              "build",
              "pdf.worker.min.mjs",
            ),
          ),
        );
        previewPanel.webview.html = getPreviewHtml(
          pdfjsUri.toString(),
          workerUri.toString(),
        );
      }

      await refreshPreview(editor.document, context);
    }),
  );

  // ── Export to PDF command ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "portionmarkdown.exportPdf",
      async (uri?: vscode.Uri) => {
        const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
        if (!fileUri) {
          vscode.window.showErrorMessage("No Markdown file to export.");
          return;
        }

        const inputPath = fileUri.fsPath;
        const defaultPath = inputPath.replace(/\.md$/i, ".pdf");

        const saveUri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(defaultPath),
          filters: { PDF: ["pdf"] },
          title: "Export PDF",
        });
        if (!saveUri) return;

        const outputPath = saveUri.fsPath;
        const markdownText = fs.readFileSync(inputPath, "utf-8");
        const srcDir = path.dirname(inputPath);
        const result = md2pdf(markdownText, {
          srcDir,
          extensionPath: context.extensionPath,
          font: cfg<string>("font") || "Default",
        });

        if (result.success && result.pdf) {
          fs.writeFileSync(outputPath, result.pdf);
          const choice = await vscode.window.showInformationMessage(
            `PDF exported: ${outputPath}`,
            "Open PDF",
          );
          if (choice === "Open PDF") {
            vscode.env.openExternal(vscode.Uri.file(outputPath));
          }
        } else {
          vscode.window.showErrorMessage(
            `PDF export failed: ${(result.errors || []).join("\n")}`,
          );
        }
      },
    ),
  );

  // ── Export Watermarked PDF command ─────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "portionmarkdown.exportWatermarkedPdf",
      async (uri?: vscode.Uri) => {
        const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
        if (!fileUri) {
          vscode.window.showErrorMessage("No Markdown file to export.");
          return;
        }

        const inputPath = fileUri.fsPath;
        const base = inputPath.replace(/\.md$/i, "");
        const defaultPath = `${base}_EXAMPLE.pdf`;

        const saveUri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(defaultPath),
          filters: { PDF: ["pdf"] },
          title: "Export Watermarked PDF",
        });
        if (!saveUri) return;

        const outputPath = saveUri.fsPath;
        const markdownText = fs.readFileSync(inputPath, "utf-8");
        const srcDir = path.dirname(inputPath);
        const result = md2pdf(markdownText, {
          srcDir,
          watermark: "EXAMPLE  EXAMPLE  EXAMPLE",
          extensionPath: context.extensionPath,
          font: cfg<string>("font") || "Default",
        });

        if (result.success && result.pdf) {
          fs.writeFileSync(outputPath, result.pdf);
          const choice = await vscode.window.showInformationMessage(
            `Watermarked PDF exported: ${outputPath}`,
            "Open PDF",
          );
          if (choice === "Open PDF") {
            vscode.env.openExternal(vscode.Uri.file(outputPath));
          }
        } else {
          vscode.window.showErrorMessage(
            `PDF export failed: ${(result.errors || []).join("\n")}`,
          );
        }
      },
    ),
  );
}

// ── Insert template blocks ──────────────────────────────────────────────

async function insertBlockWithPicker(kind: "classification" | "cui") {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const isClass = kind === "classification";
  const mruKey = isClass ? MRU_CLASS_KEY : MRU_CUI_KEY;
  const mruBlocks = getMruList<MruBlock>(mruKey);

  // Build quick-pick items
  const items: BlockPickItem[] = [];

  // Blank always first
  items.push({
    label: "$(new-file) Blank",
    description: isClass ? "Empty classification block" : "Empty CUI block",
    body: isClass ? BLANK_CLASS : BLANK_CUI,
  });

  // MRU
  if (mruBlocks.length > 0) {
    items.push({
      label: "Recently Used",
      kind: vscode.QuickPickItemKind.Separator,
      body: "",
    });
    for (const b of mruBlocks) {
      items.push({
        label: `$(history) ${b.name}`,
        description: firstContentLine(b.body),
        body: b.body,
        mruName: b.name,
      });
    }
  }

  // Settings-defined templates
  if (isClass) {
    const templates = cfg<ClassBlockCfg[]>("commonClassificationBlocks") ?? [];
    if (templates.length > 0) {
      items.push({
        label: "Common Templates",
        kind: vscode.QuickPickItemKind.Separator,
        body: "",
      });
      for (const t of templates) {
        const body = buildClassBlock(t);
        items.push({
          label: `$(gear) ${t.name}`,
          description: `${t.marking || "UNCLASSIFIED"}${t.derivedFrom ? " — " + t.derivedFrom : ""}`,
          body,
          mruName: t.name,
        });
      }
    }
  } else {
    const templates = cfg<CuiBlockCfg[]>("commonCuiBlocks") ?? [];
    if (templates.length > 0) {
      items.push({
        label: "Common Templates",
        kind: vscode.QuickPickItemKind.Separator,
        body: "",
      });
      for (const t of templates) {
        const body = buildCuiBlock(t);
        items.push({
          label: `$(gear) ${t.name}`,
          description: [t.controlledBy, t.categories].filter(Boolean).join(" — "),
          body,
          mruName: t.name,
        });
      }
    }
  }

  // If only blank (no MRU, no settings), skip the picker and insert blank
  const realItems = items.filter((i) => i.kind !== vscode.QuickPickItemKind.Separator);
  let body: string;
  let mruName: string | undefined;

  if (realItems.length === 1) {
    body = BLANK_CLASS;
    if (!isClass) body = BLANK_CUI;
  } else {
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: isClass
        ? "Select classification block template"
        : "Select CUI block template",
    });
    if (!pick || !pick.body) return;
    body = pick.body;
    mruName = pick.mruName;
  }

  // Track in MRU (skip blank)
  if (mruName) {
    pushMruBlock(mruKey, mruName, body);
  }

  const position = editor.selection.active;
  await editor.edit((eb) => {
    eb.insert(position, body + "\n\n");
  });
}

async function insertMarkingsBlock() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const position = editor.selection.active;
  await editor.edit((eb) => {
    eb.insert(position, BLANK_MARKINGS + "\n\n");
  });
}

/** Return the first non-comment, non-empty line for a description preview. */
function firstContentLine(body: string): string {
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("<!--") && t !== "-->") return t;
  }
  return "";
}

// ── PDF generation and preview ──────────────────────────────────────────

function schedulePreviewRefresh(
  doc: vscode.TextDocument,
  context: vscode.ExtensionContext,
) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => refreshPreview(doc, context), 800);
}

async function refreshPreview(
  doc: vscode.TextDocument,
  context: vscode.ExtensionContext,
) {
  if (!previewPanel) return;

  const srcDir = path.dirname(doc.uri.fsPath);
  const result = md2pdf(doc.getText(), {
    srcDir,
    extensionPath: context.extensionPath,
    font: cfg<string>("font") || "Default",
  });

  if (!result.success) {
    if (previewPanel) {
      previewPanel.webview.postMessage({
        type: "error",
        text: (result.errors || []).join("\n"),
      });
    }
    return;
  }

  const base64 = result.pdf!.toString("base64");

  if (previewPanel) {
    if (previewReady) {
      previewPanel.webview.postMessage({ type: "pdf", base64 });
    } else {
      pendingBase64 = base64;
    }
  }
}

// ── Webview HTML ────────────────────────────────────────────────────────

function getPreviewHtml(pdfjsUrl: string, workerUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      margin: 0;
      padding: 0;
      background: #2b303b;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      padding: 12px 0;
    }
    canvas {
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }
    .error {
      color: #e06c75;
      margin: 24px;
      font-size: 13px;
      white-space: pre-wrap;
      font-family: monospace;
    }
  </style>
</head>
<body>
  <script type="module">
    const vscode = acquireVsCodeApi();
    let pdfjsLib;
    try {
      pdfjsLib = await import('${pdfjsUrl}');
      pdfjsLib.GlobalWorkerOptions.workerSrc = '${workerUrl}';
    } catch (err) {
      document.body.innerHTML = '<pre class="error">Failed to load PDF.js: '
        + (err && err.message || err) + '</pre>';
    }

    async function renderPdf(base64) {
      document.body.innerHTML = '';
      try {
        const data = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const scale = 1.5;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          document.body.appendChild(canvas);
          await page.render({
            canvasContext: canvas.getContext('2d'),
            viewport,
          }).promise;
        }
      } catch (err) {
        document.body.innerHTML = '<pre class="error">PDF render failed: '
          + (err && err.message || err) + '</pre>';
      }
    }

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'pdf') {
        renderPdf(msg.base64);
      } else if (msg.type === 'error') {
        document.body.innerHTML = '<pre class="error">'
          + msg.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          + '</pre>';
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

export function deactivate() {
  if (debounceTimer) clearTimeout(debounceTimer);
}
