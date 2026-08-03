#!/usr/bin/env node
export function collectPluginNpmPublishedRuntimeErrors(params: unknown): string[];
export function resolveNpmPackFilename(output: unknown): string;
export function readPositiveIntEnv(
  name: unknown,
  fallback: unknown,
  env?: NodeJS.ProcessEnv,
): number;
export function readPluginNpmCommandOptions(env?: NodeJS.ProcessEnv): {
  encoding: string;
  killSignal: string;
  maxBuffer: number;
  stdio: string[];
  timeout: number;
};
export function runPluginNpmCommand(args: unknown, params?: Record<string, unknown>): unknown;
export function parseNpmReadmeMetadata(raw: unknown): string;
export function findPackedPackageReadmePath(files: unknown): unknown;
export function usage(): string;
export function parseVerifyPublishedPluginRuntimeArgs(argv: unknown): {
  help: boolean;
  spec: unknown;
};
