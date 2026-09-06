import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import { crabboxCommandError } from "./crabbox-worker-command-error.js";
import {
  isUnrecognizedLease,
  runCrabboxCommand,
  type CrabboxCommandRunner,
} from "./crabbox-worker-command.js";
import { withCrabboxWorkerEnvProfile } from "./crabbox-worker-env-profile.js";
import { parseInspectJson, type ParsedInspect } from "./crabbox-worker-inspect.js";
import type { parseCrabboxProfile } from "./crabbox-worker-profile.js";
import {
  CRABBOX_LIFECYCLE_TIMEOUT_MS,
  CRABBOX_MACHINE0_READY_WAIT_TIMEOUT,
  CRABBOX_SETUP_TIMEOUT_MS,
  resolveCrabboxLifecycleTimeoutMs,
  resolveCrabboxReadyPollIntervalMs,
} from "./crabbox-worker-timeouts.js";

export type LeaseCommandContext = { binary: string; id: string; provider: string };
export type InspectCommandResult =
  | { status: "found"; inspect: ParsedInspect }
  | { status: "unknown" };
type ProvisionInspectContext = Omit<LeaseCommandContext, "id"> & {
  deadline: number;
  inspect: ParsedInspect;
  profile: ReturnType<typeof parseCrabboxProfile>;
  runCommand: CrabboxCommandRunner;
  stopLease: (context: LeaseCommandContext) => Promise<void>;
  signal?: AbortSignal;
};

// Crabbox states describe lease usability, not proven cleanup: released leases can retain
// resources, and Machine0 maps both DELETING and DELETED to `deleted`. Always stop explicitly.
const NON_RUNNABLE_STATES = new Set([
  "archived",
  "deleted",
  "deleting",
  "destroyed",
  "expired",
  "failed",
  "missing",
  "released",
  "stopped",
  "stopped_with_code",
  "terminated",
]);

export async function inspectWithContext(params: {
  context: Omit<LeaseCommandContext, "id">;
  expectedLeaseId?: string;
  id: string;
  runCommand: CrabboxCommandRunner;
  timeoutMs?: number;
  waitForReady?: boolean;
  signal?: AbortSignal;
}): Promise<InspectCommandResult> {
  const action = params.waitForReady ? "status" : "inspect";
  const result = await runCrabboxCommand({
    action,
    args: [
      action,
      "--provider",
      params.context.provider,
      "--network",
      "public",
      "--id",
      params.id,
      ...(params.waitForReady
        ? ["--wait", "--wait-timeout", CRABBOX_MACHINE0_READY_WAIT_TIMEOUT]
        : []),
      "--json",
    ],
    binary: params.context.binary,
    runCommand: params.runCommand,
    signal: params.signal,
    timeoutMs: params.timeoutMs ?? resolveCrabboxLifecycleTimeoutMs(params.context.provider),
  });
  if (result.termination === "exit" && result.code === 0) {
    // A successful but malformed response cannot attest the fixed lease. Provision callers
    // must preserve cleanup uncertainty so Gateway replay can inspect the lease later.
    let inspect: ParsedInspect;
    try {
      inspect = parseInspectJson(result.stdout);
    } catch (error) {
      throw new WorkerProviderError(
        error instanceof Error ? error.message : "Crabbox inspect returned invalid output",
      );
    }
    if (params.expectedLeaseId && inspect.id !== params.expectedLeaseId) {
      throw new WorkerProviderError("Crabbox inspect returned a different lease id");
    }
    return { status: "found", inspect };
  }
  if (result.termination === "exit" && isUnrecognizedLease(result, params.id)) {
    return { status: "unknown" };
  }
  throw crabboxCommandError(action, result);
}

export function remainingProvisionTimeout(deadline: number, maximum: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("Crabbox provision exceeded its provider deadline");
  }
  return Math.min(maximum, remaining);
}

export const isNonRunnableState = (state: string) => NON_RUNNABLE_STATES.has(state.toLowerCase());

export function leaseRunArgs(
  context: LeaseCommandContext,
  forwardedEnvNames: readonly string[] = [],
  envProfilePath?: string,
): string[] {
  return [
    "run",
    "--provider",
    context.provider,
    "--network",
    "public",
    "--tailscale=false",
    "--id",
    context.id,
    "--keep=true",
    // Workspace transfer is owned by the worker tunnel; lease scripts must not
    // rsync the gateway checkout into the box just to execute setup or diagnostics.
    "--no-sync",
    ...forwardedEnvNames.flatMap((name) => ["--allow-env", name]),
    ...(envProfilePath ? ["--env-from-profile", envProfilePath] : []),
    "--script-stdin",
  ];
}

