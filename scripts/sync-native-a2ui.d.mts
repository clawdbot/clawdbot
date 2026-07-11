#!/usr/bin/env node
export function getNativeA2uiResourcePaths(repoRoot?: string): {
  sourceDir: string;
  nativeDir: string;
};
export function syncNativeA2uiResources({
  sourceDir,
  nativeDir,
}: {
  sourceDir: unknown;
  nativeDir: unknown;
}): Promise<void>;
export function checkNativeA2uiResources({
  sourceDir,
  nativeDir,
}: {
  sourceDir: unknown;
  nativeDir: unknown;
}): Promise<void>;
