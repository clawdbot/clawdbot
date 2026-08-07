import type fs from "node:fs";

type CliBootstrapCheckParams = {
  rootDir?: string;
  entrypoints?: string[];
  distDir?: string;
  gatewayRunChunkMaxBytes?: number;
  nativeHookRelayEntrypoint?: string;
  nativeHookRelayStaticMaxBytes?: number;
  fs?: typeof fs;
  logger?: { error(message: string): void };
};

export function listStaticImportSpecifiers(source: string): string[];
export function collectCliBootstrapExternalImportErrors(params?: CliBootstrapCheckParams): string[];
export function collectGatewayRunChunkBudgetErrors(params?: CliBootstrapCheckParams): string[];
export function collectNativeHookRelayBundleErrors(params?: CliBootstrapCheckParams): string[];
export function checkCliBootstrapExternalImports(params?: CliBootstrapCheckParams): void;
