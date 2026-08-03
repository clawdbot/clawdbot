#!/usr/bin/env node
export function getNativeA2uiResourcePaths(repoRoot?: string): {
  sourceDir: string;
  linuxConsumerFile: string;
  linuxBuildFile: string;
  androidBuildFile: string;
  iosProjectFile: string;
};
export function checkLinuxCanvasA2uiReferences({
  linuxConsumerFile,
}: {
  linuxConsumerFile: string;
}): Promise<void>;
export function checkNativeA2uiBuildReferences({
  linuxBuildFile,
  androidBuildFile,
  iosProjectFile,
}: {
  linuxBuildFile: string;
  androidBuildFile: string;
  iosProjectFile: string;
}): Promise<void>;
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
