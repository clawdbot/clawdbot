export function parseArgs(argv: string[]):
  | {
      help: true;
      iterations: number;
      methods: string[];
      outputDir?: string;
      repoRoot?: string;
    }
  | {
      help: false;
      iterations: number;
      methods: string[];
      outputDir: string;
      repoRoot?: string;
    };
/**
 * Polls readiness endpoints while also failing fast if the child exits.
 */
export function waitForGatewayReady({
  child,
  fetchImpl,
  port,
  probeTimeoutMs,
  readyTimeoutMs,
  sleepMs,
  stderrPath,
}: {
  child: unknown;
  fetchImpl?: typeof fetch | undefined;
  port: unknown;
  probeTimeoutMs?: number | undefined;
  readyTimeoutMs?: number | undefined;
  sleepMs?: number | undefined;
  stderrPath: unknown;
}): Promise<void>;
/**
 * Signals the gateway process tree so spawned package-manager children are cleaned up.
 */
export function signalGatewayProcess(
  child: unknown,
  signal: unknown,
  killProcess?: typeof defaultKillProcess,
  {
    platform,
    runTaskkill,
  }?: {
    platform?: NodeJS.Platform | undefined;
    runTaskkill?: typeof defaultRunTaskkill | undefined;
  },
): unknown;
/**
 * Checks process-group liveness without treating an already-exited child as an error.
 */
export function isGatewayProcessAlive(
  child: unknown,
  killProcess?: typeof defaultKillProcess,
  {
    platform,
  }?: {
    platform?: NodeJS.Platform | undefined;
  },
): boolean;
/**
 * Installs parent-process cleanup handlers for a spawned gateway.
 */
export function installGatewayParentCleanup(
  child: unknown,
  {
    killProcess,
    platform,
    processLike,
    runTaskkill,
  }?: {
    killProcess?: typeof defaultKillProcess | undefined;
    platform?: NodeJS.Platform | undefined;
    processLike?:
      | {
          exitCode?: number;
          kill(pid: number, signal?: NodeJS.Signals): boolean;
          off(event: string, listener: (...args: unknown[]) => void): unknown;
          on(event: string, listener: (...args: unknown[]) => void): unknown;
          once(event: string, listener: (...args: unknown[]) => void): unknown;
          pid: number;
        }
      | undefined;
    runTaskkill?: typeof defaultRunTaskkill | undefined;
  },
): () => void;
/**
 * Stops the gateway with SIGTERM first and SIGKILL after the grace window.
 */
export function stopGateway(child: unknown, options?: Record<string, unknown>): Promise<void>;
/**
 * Starts an isolated loopback gateway with temp HOME/state directories.
 */
export function startGateway({
  configPath,
  env,
  openImpl,
  port,
  repoRoot,
  sourceEntryExists,
  spawnImpl,
  stderrPath,
  stdoutPath,
  tempRoot,
  token,
}: {
  configPath: unknown;
  env?: NodeJS.ProcessEnv | undefined;
  openImpl?: typeof defaultOpen | undefined;
  port: unknown;
  repoRoot: unknown;
  sourceEntryExists?: typeof existsSync | undefined;
  spawnImpl?: typeof spawn | undefined;
  stderrPath: unknown;
  stdoutPath: unknown;
  tempRoot: unknown;
  token: unknown;
}): Promise<import("node:child_process").ChildProcess>;
/**
 * Removes the temporary root used by the RPC RTT probe.
 */
export function cleanupTempRoot(
  tempRoot: unknown,
  {
    rmImpl,
  }?: {
    rmImpl?: typeof fs.rm | undefined;
  },
): Promise<void>;
export function summarizeRttSamples(samples: unknown): {
  avgMs: number;
  maxMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
};
export function assertRpcSmokeResponse(method: unknown, response: unknown): void;
export function createGatewayClient({
  WebSocket,
  openTimeoutMs,
  url,
}: {
  WebSocket: unknown;
  openTimeoutMs?: number | undefined;
  url: unknown;
}): {
  close: () => void;
  request: (method: unknown, params: unknown, timeoutMs?: number) => Promise<unknown>;
  waitOpen: () => Promise<unknown>;
};
/** Maximum time to wait for a spawned gateway to become reachable. */
export const READY_TIMEOUT_MS: 120000;
declare function defaultKillProcess(pid: unknown, signal: unknown): boolean;
declare function defaultRunTaskkill(
  command: string,
  args: string[],
  options: Record<string, unknown>,
): { error?: Error; status: number | null };
declare function defaultOpen(filePath: unknown, flags: unknown): Promise<fs.FileHandle>;
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
