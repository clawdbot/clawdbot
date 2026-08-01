#!/usr/bin/env node
/**
 * Parses a safe non-negative integer option.
 */
export function readNumber(value: unknown, label: unknown): number;
/**
 * Parses a safe positive integer option.
 */
export function readPositiveNumber(value: unknown, label: unknown): number;
/**
 * Parses memory FD repro CLI arguments and environment fallbacks.
 */
export function parseArgs(argv: string[]): {
  fileCount: number;
  mode: "fixed" | "leak" | "report";
  maxWorkspaceRegFds: number;
  minLeakedFds: number;
  invokeTimeoutMs: number;
  sampleDelayMs: number;
  settleDelayMs: number;
  outputDir: string;
  keep: boolean;
  allowNonDarwin: boolean;
};
/**
 * Writes isolated OpenClaw config for the synthetic memory workspace.
 */
export function writeConfig({
  homeDir,
  workspaceDir,
  port,
  token,
}: {
  homeDir: unknown;
  workspaceDir: unknown;
  port: unknown;
  token: unknown;
}): string;
/**
 * Updates bounded gateway-ready output state from a stdout/stderr chunk.
 */
export function updateGatewayReadyOutputState(
  state: unknown,
  chunk: unknown,
  maxChars?: number,
): {
  tail: string;
  readySeen: boolean;
};
/**
 * Reports whether a spawned child has already exited.
 */
export function hasChildExited(child: unknown): boolean;
/**
 * Waits until gateway output and listener state both indicate readiness.
 */
export function waitForGatewayReady({
  child,
  port,
  logPath,
  timeoutMs,
}: {
  child: unknown;
  port: unknown;
  logPath: unknown;
  timeoutMs: unknown;
}): Promise<void>;
/**
 * Stops the gateway child using the default process/runtime hooks.
 */
export function stopGateway({ child, port }: { child: unknown; port: unknown }): Promise<void>;
/**
 * Stops the gateway child and unknown remaining listener process.
 */
export function stopGatewayWithRuntime({
  child,
  childExitPollIntervalMs,
  childExitPolls,
  port,
  findGatewayPidFn,
  killProcess,
  listenerSettleDelayMs,
}: {
  child: unknown;
  childExitPollIntervalMs?: number | undefined;
  childExitPolls?: number | undefined;
  port: unknown;
  findGatewayPidFn: unknown;
  killProcess: unknown;
  listenerSettleDelayMs?: number | undefined;
}): Promise<void>;
/**
 * Classifies the memory_search HTTP response into success/error details.
 */
export function classifyMemorySearchInvokeResponse({
  httpOk,
  status,
  bodyText,
}: {
  httpOk: unknown;
  status: unknown;
  bodyText: unknown;
}):
  | {
      ok: boolean;
      httpOk: unknown;
      status: unknown;
      gatewayOk: boolean | undefined;
      error: string;
    }
  | {
      ok: boolean;
      httpOk: unknown;
      status: unknown;
      error: string;
      gatewayOk?: undefined;
    }
  | {
      error?: string | undefined;
      toolError?: string | undefined;
      ok: boolean;
      httpOk: unknown;
      status: unknown;
      gatewayOk: boolean | undefined;
      resultCount: unknown;
      toolDisabled: boolean;
      toolUnavailable: boolean;
    };
export function invokeMemorySearch({
  port,
  token,
  timeoutMs,
}: {
  port: unknown;
  token: unknown;
  timeoutMs: unknown;
}): Promise<
  | {
      durationMs: number;
      bodyPreview: string;
      ok: boolean;
      httpOk: unknown;
      status: unknown;
      gatewayOk: boolean | undefined;
      error: string;
      aborted?: undefined;
    }
  | {
      durationMs: number;
      bodyPreview: string;
      ok: boolean;
      httpOk: unknown;
      status: unknown;
      error: string;
      gatewayOk?: undefined;
      aborted?: undefined;
    }
  | {
      durationMs: number;
      bodyPreview: string;
      error?: string | undefined;
      toolError?: string | undefined;
      ok: boolean;
      httpOk: unknown;
      status: unknown;
      gatewayOk: boolean | undefined;
      resultCount: unknown;
      toolDisabled: boolean;
      toolUnavailable: boolean;
      aborted?: undefined;
    }
  | {
      ok: boolean;
      aborted: boolean;
      durationMs: number;
      error: string;
    }
>;
/**
 * Maximum gateway-ready output tail retained while waiting for startup.
 */
export const GATEWAY_READY_OUTPUT_MAX_CHARS: number;
/**
 * Maximum bytes read from the memory_search HTTP response.
 */
export const MEMORY_SEARCH_RESPONSE_MAX_BYTES: number;
/**
 * Probe query expected to hit the synthetic top-level memory file.
 */
export const MEMORY_SEARCH_PROBE_QUERY: "Top-level memory file";
export { readBoundedResponseText };
import { readBoundedResponseText } from "./lib/bounded-response.mjs";
