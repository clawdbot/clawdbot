#!/usr/bin/env node
export function collectLegacyPluginRuntimeDepsStateRoots(
  params?: Record<string, unknown>,
): string[];
export function pruneLegacyPluginRuntimeDepsState(params?: Record<string, unknown>): string[];
export function pruneInstalledPackageDist(params?: Record<string, unknown>): unknown[];
export function applyBaileysEncryptedStreamFinishHotfix(params?: Record<string, unknown>):
  | {
      applied: boolean;
      reason: string | undefined;
      targetPath: string;
      error?: undefined;
    }
  | {
      applied: boolean;
      reason: string;
      targetPath?: undefined;
      error?: undefined;
    }
  | {
      applied: boolean;
      reason: string;
      targetPath: string;
      error: string;
    };
export function runPluginRegistryPostinstallMigration(
  params?: Record<string, unknown>,
): Promise<unknown>;
export function isSourceCheckoutRoot(params: unknown): unknown;
export function pruneBundledPluginSourceNodeModules(params?: Record<string, unknown>): void;
export function pruneOpenClawCompileCache(params?: Record<string, unknown>): void;
export function runBundledPluginPostinstall(params?: Record<string, unknown>): void;
export function isDirectPostinstallInvocation(params?: Record<string, unknown>): boolean;
export const MAX_INSTALLED_DIST_SCAN_ENTRIES: 100000;
