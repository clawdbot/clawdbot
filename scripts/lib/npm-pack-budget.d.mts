export type NpmPackBudgetResult = {
  filename?: string;
  unpackedSize?: number;
};

export declare const NPM_PACK_UNPACKED_SIZE_BUDGET_BYTES: number;

export declare function formatMiB(bytes: number): string;

export declare function formatPackUnpackedSizeBudgetError(params: {
  budgetBytes?: number;
  label: string;
  unpackedSize: number;
}): string;

export declare function collectPackUnpackedSizeErrors(
  results: Iterable<NpmPackBudgetResult>,
  options?: {
    budgetBytes?: number;
    missingDataMessage?: string;
  },
): string[];
