/**
 * Validation — mirrors _validate_markings() from md2pdf.py.
 */

import type { MarkingDefs, DocConfig } from "./types";
import { parseBase, isClassified, isCui } from "./config";

export function validateMarkings(
  text: string,
  mdefs: MarkingDefs,
  config: DocConfig,
): string[] {
  const errors: string[] = [];

  // Collect refs and check nesting
  const refs: Record<string, number[]> = {};
  const openStack: Array<{ key: string; lineno: number }> = [];
  const divOpenRe = /<div\s[^>]*marking\s*=\s*["']([^"']+)["']/i;
  const divCloseRe = /<\/div\s*>/i;

  const lines = text.split("\n");
  for (let lineno = 0; lineno < lines.length; lineno++) {
    const line = lines[lineno];
    const m = divOpenRe.exec(line);
    if (m) {
      const key = m[1].trim();
      if (!refs[key]) refs[key] = [];
      refs[key].push(lineno + 1);
      if (openStack.length > 0) {
        const outer = openStack[openStack.length - 1];
        errors.push(
          `Nested marking div '${key}' on line ${lineno + 1} ` +
            `inside '${outer.key}' opened on line ${outer.lineno} ` +
            `— marking divs cannot be nested`,
        );
      }
      openStack.push({ key, lineno: lineno + 1 });
    }
    if (divCloseRe.test(line) && openStack.length > 0) {
      openStack.pop();
    }
  }

  // Undefined keys
  for (const [key, refLines] of Object.entries(refs)) {
    if (!(key in mdefs)) {
      const locs = refLines.join(", ");
      const defined =
        Object.keys(mdefs).length > 0 ? Object.keys(mdefs).sort().join(", ") : "(none)";
      errors.push(
        `Marking key '${key}' referenced on line(s) ${locs} ` +
          `but not defined in <!-- markings --> (defined: ${defined})`,
      );
    }
  }

  // Conflict checks (skipped in example mode)
  if (!config.exampleMode) {
    const { base: bannerBase } = parseBase(config.marking);
    const banUnclass = bannerBase === "UNCLASSIFIED";
    const banCui = isCui(bannerBase);
    const banClassified = isClassified(bannerBase);

    const hasCuiPortions = Object.values(mdefs).some((md) =>
      isCui(parseBase(md.long).base),
    );
    const hasClassifiedPortions = Object.values(mdefs).some((md) =>
      isClassified(parseBase(md.long).base),
    );

    // UNCLASSIFIED conflicts
    if (banUnclass && Object.keys(mdefs).length > 0) {
      const keys = Object.keys(mdefs).sort().join(", ");
      errors.push(
        `Document is UNCLASSIFIED but defines portion markings ` +
          `(${keys}) — remove the markings or set a higher classification`,
      );
    }
    if (banUnclass && config.classificationBlock.trim()) {
      errors.push(
        "Document is UNCLASSIFIED but contains a classification " +
          "authority block — remove the block or set a higher classification",
      );
    }
    if (banUnclass && config.cuiBlock.trim()) {
      errors.push(
        "Document is UNCLASSIFIED but contains a CUI block " +
          "— remove the block or set an appropriate marking (e.g. CUI)",
      );
    }

    // Missing CUI block
    if ((banCui || hasCuiPortions) && !config.cuiBlock.trim()) {
      errors.push(
        "Document contains CUI content but has no <!-- cui --> block " +
          "— add CUI designation information",
      );
    }

    // Classified completeness
    if (config.classificationBlock.trim() || banClassified || hasClassifiedPortions) {
      if (!config.classificationBlock.trim()) {
        errors.push(
          "Document has classified content but no classification " +
            "authority block — add authority info in <!-- classification -->",
        );
      }
      if (!banClassified) {
        errors.push(
          `Document has a classification authority block but the ` +
            `banner is ${bannerBase}, not a classified level`,
        );
      }
      if (!hasClassifiedPortions) {
        errors.push(
          "Document has classified content but no classified " +
            "portion markings — classified documents require " +
            "portion marking per ISOO",
        );
      }
    }
  }

  return errors;
}
