export function stateDir(): string;
export function configPath(): string;
export function managedNpmRoot(): string;
export function realPathMaybe(filePath: string): string;
export function assertPathInside(parentPath: string, childPath: string, label: string): void;
import type { PluginInstallRecord } from "./plugin-index-sqlite.mjs";

export function readInstallRecords(
  fallbackRecords?: Record<string, PluginInstallRecord>,
): Record<string, PluginInstallRecord>;
export function npmProjectRootForInstalledPackage(installPath: string, packageName: string): string;
export function findPackageJson(packageName: string, roots: string[]): string | undefined;
export { readJson };
import { readJson } from "./fixtures/common.mjs";
