export type NpmPackBudgetResult = {
  filename?: string;
  unpackedSize?: number;
};

export type NpmPackBudgetResults =
  | Iterable<NpmPackBudgetResult>
  | NpmPackBudgetResult
  | Record<string, NpmPackBudgetResult>;

export declare function collectPackUnpackedSizeErrors(
  results: NpmPackBudgetResults,
  options?: {
    budgetBytes?: number;
    missingDataMessage?: string;
  },
): string[];
