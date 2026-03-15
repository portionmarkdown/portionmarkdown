/** Page object — accumulates PDF drawing operations for one page. */

import type { RGB } from "./types";
import { FONT_RES, pdfEscape } from "./fontMetrics";

function clr(c: RGB): string {
  return `${c[0].toFixed(3)} ${c[1].toFixed(3)} ${c[2].toFixed(3)}`;
}

export interface LinkAnnot {
  x: number;
  y: number;
  w: number;
  h: number;
  url: string;
}

export class Pg {
  ops: string[] = [];
  links: LinkAnnot[] = [];

  text(x: number, y: number, s: string, font: string, sz: number, color?: RGB): void {
    const c = color ? `${clr(color)} rg ` : "";
    this.ops.push(
      `BT ${c}/${FONT_RES[font]} ${sz} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${pdfEscape(s)}) Tj ET`,
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, w = 0.5, color?: RGB): void {
    const c = color ? `${clr(color)} RG ` : "";
    this.ops.push(
      `${c}${w} w ${x1.toFixed(1)} ${y1.toFixed(1)} m ${x2.toFixed(1)} ${y2.toFixed(1)} l S`,
    );
  }

  rect(x: number, y: number, w: number, h: number, color: RGB): void {
    this.ops.push(
      `q ${clr(color)} rg ${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f Q`,
    );
  }

  rectStroke(
    x: number,
    y: number,
    w: number,
    h: number,
    color: RGB = [0, 0, 0],
    lw = 0.5,
  ): void {
    this.ops.push(
      `q ${clr(color)} RG ${lw} w ${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re S Q`,
    );
  }

  image(x: number, y: number, w: number, h: number, name: string): void {
    this.ops.push(
      `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q`,
    );
  }

  addLink(x: number, y: number, w: number, h: number, url: string): void {
    this.links.push({ x, y, w, h, url });
  }

  stream(): string {
    return this.ops.join("\n");
  }
}
