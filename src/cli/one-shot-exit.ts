import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

type VitestWorkerMarkers = {
  tinypoolState?: unknown;
  vitestWorker?: unknown;
};

const SYSTEM_CA_FLAG = "--use-system-ca";

let requestedExitCode: number | "process" | undefined;

function resolveVitestWorkerMarkers(): VitestWorkerMarkers {
  const processMarkers = process as NodeJS.Process & Record<string, unknown>;
  const globalMarkers = globalThis as typeof globalThis & Record<string, unknown>;
  return {
    tinypoolState: processMarkers["__tinypool_state__"],
    vitestWorker: globalMarkers["__vitest_worker__"],
  };
}

function hasNodeRuntimeOption(
  option: string,
  env: NodeJS.ProcessEnv,
  execArgv: readonly string[],
): boolean {
  const normalize = (value: string) => value.replaceAll("_", "-");
  if (execArgv.some((arg) => normalize(arg) === option)) {
    return true;
  }
  return (env.NODE_OPTIONS ?? "").split(/\s+/u).some((token) => {
    const quote = token[0];
    const unquoted =
      (quote === '"' || quote === "'") && token.at(-1) === quote ? token.slice(1, -1) : token;
    return normalize(unquoted) === option;
  });
}

function resolveProcessExitCode(fallback = 0): number {
  const value = process.exitCode;
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : fallback;
  }
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return fallback;
}

function isVitestWorker(
  env: NodeJS.ProcessEnv,
  markers: VitestWorkerMarkers = resolveVitestWorkerMarkers(),
): boolean {
  const hasVitestEnv =
    env.VITEST === "true" ||
    env.VITEST === "1" ||
    env.VITEST_POOL_ID !== undefined ||
    env.VITEST_WORKER_ID !== undefined;
  return (
    hasVitestEnv && (markers.tinypoolState !== undefined || markers.vitestWorker !== undefined)
  );
}

function requestExitAfterSystemCaCliCompletion(
  runtime: RuntimeEnv = defaultRuntime,
  params: {
    env?: NodeJS.ProcessEnv;
    execArgv?: readonly string[];
    platform?: NodeJS.Platform;
    exitCode?: number;
  } = {},
): boolean {
  const env = params.env ?? process.env;
  const execArgv = params.execArgv ?? process.execArgv;
  const platform = params.platform ?? process.platform;
  const usesSystemCa =
    env.NODE_USE_SYSTEM_CA === "1" || hasNodeRuntimeOption(SYSTEM_CA_FLAG, env, execArgv);
  if (platform !== "darwin" || !usesSystemCa || runtime !== defaultRuntime) {
    return false;
  }
  if (requestedExitCode === undefined) {
    requestedExitCode = params.exitCode ?? "process";
  }
  return true;
}

export async function runCliWithExitFinalization(params: {
  run: () => Promise<void>;
  onError: (error: unknown) => void | Promise<void>;
  runtime?: RuntimeEnv;
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
  platform?: NodeJS.Platform;
  markers?: VitestWorkerMarkers;
}): Promise<void> {
  const runtime = params.runtime ?? defaultRuntime;
  try {
    await params.run();
  } catch (error) {
    await params.onError(error);
    requestExitAfterOneShotOutput(runtime, resolveProcessExitCode(1));
  } finally {
    requestExitAfterSystemCaCliCompletion(runtime, {
      env: params.env,
      execArgv: params.execArgv,
      platform: params.platform,
    });
    flushExitAfterOneShotOutput(runtime, params.env, params.markers);
  }
}

export function requestExitAfterOneShotOutput(
  runtime: RuntimeEnv = defaultRuntime,
  exitCode = 0,
): boolean {
  if (runtime !== defaultRuntime) {
    return false;
  }
  requestedExitCode = exitCode;
  return true;
}

function flushExitAfterOneShotOutput(
  runtime: RuntimeEnv = defaultRuntime,
  env: NodeJS.ProcessEnv = process.env,
  markers: VitestWorkerMarkers = resolveVitestWorkerMarkers(),
): void {
  const requestedCode = requestedExitCode;
  requestedExitCode = undefined;
  if (requestedCode === undefined || runtime !== defaultRuntime || isVitestWorker(env, markers)) {
    return;
  }

  const exit = () =>
    runtime.exit(requestedCode === "process" ? resolveProcessExitCode() : requestedCode);
  let pendingStreams = 2;

  const drain = (stream: NodeJS.WriteStream) => {
    stream.write("", () => {
      pendingStreams -= 1;
      if (pendingStreams === 0) {
        setImmediate(exit);
      }
    });
  };

  drain(process.stdout);
  drain(process.stderr);
}
