/**
 * Minimal TrueType font parser — extracts metrics needed for PDF embedding.
 */

export interface TtfMetrics {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  bbox: [number, number, number, number];
  italicAngle: number;
  stemV: number;
  flags: number;
  widths: number[]; // 256 entries for WinAnsiEncoding (PDF units, 1/1000 em)
  postscriptName: string;
}

// CP-1252 byte → Unicode code point (0x80–0x9F range)
const CP1252_TO_UNICODE: Record<number, number> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
};

function cp1252ToUnicode(byte: number): number {
  if (byte < 0x80 || byte >= 0xa0) return byte;
  return CP1252_TO_UNICODE[byte] ?? byte;
}

interface TableEntry {
  offset: number;
  length: number;
}

function readTable(
  buf: Buffer,
  tag: string,
  tables: Map<string, TableEntry>,
): Buffer | null {
  const t = tables.get(tag);
  if (!t) return null;
  return buf.subarray(t.offset, t.offset + t.length);
}

function parseCmapFormat4(data: Buffer, offset: number): Map<number, number> {
  const map = new Map<number, number>();
  const segCountX2 = data.readUInt16BE(offset + 6);
  const segCount = segCountX2 / 2;

  const endCodeOff = offset + 14;
  const startCodeOff = endCodeOff + segCountX2 + 2; // +2 for reservedPad
  const idDeltaOff = startCodeOff + segCountX2;
  const idRangeOffOff = idDeltaOff + segCountX2;

  for (let i = 0; i < segCount; i++) {
    const endCode = data.readUInt16BE(endCodeOff + i * 2);
    const startCode = data.readUInt16BE(startCodeOff + i * 2);
    const idDelta = data.readInt16BE(idDeltaOff + i * 2);
    const idRangeOffset = data.readUInt16BE(idRangeOffOff + i * 2);

    if (startCode === 0xffff) break;

    for (let c = startCode; c <= endCode; c++) {
      let glyphIndex: number;
      if (idRangeOffset === 0) {
        glyphIndex = (c + idDelta) & 0xffff;
      } else {
        const glyphOff = idRangeOffOff + i * 2 + idRangeOffset + (c - startCode) * 2;
        glyphIndex = data.readUInt16BE(glyphOff);
        if (glyphIndex !== 0) {
          glyphIndex = (glyphIndex + idDelta) & 0xffff;
        }
      }
      if (glyphIndex !== 0) {
        map.set(c, glyphIndex);
      }
    }
  }
  return map;
}

export function parseTtf(buf: Buffer): TtfMetrics {
  // Read table directory
  const numTables = buf.readUInt16BE(4);
  const tables = new Map<string, TableEntry>();
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    const tag = buf.subarray(off, off + 4).toString("ascii");
    tables.set(tag, {
      offset: buf.readUInt32BE(off + 8),
      length: buf.readUInt32BE(off + 12),
    });
  }

  // head table
  const head = readTable(buf, "head", tables)!;
  const unitsPerEm = head.readUInt16BE(18);
  const xMin = head.readInt16BE(36);
  const yMin = head.readInt16BE(38);
  const xMax = head.readInt16BE(40);
  const yMax = head.readInt16BE(42);

  // hhea table
  const hhea = readTable(buf, "hhea", tables)!;
  const numberOfHMetrics = hhea.readUInt16BE(34);

  // maxp table
  const maxp = readTable(buf, "maxp", tables)!;
  const numGlyphs = maxp.readUInt16BE(4);

  // OS/2 table
  const os2 = readTable(buf, "OS/2", tables)!;
  const usWeightClass = os2.readUInt16BE(4);
  const fsSelection = os2.readUInt16BE(62);
  const sTypoAscender = os2.readInt16BE(68);
  const sTypoDescender = os2.readInt16BE(70);
  const sCapHeight = os2.length >= 90 ? os2.readInt16BE(88) : sTypoAscender;

  // hmtx table — glyph advance widths
  const hmtx = readTable(buf, "hmtx", tables)!;
  const advances: number[] = new Array(numGlyphs);
  let lastAdv = 0;
  for (let i = 0; i < numberOfHMetrics; i++) {
    lastAdv = hmtx.readUInt16BE(i * 4);
    advances[i] = lastAdv;
  }
  for (let i = numberOfHMetrics; i < numGlyphs; i++) {
    advances[i] = lastAdv;
  }

  // cmap table — Unicode to glyph mapping
  const cmap = readTable(buf, "cmap", tables)!;
  const cmapNumTables = cmap.readUInt16BE(2);
  let unicodeToGlyph = new Map<number, number>();
  for (let i = 0; i < cmapNumTables; i++) {
    const platformID = cmap.readUInt16BE(4 + i * 8);
    const encodingID = cmap.readUInt16BE(4 + i * 8 + 2);
    const subtableOffset = cmap.readUInt32BE(4 + i * 8 + 4);
    if (platformID === 3 && encodingID === 1) {
      const fmt = cmap.readUInt16BE(subtableOffset);
      if (fmt === 4) {
        unicodeToGlyph = parseCmapFormat4(cmap, subtableOffset);
      }
      break;
    }
  }

  // name table — PostScript name (nameID 6)
  let postscriptName = "UnknownFont";
  const nameTable = readTable(buf, "name", tables);
  if (nameTable) {
    const nameCount = nameTable.readUInt16BE(2);
    const stringOffset = nameTable.readUInt16BE(4);
    for (let i = 0; i < nameCount; i++) {
      const recOff = 6 + i * 12;
      const platformID = nameTable.readUInt16BE(recOff);
      const nameID = nameTable.readUInt16BE(recOff + 6);
      const strLength = nameTable.readUInt16BE(recOff + 8);
      const strOffset = nameTable.readUInt16BE(recOff + 10);
      if (nameID === 6 && platformID === 3) {
        // UTF-16BE
        const strBuf = nameTable.subarray(
          stringOffset + strOffset,
          stringOffset + strOffset + strLength,
        );
        let name = "";
        for (let j = 0; j < strBuf.length; j += 2) {
          name += String.fromCharCode(strBuf.readUInt16BE(j));
        }
        postscriptName = name.replace(/\s/g, "");
        break;
      }
    }
  }

  // Build 256-entry WinAnsiEncoding width array
  const scale = 1000 / unitsPerEm;
  const widths: number[] = new Array(256).fill(0);
  for (let b = 0; b < 256; b++) {
    const unicode = cp1252ToUnicode(b);
    const glyph = unicodeToGlyph.get(unicode);
    if (glyph !== undefined && glyph < advances.length) {
      widths[b] = Math.round(advances[glyph] * scale);
    }
  }

  // Compute flags
  const isItalic = (fsSelection & 1) !== 0;
  const isMonospace = readTable(buf, "post", tables)
    ? readTable(buf, "post", tables)!.readUInt32BE(12) !== 0
    : false;
  let flags = 32; // non-symbolic
  if (isMonospace) flags |= 1;
  if (isItalic) flags |= 64;

  const stemV = usWeightClass < 400 ? 68 : usWeightClass < 600 ? 80 : 120;

  return {
    unitsPerEm,
    ascent: Math.round(sTypoAscender * scale),
    descent: Math.round(sTypoDescender * scale),
    capHeight: Math.round(sCapHeight * scale),
    bbox: [
      Math.round(xMin * scale),
      Math.round(yMin * scale),
      Math.round(xMax * scale),
      Math.round(yMax * scale),
    ],
    italicAngle: isItalic ? -12 : 0,
    stemV,
    flags,
    widths,
    postscriptName,
  };
}
