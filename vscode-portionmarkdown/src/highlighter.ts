/**
 * DocumentHighlightProvider — when cursor is on an opening <div marking="...">
 * highlight the corresponding </div>, and vice versa.
 */
import * as vscode from "vscode";

const DIV_OPEN_RE = /<div\s[^>]*marking\s*=\s*["']([^"']+)["']/i;
const DIV_CLOSE_RE = /<\/div\s*>/i;

interface DivPair {
  openLine: number;
  closeLine: number;
}

function findDivPairs(doc: vscode.TextDocument): DivPair[] {
  const pairs: DivPair[] = [];
  const stack: number[] = [];

  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    if (DIV_OPEN_RE.test(text)) {
      stack.push(i);
    }
    if (DIV_CLOSE_RE.test(text) && stack.length > 0) {
      const openLine = stack.pop()!;
      pairs.push({ openLine, closeLine: i });
    }
  }
  return pairs;
}

export class MarkingDivHighlightProvider implements vscode.DocumentHighlightProvider {
  provideDocumentHighlights(
    doc: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.DocumentHighlight[] | null {
    const curLine = position.line;
    const lineText = doc.lineAt(curLine).text;

    const isOpen = DIV_OPEN_RE.test(lineText);
    const isClose = DIV_CLOSE_RE.test(lineText);
    if (!isOpen && !isClose) return null;

    const pairs = findDivPairs(doc);

    for (const pair of pairs) {
      if (curLine === pair.openLine || curLine === pair.closeLine) {
        const openText = doc.lineAt(pair.openLine).text;
        const closeText = doc.lineAt(pair.closeLine).text;
        return [
          new vscode.DocumentHighlight(
            new vscode.Range(pair.openLine, 0, pair.openLine, openText.length),
            vscode.DocumentHighlightKind.Read,
          ),
          new vscode.DocumentHighlight(
            new vscode.Range(pair.closeLine, 0, pair.closeLine, closeText.length),
            vscode.DocumentHighlightKind.Read,
          ),
        ];
      }
    }
    return null;
  }
}
