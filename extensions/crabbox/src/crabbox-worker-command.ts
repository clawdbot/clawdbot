import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import {
  crabboxCommandError,
  permanentCrabboxCommandError,
} from "./crabbox-worker-command-error.js";
import { CRABBOX_LIFECYCLE_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

const MAX_OUTPUT_BYTES = 64 * 1024;

export type CrabboxCommandRunner = (
  argv: string[],
  options: {
    killProcessTree: boolean;
    maxOutputBytes: number;
    signal?: AbortSignal;
    timeoutMs: number;
  },
) => Promise<SpawnResult>;

export async function runCrabboxCommand(params: {
  action: string;
  args: string[];
  binary: string;
  runCommand: CrabboxCommandRunner;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<SpawnResult> {
  try {
    return await params.runCommand([params.binary, ...params.args], {
      timeoutMs: params.timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      killProcessTree: true,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch {
    throw new Error(`Crabbox ${params.action} could not start`);
  }
}

export function provisionProfileError(result: SpawnResult): WorkerProviderError | undefined {
  if (result.termination !== "exit") {
    return undefined;
  }
  const output = `${result.stderr}\n${result.stdout}`;
  if (
    /\bprovider=\S+\s+does not support fixed idempotent lease IDs\b/u.test(output) ||
    /(?:unknown|unrecognized) (?:flag|option)[^\r\n]*--lease-id/iu.test(output) ||
    /flag provided but not defined:\s*-lease-id/iu.test(output)
  ) {
    return new WorkerProviderError(
      "Crabbox 0.41.1 or newer with fixed lease ID support is required",
    );
  }
  if (
    /\blease_id_conflict\b/u.test(output) &&
    !/\bretry after provider inventory converges\b/iu.test(output)
  ) {
    return permanentCrabboxCommandError("warmup", result);
  }
  if (result.code !== 2) {
    return undefined;
  }
  if (/\bunknown provider\s+"[^"\r\n]+"/u.test(output)) {
    return new WorkerProviderError(
      "Crabbox profile provider is not supported by this Crabbox binary",
    );
  }
  if (/\bprovider=\S+\s+does not support warmup\b/u.test(output)) {
    return new WorkerProviderError("Crabbox profile provider does not support warmup");
  }
  if (
    /\bprovider=\S+.*\bdoes not support status\b/u.test(output) ||
    /\bprovider=\S+\s+does not expose persistent status\b/u.test(output)
  ) {
    return new WorkerProviderError("Crabbox profile provider does not support worker leases");
  }
  if (/\bprovider=\S+\s+is one-shot; use crabbox run\b/u.test(output)) {
    return new WorkerProviderError("Crabbox profile provider is run-only");
  }
  if (/\bprovider=\S+\s+requires module source; use crabbox run --script\b/u.test(output)) {
    return new WorkerProviderError("Crabbox profile provider requires a run script");
  }
  if (/--class is not supported for provider=\S+/u.test(output)) {
    return new WorkerProviderError("Crabbox profile class is not supported by its provider");
  }
  return undefined;
}

export function isAuthoritativeLeaseAbsence(result: SpawnResult, identifier: string): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  if (
    !output.includes(identifier) ||
    /\b(?:access\s+denied|authentication|authorization|credentials?|forbidden|permission|token|unauthorized)\b/iu.test(
      output,
    )
  ) {
    return false;
  }
  return (
    (result.code === 4 && /\b(?:was\s+)?not found\b/iu.test(output)) ||
    (result.code === 4 && /\bno longer exists\b/iu.test(output)) ||
    (result.code === 4 &&
      /\b(?:points to|is bound to) (?:a )?missing (?:instance|sandbox)\b/iu.test(output)) ||
    (result.code === 4 && /\bdisappeared before release\b/iu.test(output)) ||
    (result.code === 4 && /\bunknown blacksmith testbox(?:\s|:)/iu.test(output)) ||
    (result.code === 4 && /\bis not claimed by Crabbox\b/iu.test(output)) ||
    (result.code === 4 &&
      /\bwandb sandbox "[^"\r\n]+" has no matching local ownership claim\b/iu.test(output)) ||
    (result.code === 5 && /\bcoder workspace "[^"\r\n]+" not found\b/iu.test(output)) ||
    /\bcoordinator GET \S*\/v1\/leases\/\S+:\s*http 404\b/iu.test(output) ||
    (result.code === 4 && /\bunknown lease(?:\s|:)/iu.test(output))
  );
}

export async function stopCrabboxLease(params: {
  binary: string;
  id: string;
  provider: string;
  runCommand: CrabboxCommandRunner;
  timeoutMs?: number;
}): Promise<void> {
  const result = await runCrabboxCommand({
    action: "stop",
    args: ["stop", "--provider", params.provider, "--id", params.id],
    binary: params.binary,
    runCommand: params.runCommand,
    timeoutMs: params.timeoutMs ?? CRABBOX_LIFECYCLE_TIMEOUT_MS,
  });
  if (result.termination === "exit" && result.code === 0) {
    return;
  }
  const alreadyStopped =
    `${result.stderr}\n${result.stdout}`.includes(params.id) &&
    /\balready (?:destroyed|released|stopped|terminated)\b/iu.test(
      `${result.stderr}\n${result.stdout}`,
    );
  if (
    result.termination === "exit" &&
    (isAuthoritativeLeaseAbsence(result, params.id) || alreadyStopped)
  ) {
    return;
  }
  throw crabboxCommandError("stop", result);
}
