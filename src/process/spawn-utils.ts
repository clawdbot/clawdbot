import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject } from "../infra/errors.js";

type SpawnWithFallbackResult = {
  child: ChildProcess;
  usedFallback: boolean;
};

type SpawnWithFallbackParams = {
  assertCurrent?: () => void;
  argv: string[];
  options: SpawnOptions;
  fallbacks?: SpawnOptions[];
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
};

export function resolveCommandStdio(params: {
  hasInput: boolean;
  preferInherit: boolean;
}): ["pipe" | "inherit" | "ignore", "pipe", "pipe"] {
  const stdin = params.hasInput ? "pipe" : params.preferInherit ? "inherit" : "pipe";
  return [stdin, "pipe", "pipe"];
}

function shouldRetry(err: unknown): boolean {
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
  return code === "EBADF";
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
  const baseOptions = { ...params.options };
  const fallbacks = params.fallbacks ?? [];
  const attempts = [baseOptions, ...fallbacks.map((options) => ({ ...baseOptions, ...options }))];

  let lastError: unknown;
  for (const [index, attempt] of attempts.entries()) {
    // Caller revocation is not a spawn failure and cannot select a fallback.
    params.assertCurrent?.();
    try {
      const child = await spawnAndWaitForSpawn(spawnImpl, params.argv, attempt);
      return {
        child,
        usedFallback: index > 0,
      };
    } catch (err) {
      lastError = err;
      const nextFallback = fallbacks[index];
      if (!nextFallback || !shouldRetry(err)) {
        throw err;
      }
    }
  }

  throw lastError;
}