function assertProvisionSecurityPolicy(params: { inspect: ParsedInspect; provider: string }): void {
  if (params.inspect.tailscaleEnabled) {
    throw new WorkerProviderError("Crabbox cloud worker lease must not have Tailscale enabled");
  }
  const attached = params.inspect.awsInstanceProfileAttached;
  const pending = !params.inspect.ready && !isNonRunnableState(params.inspect.state);
  if (params.provider === "aws" && attached !== false && (attached || !pending)) {
    throw new WorkerProviderError(
      "Crabbox AWS inspect must attest that no instance profile is attached",
    );
  }
}

export async function waitForProvisionReady(
  params: ProvisionInspectContext & {
    refresh?: boolean;
    sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<ParsedInspect> {
  let inspect = params.inspect;
  const inspectAgain = async (): Promise<ParsedInspect> => {
    params.signal?.throwIfAborted();
    const replay = await inspectWithContext({
      context: { binary: params.binary, provider: params.provider },
      expectedLeaseId: inspect.id,
      id: inspect.id,
      runCommand: params.runCommand,
      signal: params.signal,
      timeoutMs: remainingProvisionTimeout(
        params.deadline,
        resolveCrabboxLifecycleTimeoutMs(params.provider),
      ),
      waitForReady: params.provider === "machine0",
    });
    if (replay.status === "unknown") {
      throw new Error("Crabbox operation lease disappeared while waiting for SSH readiness");
    }
    params.signal?.throwIfAborted();
    return replay.inspect;
  };
  try {
    inspect = params.refresh ? await inspectAgain() : params.inspect;
    params.signal?.throwIfAborted();
    // Reject forbidden state immediately; omitted AWS metadata is pending only until ready.
    assertProvisionSecurityPolicy({ inspect, provider: params.provider });
    while (inspect.ready !== true && !isNonRunnableState(inspect.state)) {
      params.signal?.throwIfAborted();
      const remaining = remainingProvisionTimeout(params.deadline, CRABBOX_LIFECYCLE_TIMEOUT_MS);
      await params.sleep(
        Math.min(resolveCrabboxReadyPollIntervalMs(params.provider), remaining),
        params.signal,
      );
      params.signal?.throwIfAborted();
      inspect = await inspectAgain();
      assertProvisionSecurityPolicy({ inspect, provider: params.provider });
    }
    if (isNonRunnableState(inspect.state)) {
      throw new WorkerProviderError(
        "Crabbox operation lease entered a terminal state while waiting for SSH",
      );
    }
    return inspect;
  } catch (error) {
    params.signal?.throwIfAborted();
    if (error instanceof WorkerProviderError) {
      return await failProvisionAfterCleanup({ ...params, id: inspect.id }, error);
    }
    throw error;
  }
}

// Setup runs on every provision attempt (including replay adoption), so commands
// must be idempotent. A failed setup stops the lease before surfacing the error;
// otherwise the caller cannot release a box it never learned about.
export async function runProvisionSetup(
  params: ProvisionInspectContext & {
    phase: string;
    setup: string;
    timeoutMs?: number;
    forwardedEnv?: Record<string, string>;
  },
): Promise<void> {
  try {
    const result = await withCrabboxWorkerEnvProfile(
      params.forwardedEnv,
      (names, profilePath, childEnv) =>
        runCrabboxCommand({
          action: params.phase,
          args: leaseRunArgs({ ...params, id: params.inspect.id }, names, profilePath),
          binary: params.binary,
          env: childEnv,
          input: params.setup,
          runCommand: params.runCommand,
          signal: params.signal,
          timeoutMs: remainingProvisionTimeout(
            params.deadline,
            params.timeoutMs ?? CRABBOX_SETUP_TIMEOUT_MS,
          ),
        }),
    );
    if (result.termination !== "exit" || result.code !== 0) {
      throw new WorkerProviderError(crabboxCommandError(params.phase, result).message);
    }
  } catch (error) {
    params.signal?.throwIfAborted();
    return await failProvisionAfterCleanup({ ...params, id: params.inspect.id }, error);
  }
  params.signal?.throwIfAborted();
}

export async function runProvisionSetupAndWaitReady(
  params: Parameters<typeof runProvisionSetup>[0] & {
    sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<ParsedInspect> {
  await runProvisionSetup(params);
  // Setup may restart SSH or change its endpoint. Re-read the authoritative lease before
  // returning any endpoint or security attestation to core bootstrap.
  return await waitForProvisionReady({ ...params, refresh: true });
}

export async function failProvisionAfterCleanup(
  params: LeaseCommandContext & { stopLease: (context: LeaseCommandContext) => Promise<void> },
  provisionError: unknown,
): Promise<never> {
  try {
    await params.stopLease(params);
  } catch (cleanupError) {
    throw WorkerProviderError.cleanupIndeterminate(params.id, provisionError, cleanupError);
  }
  throw provisionError;
}
