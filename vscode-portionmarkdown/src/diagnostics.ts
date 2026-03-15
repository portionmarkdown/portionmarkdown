/**
 * Validate marking div structure and document metadata consistency.
 * Mirrors _validate_markings() from md2pdf.py.
 */
import * as vscode from "vscode";
import {
  parseMarkingDefs,
  parseDocMeta,
  parseBase,
  isClassified,
  isCui,
} from "./markings";

const DIV_OPEN_RE = /<div\s[^>]*marking\s*=\s*["']([^"']+)["']/i;
const DIV_CLOSE_RE = /<\/div\s*>/i;

interface OpenDiv {
  key: string;
  line: number;
}

export function updateDiagnostics(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
): void {
  if (doc.languageId !== "markdown") {
    collection.delete(doc.uri);
    return;
  }

  const text = doc.getText();
  const diags: vscode.Diagnostic[] = [];

  // ── Structural checks: nesting, undefined keys, unclosed divs ─────
  const defs = parseMarkingDefs(text);
  const defKeys = new Set(defs.map((d) => d.key));
  const refs: Map<string, number[]> = new Map();
  const openStack: OpenDiv[] = [];

  for (let i = 0; i < doc.lineCount; i++) {
    const lineText = doc.lineAt(i).text;

    const openMatch = DIV_OPEN_RE.exec(lineText);
    if (openMatch) {
      const key = openMatch[1].trim();
      if (!refs.has(key)) refs.set(key, []);
      refs.get(key)!.push(i);

      if (openStack.length > 0) {
        const outer = openStack[openStack.length - 1];
        diags.push(
          new vscode.Diagnostic(
            new vscode.Range(i, 0, i, lineText.length),
            `Nested marking div '${key}' inside '${outer.key}' (line ${outer.line + 1}) — marking divs cannot be nested`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
      openStack.push({ key, line: i });
    }

    if (DIV_CLOSE_RE.test(lineText) && openStack.length > 0) {
      openStack.pop();
    }
  }

  // Unclosed marking divs
  for (const open of openStack) {
    const lineText = doc.lineAt(open.line).text;
    diags.push(
      new vscode.Diagnostic(
        new vscode.Range(open.line, 0, open.line, lineText.length),
        `Marking div '${open.key}' is never closed`,
        vscode.DiagnosticSeverity.Error,
      ),
    );
  }

  // Undefined marking keys
  for (const [key, lines] of refs) {
    if (!defKeys.has(key)) {
      for (const line of lines) {
        const lineText = doc.lineAt(line).text;
        const defined = defs.length > 0 ? defs.map((d) => d.key).join(", ") : "(none)";
        diags.push(
          new vscode.Diagnostic(
            new vscode.Range(line, 0, line, lineText.length),
            `Marking key '${key}' not defined in <!-- markings --> (defined: ${defined})`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
    }
  }

  // ── Conflict checks (skipped in example mode) ─────────────────────
  const meta = parseDocMeta(text);
  if (!meta.exampleMode) {
    const bannerBase = parseBase(meta.marking);
    const banUnclass = bannerBase === "UNCLASSIFIED";
    const banCui = isCui(bannerBase);
    const banClassified = isClassified(bannerBase);

    const hasCuiPortions = defs.some((d) => isCui(parseBase(d.long)));
    const hasClassifiedPortions = defs.some((d) => isClassified(parseBase(d.long)));

    // Find line ranges for anchoring diagnostics on metadata comments
    const clsCommentLine = findCommentLine(doc, "classification");
    const cuiCommentLine = findCommentLine(doc, "cui");
    const markingsCommentLine = findCommentLine(doc, "markings");

    // UNCLASSIFIED conflicts
    if (banUnclass && defs.length > 0) {
      const line = markingsCommentLine ?? 0;
      diags.push(
        new vscode.Diagnostic(
          lineRange(doc, line),
          `Document is UNCLASSIFIED but defines portion markings (${defs.map((d) => d.key).join(", ")}) — remove the markings or set a higher classification`,
          vscode.DiagnosticSeverity.Error,
        ),
      );
    }
    if (banUnclass && meta.classificationBlock.length > 0) {
      const line = clsCommentLine ?? 0;
      diags.push(
        new vscode.Diagnostic(
          lineRange(doc, line),
          "Document is UNCLASSIFIED but contains a classification authority block — remove the block or set a higher classification",
          vscode.DiagnosticSeverity.Error,
        ),
      );
    }
    if (banUnclass && meta.cuiBlock.length > 0) {
      const line = cuiCommentLine ?? 0;
      diags.push(
        new vscode.Diagnostic(
          lineRange(doc, line),
          "Document is UNCLASSIFIED but contains a CUI block — remove the block or set an appropriate marking (e.g. CUI)",
          vscode.DiagnosticSeverity.Error,
        ),
      );
    }

    // Missing CUI block
    if ((banCui || hasCuiPortions) && meta.cuiBlock.length === 0) {
      const line = clsCommentLine ?? markingsCommentLine ?? 0;
      diags.push(
        new vscode.Diagnostic(
          lineRange(doc, line),
          "Document contains CUI content but has no <!-- cui --> block — add CUI designation information",
          vscode.DiagnosticSeverity.Warning,
        ),
      );
    }

    // Classified document completeness: all three required together
    if (meta.classificationBlock.length > 0 || banClassified || hasClassifiedPortions) {
      if (meta.classificationBlock.length === 0) {
        const line = clsCommentLine ?? 0;
        diags.push(
          new vscode.Diagnostic(
            lineRange(doc, line),
            "Document has classified content but no classification authority block — add authority info in <!-- classification -->",
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      }
      if (!banClassified) {
        const line = clsCommentLine ?? 0;
        diags.push(
          new vscode.Diagnostic(
            lineRange(doc, line),
            `Document has a classification authority block but the banner is ${bannerBase}, not a classified level`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
      if (!hasClassifiedPortions) {
        const line = markingsCommentLine ?? clsCommentLine ?? 0;
        diags.push(
          new vscode.Diagnostic(
            lineRange(doc, line),
            "Document has classified content but no classified portion markings — classified documents require portion marking per ISOO",
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      }
    }
  }

  collection.set(doc.uri, diags);
}

/** Find the line number of a `<!-- keyword ... -->` comment. */
function findCommentLine(doc: vscode.TextDocument, keyword: string): number | null {
  const re = new RegExp(`<!--\\s*${keyword}\\b`, "i");
  for (let i = 0; i < doc.lineCount; i++) {
    if (re.test(doc.lineAt(i).text)) return i;
  }
  return null;
}

/** Return a Range spanning the full text of the given line. */
function lineRange(doc: vscode.TextDocument, line: number): vscode.Range {
  const text = doc.lineAt(line).text;
  return new vscode.Range(line, 0, line, text.length);
}
