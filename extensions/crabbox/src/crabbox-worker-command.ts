import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { crabboxCommandError } from "./crabbox-worker-command-error.js";
import { CRABBOX_STOP_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

const MAX_OUTPUT_BYTES = 64 * 1024;

export type CrabboxCommandRunner = (
  argv: string[],
  options: {
    killProcessTree: boolean;
    env?: NodeJS.ProcessEnv;
    input?: string | Uint8Array;
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
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<SpawnResult> {
  params.signal?.throwIfAborted();
  let result: SpawnResult;
  try {
    result = await params.runCommand([params.binary, ...params.args], {
      timeoutMs: params.timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      killProcessTree: true,
      ...(params.env === undefined ? {} : { env: params.env }),
      ...(params.input === undefined ? {} : { input: params.input }),
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch {
    params.signal?.throwIfAborted();
    throw new Error(`Crabbox ${params.action} could not start`);
  }
  // The runner owns child/tree settlement; cancellation must not release that custody early.
  params.signal?.throwIfAborted();
  return result;
}

const CREDENTIAL_FAILURE_PATTERN =
  /\b(?:access\s+denied|authentication|authorization|credentials?|forbidden|permission|token|unauthorized)\b/iu;
// `crabbox stop` exits 4 with this line when the lease record itself is gone (#137025).
const LEASE_NOT_FOUND_PATTERN = /\blease(?:\/[a-z0-9_-]+)? not found:\s*(\S+)/iu;

// Recognition failure does not prove resource absence; only the stop owner can confirm cleanup.
export function isUnrecognizedLease(result: SpawnResult, identifier: string): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  if (!output.includes(identifier) || CREDENTIAL_FAILURE_PATTERN.test(output)) {
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

// Stop success needs exit 4 naming this lease as not found. The inspect classifier above is
// wider on purpose: missing local claims, coordinator 404 warnings and exit 5 retries do not
// prove the release finished (docs/gateway/cloud-workers.md, "Failed teardown stays retryable").
function isLeaseConfirmedAbsent(result: SpawnResult, identifier: string): boolean {
  if (result.code !== 4) {
    return false;
  }
  const output = `${result.stderr}\n${result.stdout}`;
  if (CREDENTIAL_FAILURE_PATTERN.test(output)) {
    return false;
  }
  return LEASE_NOT_FOUND_PATTERN.exec(output)?.[1] === identifier;
}

export async function stopCrabboxLease(params: {
  binary: string;
  id: string;
  provider: string;
  runCommand: CrabboxCommandRunner;
}): Promise<void> {
  const result = await runCrabboxCommand({
    action: "stop",
    args: ["stop", "--provider", params.provider, "--id", params.id],
    binary: params.binary,
    runCommand: params.runCommand,
    timeoutMs: CRABBOX_STOP_TIMEOUT_MS,
  });
  if (result.termination === "exit" && result.code === 0) {
    return;
  }
  if (result.termination === "exit" && isLeaseConfirmedAbsent(result, params.id)) {
    return;
  }
  throw crabboxCommandError("stop", result);
}
