import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { crabboxCommandError } from "./crabbox-worker-command-error.js";
import { CRABBOX_LIFECYCLE_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

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
  try {
    return await params.runCommand([params.binary, ...params.args], {
      timeoutMs: params.timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      killProcessTree: true,
      ...(params.env === undefined ? {} : { env: params.env }),
      ...(params.input === undefined ? {} : { input: params.input }),
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch {
    throw new Error(`Crabbox ${params.action} could not start`);
  }
}

// Recognition failure does not prove resource absence; only the stop owner can confirm cleanup.
export function isUnrecognizedLease(result: SpawnResult, identifier: string): boolean {
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
  throw crabboxCommandError("stop", result);
}
