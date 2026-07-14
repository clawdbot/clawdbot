/**
 * Deterministic MXC sandbox baseline policy helpers.
 *
 * These helpers only include policy surfaces the Windows ProcessContainer path
 * currently enforces: workspace/read-only/read-write paths and process timeout.
 */

import { win32 } from "node:path";

const BASELINE_TIMEOUT_SECONDS = 300;

type BaselineFilesystemPolicy = {
  restrictToProjectDir: boolean;
  additionalReadonlyPaths: readonly string[];
  additionalReadwritePaths: readonly string[];
};

export type BaselineFilesystemPolicyInput = {
  restrictToProjectDir?: boolean;
  additionalReadonlyPaths?: readonly string[];
  additionalReadwritePaths?: readonly string[];
};

export type SandboxBaselinePolicy = {
  filesystem: BaselineFilesystemPolicy;
  process: {
    timeoutSeconds: number;
    timeoutSecondsConfigured: boolean;
  };
};

export type SandboxBaselinePolicyInput = {
  filesystem?: BaselineFilesystemPolicyInput;
  process?: {
    timeoutSeconds?: number;
  };
};

type BaselineTempEnv = {
  TEMP?: string;
  TMP?: string;
};

type BaselineReadonlyEnv = {
  SystemRoot?: string;
  WINDIR?: string;
  ProgramFiles?: string;
  ProgramW6432?: string;
  "ProgramFiles(x86)"?: string;
};

export type BaselineHostEnv = BaselineTempEnv & BaselineReadonlyEnv;

export const DEFAULT_SANDBOX_BASELINE: SandboxBaselinePolicy = {
  filesystem: {
    restrictToProjectDir: true,
    additionalReadonlyPaths: [],
    additionalReadwritePaths: [],
  },
  process: {
    timeoutSeconds: BASELINE_TIMEOUT_SECONDS,
    timeoutSecondsConfigured: false,
  },
};

export function resolveSandboxBaseline(
  input: SandboxBaselinePolicyInput = {},
): SandboxBaselinePolicy {
  const timeoutSecondsConfigured = input.process?.timeoutSeconds !== undefined;
  const timeoutSeconds = input.process?.timeoutSeconds ?? BASELINE_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1) {
    throw new RangeError("Sandbox baseline timeoutSeconds must be at least 1.");
  }

  return {
    filesystem: {
      restrictToProjectDir: input.filesystem?.restrictToProjectDir ?? true,
      additionalReadonlyPaths: [...(input.filesystem?.additionalReadonlyPaths ?? [])],
      additionalReadwritePaths: [...(input.filesystem?.additionalReadwritePaths ?? [])],
    },
    process: {
      timeoutSeconds,
      timeoutSecondsConfigured,
    },
  };
}

export function resolveSandboxTempDir(env: BaselineTempEnv = {}): string {
  return env.TEMP ?? env.TMP ?? "C:\\Windows\\Temp";
}

export function resolveBaselineReadonlyPaths(env: BaselineReadonlyEnv): string[] {
  const systemRoot = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
  const programFiles = env.ProgramFiles ?? env.ProgramW6432 ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  return dedupeStable([
    programFiles,
    programFilesX86,
    win32.join(systemRoot, "System32"),
    win32.join(systemRoot, "SysWOW64"),
  ]);
}

function dedupeStable(values: readonly string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}
