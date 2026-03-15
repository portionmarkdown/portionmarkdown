/**
 * Watermark post-processor — overlay diagonal watermark on every page.
 * Port of Python's _watermark_pdf() function.
 */

import { PAGE_W, PAGE_H } from "./config";
import { textWidth, pdfEscape, encodeCp1252 } from "./fontMetrics";

export function watermarkPdf(data: Buffer, text = "EXAMPLE  EXAMPLE  EXAMPLE"): Buffer {
  const angleRad = Math.atan2(PAGE_H, PAGE_W);
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  const wmSz = 120;

  const word = text.trim() + "  ";
  const wordW = textWidth(word, "Helvetica-Bold", wmSz);
  const diag = Math.hypot(PAGE_W, PAGE_H);
  const nReps = Math.floor(diag / wordW) + 3;
  const rowText = word.repeat(nReps);
  const rowW = wordW * nReps;
  const lineH = wmSz * 2.0;
  const nRows = Math.floor(diag / lineH) + 3;

  const lines: string[] = [];
  lines.push("q");
  lines.push("/GS1 gs");
  lines.push("0.75 0.75 0.75 rg");
  lines.push("BT");
  lines.push(`/F2 ${wmSz} Tf`);
  const cx = PAGE_W / 2;
  const cy = PAGE_H / 2;
  const escRow = pdfEscape(rowText);
  const halfRows = nRows / 2;
  for (let row = 0; row < nRows; row++) {
    const ry = (row - halfRows) * lineH;
    const rx = -rowW / 2;
    lines.push(
      `${cosA.toFixed(6)} ${sinA.toFixed(6)} ${(-sinA).toFixed(6)} ${cosA.toFixed(6)} ` +
        `${(cx + cosA * rx - sinA * ry).toFixed(2)} ` +
        `${(cy + sinA * rx + cosA * ry).toFixed(2)} Tm`,
    );
    lines.push(`(${escRow}) Tj`);
  }
  lines.push("ET");
  lines.push("Q");
  const wmStream = lines.join("\n") + "\n";
  const wmBytes = encodeCp1252(wmStream);

  // Parse existing objects
  const dataStr = data.toString("binary");
  const objPat = /(\d+) 0 obj\n([\s\S]*?)endobj\n/g;
  const rawObjs: Map<number, Buffer> = new Map();
  let match;
  while ((match = objPat.exec(dataStr)) !== null) {
    const objNum = parseInt(match[1], 10);
    rawObjs.set(objNum, Buffer.from(match[2], "binary"));
  }

  let maxObj = 0;
  for (const n of rawObjs.keys()) {
    if (n > maxObj) maxObj = n;
  }

  // Add new objects
  const gsObj = maxObj + 1;
  rawObjs.set(gsObj, Buffer.from("<< /Type /ExtGState /ca 0.18 >>\n"));

  const wmObj = maxObj + 2;
  rawObjs.set(
    wmObj,
    Buffer.concat([
      Buffer.from(`<< /Length ${wmBytes.length} >>\nstream\n`),
      wmBytes,
      Buffer.from("\nendstream\n"),
    ]),
  );

  // Patch each Page to include watermark stream
  for (const [onum, body] of rawObjs) {
    const bodyStr = body.toString("binary");
    if (!/\/Type\s*\/Page\b/.test(bodyStr)) continue;
    const contentsMatch = /\/Contents\s+(\d+)\s+0\s+R/.exec(bodyStr);
    if (!contentsMatch) continue;

    const origSn = contentsMatch[1];
    let newBody = bodyStr.replace(
      contentsMatch[0],
      `/Contents [${origSn} 0 R ${wmObj} 0 R]`,
    );
    newBody = newBody.replace("/Font <<", `/ExtGState << /GS1 ${gsObj} 0 R >> /Font <<`);
    rawObjs.set(onum, Buffer.from(newBody, "binary"));
  }

  // Find Catalog root
  let catObj = 0;
  for (const [n, body] of rawObjs) {
    if (/\/Type\s*\/Catalog/.test(body.toString("binary"))) {
      catObj = n;
      break;
    }
  }

  // Serialize
  const parts: Buffer[] = [];
  parts.push(
    Buffer.from([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3,
      0x0a,
    ]),
  );
  const offs: Map<number, number> = new Map();
  let currentLen = parts[0].length;

  const sortedKeys = [...rawObjs.keys()].sort((a, b) => a - b);
  for (const n of sortedKeys) {
    offs.set(n, currentLen);
    const header = Buffer.from(`${n} 0 obj\n`);
    const footer = Buffer.from("endobj\n");
    const body = rawObjs.get(n)!;
    parts.push(header, body, footer);
    currentLen += header.length + body.length + footer.length;
  }

  const xref = currentLen;
  const _totalObjs = maxObj + 2 + 1; // +2 for gs and wm objects
  const actualTotal = Math.max(...rawObjs.keys()) + 1;
  parts.push(Buffer.from(`xref\n0 ${actualTotal}\n`));
  parts.push(Buffer.from("0000000000 65535 f \n"));

  for (let i = 1; i < actualTotal; i++) {
    if (offs.has(i)) {
      parts.push(Buffer.from(`${offs.get(i)!.toString().padStart(10, "0")} 00000 n \n`));
    } else {
      parts.push(Buffer.from("0000000000 00001 f \n"));
    }
  }

  parts.push(
    Buffer.from(
      `trailer\n<< /Size ${actualTotal} /Root ${catObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );

  return Buffer.concat(parts);
}
