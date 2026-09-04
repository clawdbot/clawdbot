// Spawn utilities configure child processes and normalize spawned process handles.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject } from "../infra/errors.js";

type SpawnFallback = {
  label: string;
  options: SpawnOptions;
};

type SpawnWithFallbackResult = {
  child: ChildProcess;
  usedFallback: boolean;
  fallbackLabel?: string;
};

type SpawnWithFallbackParams = {
  assertCurrent?: () => void;
  argv: string[];
  options: SpawnOptions;
  fallbacks?: SpawnFallback[];
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  retryCodes?: string[];
  onFallback?: (err: unknown, fallback: SpawnFallback) => void;
};

const DEFAULT_RETRY_CODES = ["EBADF"];

export function resolveCommandStdio(params: {
  hasInput: boolean;
  preferInherit: boolean;
}): ["pipe" | "inherit" | "ignore", "pipe", "pipe"] {
  const stdin = params.hasInput ? "pipe" : params.preferInherit ? "inherit" : "pipe";
  return [stdin, "pipe", "pipe"];
}

function shouldRetry(err: unknown, codes: string[]): boolean {
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
  return code.length > 0 && codes.includes(code);
}

async function spawnAndWaitForSpawn(
  spawnImpl: NonNullable<SpawnWithFallbackParams["spawnImpl"]>,
  argv: string[],
  options: SpawnOptions,
): Promise<ChildProcess> {
  const child = spawnImpl(expectDefined(argv[0], "argv entry at 0"), argv.slice(1), options);

  try {
    await once(child, "spawn");
  } catch (err) {
    throw toErrorObject(err, "Non-Error rejection");
  }
  return child;
}

export async function spawnWithFallback(
  params: SpawnWithFallbackParams,
): Promise<SpawnWithFallbackResult> {
  const spawnImpl = params.spawnImpl ?? spawn;
  const retryCodes = params.retryCodes ?? DEFAULT_RETRY_CODES;
  const baseOptions = { ...params.options };
  const fallbacks = params.fallbacks ?? [];
  const attempts: Array<{ label?: string; options: SpawnOptions }> = [
    { options: baseOptions },
    ...fallbacks.map((fallback) => ({
      label: fallback.label,
      options: { ...baseOptions, ...fallback.options },
    })),
  ];

  let lastError: unknown;
  for (const [index, attempt] of attempts.entries()) {
    // Caller revocation is not a spawn failure and cannot select a fallback.
    params.assertCurrent?.();
    try {
      const child = await spawnAndWaitForSpawn(spawnImpl, params.argv, attempt.options);
      return {
        child,
        usedFallback: index > 0,
        fallbackLabel: attempt.label,
      };
    } catch (err) {
      lastError = err;
      const nextFallback = fallbacks[index];
      if (!nextFallback || !shouldRetry(err, retryCodes)) {
        throw err;
      }
      params.onFallback?.(err, nextFallback);
    }
  }

  throw lastError;
}
