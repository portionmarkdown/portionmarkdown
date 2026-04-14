/** Word-wrap a list of (text, font) runs into lines. */

import type { TextRun } from "./types";
import { textWidth } from "./fontMetrics";

export function wrap(
  runs: TextRun[],
  maxW: number,
  size: number,
  hangIndent: number = 0,
): TextRun[][] {
  const lines: TextRun[][] = [];
  let cur: TextRun[] = [];
  let cw = 0;

  // Line 0 uses full maxW; continuation lines use maxW - hangIndent
  function lineMaxW(): number {
    return lines.length === 0 ? maxW : maxW - hangIndent;
  }

  for (const { text, font, link, footnoteRef, strikethrough } of runs) {
    // Split on explicit line breaks (\n) first
    const segments = text.split("\n");
    for (let si = 0; si < segments.length; si++) {
      if (si > 0) {
        // Force a new line at each \n (push even if empty for blank lines)
        lines.push(cur);
        cur = [];
        cw = 0;
      }
      const segment = segments[si];
      const words = segment.split(" ");
      for (let wi = 0; wi < words.length; wi++) {
        const word = words[wi];
        const lmw = lineMaxW();
        if (wi > 0) {
          const sw = textWidth(" ", font, size);
          const ww = word ? textWidth(word, font, size) : 0;
          if (cw + sw + ww > lmw && cur.length > 0 && word) {
            lines.push(cur);
            cur = [];
            cw = 0;
          } else if (cur.length > 0) {
            const sp: TextRun = { text: " ", font };
            if (link) sp.link = link;
            if (footnoteRef != null) sp.footnoteRef = footnoteRef;
            if (strikethrough) sp.strikethrough = true;
            cur.push(sp);
            cw += sw;
          }
        }
        if (word) {
          const ww = textWidth(word, font, size);
          const lmw2 = lineMaxW();
          if (cw + ww > lmw2 && cur.length > 0) {
            lines.push(cur);
            cur = [];
            cw = 0;
          }
          // Break word character-by-character if it exceeds line width
          const lmw3 = lineMaxW();
          if (textWidth(word, font, size) > lmw3) {
            let chunk = "";
            let chunkW = 0;
            for (const ch of word) {
              const chW = textWidth(ch, font, size);
              if (chunkW + chW > lineMaxW() && chunk) {
                const cr: TextRun = { text: chunk, font };
                if (link) cr.link = link;
                if (footnoteRef != null) cr.footnoteRef = footnoteRef;
                if (strikethrough) cr.strikethrough = true;
                cur.push(cr);
                lines.push(cur);
                cur = [];
                cw = 0;
                chunk = ch;
                chunkW = chW;
              } else {
                chunk += ch;
                chunkW += chW;
              }
            }
            if (chunk) {
              const cr: TextRun = { text: chunk, font };
              if (link) cr.link = link;
              if (footnoteRef != null) cr.footnoteRef = footnoteRef;
              if (strikethrough) cr.strikethrough = true;
              cur.push(cr);
              cw += chunkW;
            }
          } else {
            const wr: TextRun = { text: word, font };
            if (link) wr.link = link;
            if (footnoteRef != null) wr.footnoteRef = footnoteRef;
            if (strikethrough) wr.strikethrough = true;
            cur.push(wr);
            cw += ww;
          }
        }
      }
    }
  }
  if (cur.length > 0) {
    lines.push(cur);
  }
  return lines.length > 0 ? lines : [[{ text: "", font: "Helvetica" }]];
}
