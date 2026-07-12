/** Parses compact Knip export sections into one path-and-symbol entry per finding. */
export function parseKnipCompactUnusedExports(output: string): string[];
/** Parses compact Knip export sections and reports whether Knip emitted one. */
export function parseKnipCompactUnusedExportsResult(output: string): {
  entries: string[];
  sawExportSection: boolean;
};
/** Compares detected unused exports against the checked-in baseline. */
export function compareUnusedExportsToBaseline(
  actualEntries: string[],
  baselineEntries: string[],
  optionalBaselineEntries?: string[],
): {
  actual: string[];
  allowed: string[];
  unexpected: string[];
  stale: string[];
  duplicateAllowedCount: number;
  allowlistIsSorted: boolean;
};
/** Emits the checked-in baseline module used by --update. */
export function formatUnusedExportBaseline(
  requiredEntries: string[],
  optionalEntries?: string[],
): string;
/** Checks Knip output against the current baseline. */
export function checkUnusedExports(
  output: string,
  baselineEntries?: string[],
  optionalBaselineEntries?: string[],
): {
  ok: boolean;
  comparison: {
    actual: string[];
    allowed: string[];
    unexpected: string[];
    stale: string[];
    duplicateAllowedCount: number;
    allowlistIsSorted: boolean;
  };
  message: string;
};
