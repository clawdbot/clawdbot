/** Parses compact Knip export sections into one path-and-symbol entry per finding. */
export function parseKnipCompactUnusedExports(output: string): string[];
/** Parses compact Knip export sections and reports whether Knip emitted one. */
export function parseKnipCompactUnusedExportsResult(output: string): {
  entries: string[];
  sawExportSection: boolean;
};
/** Rejects every unused export reported by Knip. */
export function checkUnusedExports(output: string): {
  ok: boolean;
  entries: string[];
  message: string;
};
