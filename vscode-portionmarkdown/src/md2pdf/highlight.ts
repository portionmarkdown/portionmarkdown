/** Syntax highlighting using highlight.js with GitHub base16 colors. */

import hljs from "highlight.js";
import type { RGB } from "./types";
import { CLR_CODE_FG } from "./config";

// GitHub base16 color mapping for hljs CSS classes
const CLASS_COLORS: Record<string, RGB> = {
  "hljs-comment": [0.588, 0.596, 0.588], // base03 #969896
  "hljs-keyword": [0.655, 0.114, 0.365], // base0E #a71d5d
  "hljs-type": [0.475, 0.365, 0.639], // base0A #795da3
  "hljs-built_in": [0.094, 0.212, 0.569], // base0C #183691
  "hljs-title": [0.475, 0.365, 0.639], // base0D #795da3
  "hljs-title.function_": [0.475, 0.365, 0.639], // base0D #795da3
  "hljs-title.class_": [0.475, 0.365, 0.639], // base0A #795da3
  "hljs-tag": [0.929, 0.416, 0.263], // base08 #ed6a43
  "hljs-variable": [0.929, 0.416, 0.263], // base08 #ed6a43
  "hljs-attr": [0.475, 0.365, 0.639], // base0D #795da3
  "hljs-name": [0.929, 0.416, 0.263], // base08 #ed6a43
  "hljs-string": [0.094, 0.212, 0.569], // base0B #183691
  "hljs-regexp": [0.094, 0.212, 0.569], // base0C #183691
  "hljs-number": [0.0, 0.525, 0.702], // base09 #0086b3
  "hljs-literal": [0.0, 0.525, 0.702], // base09 #0086b3
  "hljs-symbol": [0.0, 0.525, 0.702], // base09 #0086b3
  "hljs-meta": [0.094, 0.212, 0.569], // base0C #183691
  "hljs-operator": [0.655, 0.114, 0.365], // base0E #a71d5d
  "hljs-doctag": [0.655, 0.114, 0.365], // base0E #a71d5d
  "hljs-selector-tag": [0.929, 0.416, 0.263], // base08 #ed6a43
  "hljs-selector-class": [0.475, 0.365, 0.639], // base0A #795da3
  "hljs-selector-id": [0.475, 0.365, 0.639], // base0D #795da3
  "hljs-addition": [0.094, 0.212, 0.569], // base0B #183691
  "hljs-deletion": [0.929, 0.416, 0.263], // base08 #ed6a43
  "hljs-subst": [0.2, 0.2, 0.2], // base05 #333333
  "hljs-section": [0.475, 0.365, 0.639], // base0D #795da3
  "hljs-params": [0.2, 0.2, 0.2], // base05 #333333
  "hljs-template-variable": [0.929, 0.416, 0.263], // base08 #ed6a43
  "hljs-template-tag": [0.655, 0.114, 0.365], // base0E #a71d5d
  "hljs-property": [0.2, 0.2, 0.2], // base05 #333333
};

function resolveColor(className: string): RGB {
  if (CLASS_COLORS[className]) return CLASS_COLORS[className];
  // hljs uses space-separated classes like "hljs-title function_";
  // normalize to dot notation "hljs-title.function_" used in color map
  const dotName = className.replace(" ", ".");
  if (CLASS_COLORS[dotName]) return CLASS_COLORS[dotName];
  // Try prefix matching: "hljs-title function_" → "hljs-title"
  const sep = className.indexOf(".");
  if (sep > 0) {
    const prefix = className.slice(0, sep);
    if (CLASS_COLORS[prefix]) return CLASS_COLORS[prefix];
  }
  const space = className.indexOf(" ");
  if (space > 0) {
    const prefix = className.slice(0, space);
    if (CLASS_COLORS[prefix]) return CLASS_COLORS[prefix];
  }
  return CLR_CODE_FG;
}

interface ColoredSpan {
  text: string;
  color: RGB;
}

/**
 * Parse highlight.js HTML output into colored spans.
 * The HTML contains <span class="hljs-xxx">text</span> elements.
 */
function parseHljsHtml(html: string): ColoredSpan[] {
  const spans: ColoredSpan[] = [];
  // Simple regex-based parser for hljs output (no nesting beyond 1 level)
  const _pos = 0;
  const _tagRe = /<span class="([^"]+)">([\s\S]*?)<\/span>/g;

  // We need to handle nested spans and plain text between spans
  // hljs can produce: text <span class="a">text <span class="b">text</span> text</span> text
  // Use a stack-based approach

  const classStack: string[] = [];
  let i = 0;
  let currentText = "";

  while (i < html.length) {
    if (html[i] === "<") {
      // Flush current text
      if (currentText) {
        const color =
          classStack.length > 0
            ? resolveColor(classStack[classStack.length - 1])
            : CLR_CODE_FG;
        spans.push({ text: decodeHtmlEntities(currentText), color });
        currentText = "";
      }

      if (html.startsWith("</span>", i)) {
        classStack.pop();
        i += 7;
      } else if (html.startsWith('<span class="', i)) {
        const classEnd = html.indexOf('"', i + 13);
        if (classEnd >= 0) {
          const cls = html.slice(i + 13, classEnd);
          classStack.push(cls);
          i = classEnd + 2; // skip '"> '
        } else {
          currentText += html[i];
          i++;
        }
      } else {
        // Other HTML tags — skip
        const closeIdx = html.indexOf(">", i);
        if (closeIdx >= 0) {
          i = closeIdx + 1;
        } else {
          currentText += html[i];
          i++;
        }
      }
    } else {
      currentText += html[i];
      i++;
    }
  }

  if (currentText) {
    const color =
      classStack.length > 0
        ? resolveColor(classStack[classStack.length - 1])
        : CLR_CODE_FG;
    spans.push({ text: decodeHtmlEntities(currentText), color });
  }

  return spans;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

type HighlightLine = Array<{ text: string; color: RGB }>;

/**
 * Tokenize text and return a list of lines, each a list of {text, color}.
 * Mirrors Python's _highlight() function.
 */
export function highlight(text: string, lang: string | null): HighlightLine[] {
  const fallback = text.split("\n").map((ln) => [{ text: ln, color: CLR_CODE_FG }]);

  try {
    if (!lang) {
      return fallback;
    }
    const result = hljs.highlight(text, { language: lang, ignoreIllegals: true });

    // Parse the HTML output into colored spans
    const spans = parseHljsHtml(result.value);

    // Split spans into lines
    const lines: HighlightLine[] = [[]];
    for (const span of spans) {
      const parts = span.text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          lines.push([]);
        }
        if (parts[i]) {
          lines[lines.length - 1].push({ text: parts[i], color: span.color });
        }
      }
    }

    // Drop trailing empty line (hljs often appends one)
    if (lines.length > 0 && lines[lines.length - 1].length === 0) {
      lines.pop();
    }

    return lines.length > 0 ? lines : fallback;
  } catch {
    return fallback;
  }
}
