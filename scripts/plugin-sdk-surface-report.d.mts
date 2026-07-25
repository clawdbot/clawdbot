#!/usr/bin/env node
export function readPluginSdkSurfaceBudgets(env?: NodeJS.ProcessEnv): {
  budgets: {
    publicEntrypoints: number;
    publicExports: number;
    publicFunctionExports: number;
    publicDeprecatedExports: number;
    publicWildcardReexports: number;
  };
  publicDeprecatedExportsByEntrypointBudget: number;
};
export function collectPluginSdkSurfaceReport(): {
  allStats: {
    byEntrypoint: Map<unknown, unknown>;
    totals: {
      entrypoints: unknown;
      exports: number;
      callableExports: number;
      deprecatedExports: number;
      deprecatedCallableExports: number;
      uniqueExports: number;
      uniqueCallableExports: number;
    };
  };
  deprecatedBarrelMissingFromInventory: string[];
  deprecatedBarrelWithoutWildcard: string[];
  deprecatedMissingFromPublic: string[];
  leakedForbiddenExports: string[];
  localOnlyMissingFromInventory: string[];
  localOnlyStats: {
    byEntrypoint: Map<unknown, unknown>;
    totals: {
      entrypoints: unknown;
      exports: number;
      callableExports: number;
      deprecatedExports: number;
      deprecatedCallableExports: number;
      uniqueExports: number;
      uniqueCallableExports: number;
    };
  };
  localOnlyStillPublic: string[];
  publicStats: {
    byEntrypoint: Map<unknown, unknown>;
    totals: {
      entrypoints: unknown;
      exports: number;
      callableExports: number;
      deprecatedExports: number;
      deprecatedCallableExports: number;
      uniqueExports: number;
      uniqueCallableExports: number;
    };
  };
  publicWildcards: {
    count: number;
    matches: string[];
  };
};
export function evaluatePluginSdkSurfaceReport(
  report: unknown,
  {
    budgets,
    publicDeprecatedExportsByEntrypointBudget,
  }: {
    budgets: unknown;
    publicDeprecatedExportsByEntrypointBudget: unknown;
  },
): string[];
