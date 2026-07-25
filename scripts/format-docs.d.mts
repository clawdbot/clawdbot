#!/usr/bin/env node
export function docsFiles(root?: string, deps?: Record<string, unknown>): string[];
export function chunkFilesForCommand(
  files: unknown,
  prefixArgs: unknown,
  maxBytes?: number,
): unknown[][];
export function resolveOxfmtInvocation(
  args: unknown,
  params?: Record<string, unknown>,
):
  | {
      command: string;
      args: string[];
      shell: boolean;
      windowsVerbatimArguments: boolean;
    }
  | {
      command: string;
      args: string[];
      shell: boolean;
      windowsVerbatimArguments?: undefined;
    }
  | {
      command: string;
      args: string[];
      shell: boolean;
      windowsVerbatimArguments?: undefined;
    };
export function runOxfmt(
  files: unknown,
  params?: Record<string, unknown>,
  deps?: Record<string, unknown>,
): void;
export function formatDocs(
  params?: Record<string, unknown>,
  deps?: Record<string, unknown>,
): {
  changed: unknown[];
  fileCount: number;
};
