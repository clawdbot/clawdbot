#!/usr/bin/env node
/**
 * Creates the esbuild plugin that neutralizes Pierre diffs' browser side-effect import.
 */
export function createPierreDiffsSideEffectImportPlugin(): {
  name: string;
  setup(buildContext: unknown): void;
};
