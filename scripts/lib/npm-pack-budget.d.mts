export type NpmPackBudgetResult = {
  filename?: string;
  unpackedSize?: number;
};

export declare function collectPackUnpackedSizeErrors(
  results: Iterable<NpmPackBudgetResult>,
  options?: {
    budgetBytes?: number;
    missingDataMessage?: string;
  },
): string[];
