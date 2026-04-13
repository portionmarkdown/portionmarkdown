/** Image loading: JPEG native, PNG via zlib decompression. */

import * as fs from "fs";
import * as zlib from "zlib";
import type { ImageInfo } from "./types";

/** Parse JPEG SOF marker → {width, height, components} or null. */
function jpegDims(
  data: Buffer,
): { width: number; height: number; components: number } | null {
  let i = 2;
  while (i < data.length - 9) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1];
    if (marker >= 0xc0 && marker <= 0xc2) {
      // SOF0-SOF2
      const h = (data[i + 5] << 8) | data[i + 6];
      const w = (data[i + 7] << 8) | data[i + 8];
      const n = data[i + 9];
      return { width: w, height: h, components: n };
    }
    if (marker === 0xd9) break;
    if (marker >= 0xd0 && marker <= 0xd8) {
      i += 2;
    } else {
      const segLen = (data[i + 2] << 8) | data[i + 3];
      i += 2 + segLen;
    }
  }
  return null;
}

/** Parse PNG and return raw RGB pixel data for PDF embedding. */
function loadPng(data: Buffer): ImageInfo | null {
  // Verify PNG signature
  if (data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e || data[3] !== 0x47) {
    return null;
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];
  let pos = 8; // skip signature

  while (pos < data.length) {
    const chunkLen =
      (data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3];
    const chunkType = data.toString("ascii", pos + 4, pos + 8);

    if (chunkType === "IHDR") {
      width =
        (data[pos + 8] << 24) |
        (data[pos + 9] << 16) |
        (data[pos + 10] << 8) |
        data[pos + 11];
      height =
        (data[pos + 12] << 24) |
        (data[pos + 13] << 16) |
        (data[pos + 14] << 8) |
        data[pos + 15];
      bitDepth = data[pos + 16];
      colorType = data[pos + 17];
    } else if (chunkType === "IDAT") {
      idatChunks.push(data.subarray(pos + 8, pos + 8 + chunkLen));
    } else if (chunkType === "IEND") {
      break;
    }

    pos += 12 + chunkLen; // 4 len + 4 type + data + 4 crc
  }

  if (width === 0 || height === 0 || idatChunks.length === 0) return null;
  if (bitDepth !== 8) return null; // only support 8-bit

  const compressed = Buffer.concat(idatChunks);
  let rawData: Buffer;
  try {
    rawData = zlib.inflateSync(compressed);
  } catch {
    return null;
  }

  // Determine bytes per pixel and reconstruct
  let bpp: number;
  let _hasAlpha = false;
  switch (colorType) {
    case 0:
      bpp = 1;
      break; // Grayscale
    case 2:
      bpp = 3;
      break; // RGB
    case 4:
      bpp = 2;
      _hasAlpha = true;
      break; // Grayscale+Alpha
    case 6:
      bpp = 4;
      _hasAlpha = true;
      break; // RGBA
    default:
      return null; // Indexed or unsupported
  }

  const stride = width * bpp + 1; // +1 for filter byte
  if (rawData.length < stride * height) return null;

  // Unfilter
  const unfiltered = Buffer.alloc(width * bpp * height);
  const prevRow = Buffer.alloc(width * bpp);

  for (let row = 0; row < height; row++) {
    const filterType = rawData[row * stride];
    const rowStart = row * stride + 1;
    const outStart = row * width * bpp;

    for (let x = 0; x < width * bpp; x++) {
      const raw = rawData[rowStart + x];
      const a = x >= bpp ? unfiltered[outStart + x - bpp] : 0;
      const b = row > 0 ? prevRow[x] : 0;
      const c = x >= bpp && row > 0 ? prevRow[x - bpp] : 0;

      let val: number;
      switch (filterType) {
        case 0:
          val = raw;
          break;
        case 1:
          val = (raw + a) & 0xff;
          break;
        case 2:
          val = (raw + b) & 0xff;
          break;
        case 3:
          val = (raw + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          val = (raw + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          val = raw;
      }
      unfiltered[outStart + x] = val;
    }

    // Copy current row to prevRow
    unfiltered.copy(prevRow, 0, outStart, outStart + width * bpp);
  }

  // Convert to RGB (strip alpha, expand grayscale)
  const rgbData = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const src = i * bpp;
    const dst = i * 3;
    switch (colorType) {
      case 0: // Grayscale
        rgbData[dst] = rgbData[dst + 1] = rgbData[dst + 2] = unfiltered[src];
        break;
      case 2: // RGB
        rgbData[dst] = unfiltered[src];
        rgbData[dst + 1] = unfiltered[src + 1];
        rgbData[dst + 2] = unfiltered[src + 2];
        break;
      case 4: {
        // Grayscale+Alpha → blend on white
        const g = unfiltered[src];
        const alpha = unfiltered[src + 1] / 255;
        const blended = Math.round(g * alpha + 255 * (1 - alpha));
        rgbData[dst] = rgbData[dst + 1] = rgbData[dst + 2] = blended;
        break;
      }
      case 6: {
        // RGBA → blend on white
        const alpha6 = unfiltered[src + 3] / 255;
        rgbData[dst] = Math.round(unfiltered[src] * alpha6 + 255 * (1 - alpha6));
        rgbData[dst + 1] = Math.round(unfiltered[src + 1] * alpha6 + 255 * (1 - alpha6));
        rgbData[dst + 2] = Math.round(unfiltered[src + 2] * alpha6 + 255 * (1 - alpha6));
        break;
      }
    }
  }

  // Deflate the RGB data for FlateDecode
  const deflated = zlib.deflateSync(rgbData);

  return {
    data: deflated,
    width,
    height,
    cs: "DeviceRGB",
    bpc: 8,
    filter: "FlateDecode",
  };
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Load image from a raw buffer (JPEG or PNG) for PDF embedding. */
export function loadImageBuffer(data: Buffer): ImageInfo | null {
  if (data.length < 4) return null;

  // JPEG
  if (data[0] === 0xff && data[1] === 0xd8) {
    const dims = jpegDims(data);
    if (!dims) return null;
    return {
      data,
      width: dims.width,
      height: dims.height,
      cs: dims.components >= 3 ? "DeviceRGB" : "DeviceGray",
      bpc: 8,
      filter: "DCTDecode",
    };
  }

  // PNG
  if (data[0] === 0x89 && data[1] === 0x50) {
    return loadPng(data);
  }

  return null;
}

/** Load an image file and return info for PDF embedding, or null. */
export function loadImage(filePath: string): ImageInfo | null {
  let data: Buffer;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  return loadImageBuffer(data);
}
