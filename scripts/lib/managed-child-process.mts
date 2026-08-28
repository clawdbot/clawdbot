// Runs child commands with process-group signal forwarding and Windows shell normalization.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import { constants as osConstants } from "node:os";
import { Writable } from "node:stream";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "../windows-cmd-helpers.mjs";
import { resolveWindowsTaskkillPath } from "./windows-taskkill.mjs";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] satisfies NodeJS.Signals[];
const FORCE_KILL_DELAY_MS = 5_000;
const PROCESS_GROUP_DRAIN_TIMEOUT_MS = 5_000;
const PROCESS_GROUP_POLL_MS = 25;
const TASKKILL_TIMEOUT_MS = 10_000;
type ProcessTreeState = "indeterminate" | "live" | "signaled" | "terminated";
type ManagedChildTermination = { processTreeState: Exclude<ProcessTreeState, "live"> };
type ManagedProcessGroupErrorPolicy = "alive-on-eperm" | "indeterminate" | "verify-leader";
type ManagedProcessGroupChild = {
  exitCode?: number | null;
  pid?: number;
  signalCode?: string | null;
};
type ManagedProcessGroupOptions = {
  errorPolicy: ManagedProcessGroupErrorPolicy;
  inspectLeaderWhenNoGroup?: boolean;
  platform?: NodeJS.Platform;
  useProcessGroup?: boolean;
};
type TaskkillRunner = (
  command: string,
  args: string[],
  options: { killSignal?: NodeJS.Signals; stdio?: StdioOptions; timeout?: number },
) => { error?: Error; status: number | null } | undefined;
type ManagedChildTerminationOptions = {
  onChildSignalError?: (error: unknown) => void;
  onProcessGroupSignalError?: (error: unknown) => void;
  platform?: NodeJS.Platform;
  processGroupFallback?: "always" | "never" | "nonmissing";
  runTaskkill?: TaskkillRunner;
  taskkillTimeoutMs?: number | null;
  useProcessGroup?: boolean;
  useWindowsTaskkill?: boolean;
};

type ManagedCommandOptions = {
  bin: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  shell?: boolean;
  windowsVerbatimArguments?: boolean;
  platform?: NodeJS.Platform;
  comSpec?: string;
};

type RunManagedCommandOptions = ManagedCommandOptions & {
  timeoutMs?: number;
  requireProcessTreeExit?: boolean;
  runTaskkill?: TaskkillRunner;
  onReady?: (child: ChildProcess) => void;
  signal?: AbortSignal;
  abortKillGraceMs?: number;
  onSignal?: (signal: NodeJS.Signals) => void;
};

type ManagedCommandOutcome =
  | { type: "completed"; status: number }
  | { type: "failed"; error: unknown }
  | { type: "timeout" }
  | { type: "aborted" }
  | { type: "signal"; signal: NodeJS.Signals };

const managedChildren = new Set<(signal: NodeJS.Signals) => void>();
const signalHandlers = new Map<NodeJS.Signals, () => void>();

/** Return the conventional shell exit code for a signal. */
export function signalExitCode(signal: NodeJS.Signals) {
  const signalNumber = signalNumberFor(signal);
  return signalNumber ? 128 + signalNumber : 1;
}

export function terminateManagedChild(
  child: { kill(signal: NodeJS.Signals): unknown; pid?: number },
  signal: NodeJS.Signals = "SIGTERM",
  {
    onChildSignalError,
    onProcessGroupSignalError,
    platform = process.platform,
    processGroupFallback = "always",
    runTaskkill = spawnSync,
    taskkillTimeoutMs = TASKKILL_TIMEOUT_MS,
    useProcessGroup = platform !== "win32",
    useWindowsTaskkill = true,
  }: ManagedChildTerminationOptions = {},
): ManagedChildTermination | undefined {
  if (!child.pid) {
    try {
      const delivered = child.kill(signal);
      if (platform !== "win32") {
        return { processTreeState: delivered === false ? "terminated" : "signaled" };
      }
    } catch (error) {
      onChildSignalError?.(error);
      // A child that never acquired a PID may already have failed to spawn.
    }
    return platform === "win32" ? { processTreeState: "indeterminate" } : undefined;
  }

  try {
    if (platform !== "win32" && useProcessGroup) {
      process.kill(-child.pid, signal);
      return { processTreeState: "signaled" };
    }
  } catch (error) {
    const processGroupIsMissing = isMissingProcessError(error);
    if (!processGroupIsMissing) {
      onProcessGroupSignalError?.(error);
    }
    if (
      processGroupFallback === "never" ||
      (processGroupFallback === "nonmissing" && processGroupIsMissing)
    ) {
      return processGroupIsMissing ? { processTreeState: "terminated" } : undefined;
    }
  }

  if (platform !== "win32" || !useWindowsTaskkill) {
    try {
      const delivered = child.kill(signal);
      return { processTreeState: delivered === false ? "terminated" : "signaled" };
    } catch (error) {
      onChildSignalError?.(error);
      return isMissingProcessError(error) ? { processTreeState: "terminated" } : undefined;
    }
  }

  const taskkillPath = resolveWindowsTaskkillPath();
  const args = ["/PID", String(child.pid), "/T"];
  if (signal === "SIGKILL") {
    args.push("/F");
  }
  const taskkillOptions: Parameters<TaskkillRunner>[2] =
    taskkillTimeoutMs === null
      ? { stdio: "ignore" }
      : { killSignal: "SIGKILL", stdio: "ignore", timeout: taskkillTimeoutMs };
  const result = runTaskkill(taskkillPath, args, taskkillOptions);
  if (!result?.error && result?.status === 0) {
    return { processTreeState: "terminated" };
  }
  if (signal !== "SIGKILL") {
    const forceResult = runTaskkill(taskkillPath, [...args, "/F"], taskkillOptions);
    if (!forceResult?.error && forceResult?.status === 0) {
      return { processTreeState: "terminated" };
    }
  }
  try {
    child.kill(signal);
  } catch (error) {
    onChildSignalError?.(error);
    // The leader may already be gone, but failed taskkill leaves descendants unverified.
  }
  return { processTreeState: "indeterminate" };
}

export function inspectManagedProcessGroup(
  child: ManagedProcessGroupChild,
  {
    errorPolicy,
    inspectLeaderWhenNoGroup = false,
    platform = process.platform,
    useProcessGroup = platform !== "win32",
  }: ManagedProcessGroupOptions,
): "dead" | "indeterminate" | "live" {
  if (!useProcessGroup) {
    return inspectLeaderWhenNoGroup &&
      child.pid &&
      child.exitCode === null &&
      child.signalCode === null
      ? "live"
      : "dead";
  }
  const { pid } = child;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1 || pid > 0x7fffffff) {
    return "indeterminate";
  }
  try {
    process.kill(-pid, 0);
    return "live";
  } catch (error) {
    if (isMissingProcessError(error)) {
      return "dead";
    }
    if (errorPolicy === "indeterminate") {
      return "indeterminate";
    }
    if (!hasProcessErrorCode(error, "EPERM")) {
      return "dead";
    }
    if (errorPolicy === "alive-on-eperm") {
      return "live";
    }
    if (child.exitCode != null || child.signalCode != null) {
      return "dead";
    }
    try {
      process.kill(pid, 0);
      return "live";
    } catch {
      return "dead";
    }
  }
}

export async function waitForManagedProcessGroupExit(
  child: ManagedProcessGroupChild,
  timeoutMs: number,
  {
    clampPollToDeadline = false,
    pollIntervalMs = PROCESS_GROUP_POLL_MS,
    ...groupOptions
  }: ManagedProcessGroupOptions & {
    clampPollToDeadline?: boolean;
    pollIntervalMs?: number;
  },
): Promise<boolean> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (inspectManagedProcessGroup(child, groupOptions) !== "live") {
      return true;
    }
    const waitMs = clampPollToDeadline
      ? Math.min(pollIntervalMs, deadlineAt - Date.now())
      : pollIntervalMs;
    await new Promise((resolve) => {
      setTimeout(resolve, waitMs);
    });
  }
  return inspectManagedProcessGroup(child, groupOptions) !== "live";
}

/** Run a child command while forwarding termination signals to its process group. */
export async function runManagedCommand({
  bin,
  args = [],
  cwd,
  env,
  stdio = "inherit",
  platform = process.platform,
  shell = platform === "win32",
  windowsVerbatimArguments,
  comSpec,
  timeoutMs,
  requireProcessTreeExit = false,
  runTaskkill = spawnSync,
  onReady,
  signal,
  abortKillGraceMs,
  onSignal,
}: RunManagedCommandOptions) {
  if (platform === "win32" && requireProcessTreeExit) {
    throw createManagedCommandUnsupportedTreeVerificationError();
  }
  signal?.throwIfAborted();
  const managedStdio: StdioOptions =
    stdio === "inherit"
      ? ["inherit", "inherit", "inherit"]
      : Array.isArray(stdio)
        ? [...stdio]
        : stdio;
  // Non-TTY inherited output must remain observable when a nested detached
  // wrapper outlives its leader. Preserve terminal descriptors and stream bytes.
  const forwardedOutputs = [process.stdout, process.stderr].map((target, index) => {
    if (
      platform !== "win32" &&
      !target.isTTY &&
      Array.isArray(managedStdio) &&
      managedStdio[index + 1] === "inherit"
    ) {
      managedStdio[index + 1] = "pipe";
      return target;
    }
    return undefined;
  });
  const spawnSpec = createManagedCommandSpawnSpec({
    bin,
    args,
    cwd,
    env,
    stdio: managedStdio,
    shell,
    windowsVerbatimArguments,
    platform,
    comSpec,
  });
  // Register before spawn: a child can become ready before spawn returns.
  installSignalHandlers();
  let child: ChildProcess;
  try {
    child = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
  } catch (error) {
    removeSignalHandlersIfIdle();
    throw error;
  }
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let cancellation: Promise<ManagedCommandOutcome> | undefined;
  let resolveCancellation!: (outcome: ManagedCommandOutcome) => void;
  const canceled = new Promise<ManagedCommandOutcome>((resolve) => {
    resolveCancellation = resolve;
  });
  const stop = (
    outcome: ManagedCommandOutcome,
    stopSignal: NodeJS.Signals,
    forceKillDelayMs?: number,
  ) => {
    if (cancellation) {
      return cancellation;
    }
    clearTimeout(timeoutTimer);
    cancellation = terminateManagedChildAndWait(child, stopSignal, {
      platform,
      runTaskkill,
      forceKillDelayMs,
    }).then(
      () => outcome,
      (error: unknown) => ({ type: "failed" as const, error }),
    );
    void cancellation.then(resolveCancellation);
    return cancellation;
  };
  const forwardSignal = (received: NodeJS.Signals) => {
    onSignal?.(received);
    void stop({ type: "signal", signal: received }, received);
  };
  const abort = () => {
    void stop({ type: "aborted" }, "SIGTERM", abortKillGraceMs);
  };
  managedChildren.add(forwardSignal);
  try {
    const completion = new Promise<ManagedCommandOutcome>((resolve) => {
      child.once("error", (error) => {
        clearTimeout(timeoutTimer);
        resolve({ type: "failed", error });
      });
      child.once("close", (status, received) => {
        clearTimeout(timeoutTimer);
        resolve({
          type: "completed",
          status: received ? signalExitCode(received) : (status ?? 1),
        });
      });
    });
    if (timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        void stop({ type: "timeout" }, "SIGTERM");
      }, timeoutMs);
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    try {
      for (const [index, target] of forwardedOutputs.entries()) {
        if (target) {
          const output = index === 0 ? child.stdout : child.stderr;
          // Each child owns its pipe listeners; shared stdout/stderr only receive
          // writes. The callback carries target completion and backpressure.
          output!.pipe(
            new Writable({
              write(chunk, encoding, callback) {
                target.write(chunk, encoding, callback);
              },
            }),
          );
        }
      }
      onReady?.(child);
    } catch (error) {
      const cleanup = await stop({ type: "failed", error }, "SIGTERM");
      if (cleanup.type === "failed" && cleanup.error !== error) {
        throw createManagedCommandSetupCleanupError(error, cleanup.error);
      }
      throw error;
    }
    let outcome = await Promise.race([completion, canceled]);
    // A leader's close can race cleanup of its group or inherited output pipes.
    if (cancellation) {
      outcome = await cancellation;
    }
    if (outcome.type === "failed") {
      throw outcome.error;
    }
    if (outcome.type === "timeout") {
      throw createManagedCommandTimeoutError(timeoutMs);
    }
    if (outcome.type === "aborted") {
      throw Object.assign(new Error("Managed command aborted"), { code: "ABORT_ERR" });
    }
    if (outcome.type === "signal") {
      return signalExitCode(outcome.signal);
    }
    if (requireProcessTreeExit) {
      await ensureManagedProcessTreeExit(child, platform);
    }
    return outcome.status;
  } finally {
    clearTimeout(timeoutTimer);
    signal?.removeEventListener("abort", abort);
    managedChildren.delete(forwardSignal);
    removeSignalHandlersIfIdle();
  }
}

async function terminateManagedChildAndWait(
  child: ChildProcess,
  signal: NodeJS.Signals,
  {
    platform,
    runTaskkill,
    forceKillDelayMs = FORCE_KILL_DELAY_MS,
  }: {
    platform: NodeJS.Platform;
    runTaskkill: TaskkillRunner;
    forceKillDelayMs?: number;
  },
) {
  // Nested wrappers own detached groups. Let them forward the signal before
  // killing their leader, then join inherited pipes as well as our own group.
  const termination = terminateManagedChild(child, signal, { platform, runTaskkill });
  if (platform === "win32" && termination?.processTreeState !== "terminated") {
    throw createManagedCommandCleanupError(
      "Windows taskkill could not verify managed process tree exit",
      child,
      platform,
      "indeterminate",
    );
  }
  const forceAt = Date.now() + forceKillDelayMs;
  const deadline = forceAt + PROCESS_GROUP_DRAIN_TIMEOUT_MS;
  let forced = platform === "win32";
  let groupState: "dead" | "indeterminate" | "live" = "indeterminate";
  while (true) {
    groupState =
      platform === "win32"
        ? "dead"
        : inspectManagedProcessGroup(child, { errorPolicy: "indeterminate", platform });
    const exited = child.exitCode !== null || child.signalCode !== null;
    const pipesClosed = [child.stdout, child.stderr].every((pipe) => !pipe || pipe.closed);
    if (groupState === "dead" && exited && pipesClosed) {
      return;
    }
    const now = Date.now();
    if (!forced && now >= forceAt) {
      forced = true;
      if (groupState !== "dead") {
        terminateManagedChild(child, "SIGKILL", { platform, runTaskkill });
      }
    }
    if (now >= deadline) {
      break;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(PROCESS_GROUP_POLL_MS, deadline - now));
    });
  }
  // Stop owning pipe handles only after recording failure; never disguise an
  // escaped descendant holding stdio as a successfully cleaned timeout.
  child.stdout?.destroy();
  child.stderr?.destroy();
  throw createManagedCommandCleanupError(
    "Managed command cleanup could not verify child, process group, and output closure",
    child,
    platform,
    groupState === "live" ? "live" : "indeterminate",
  );
}

function createManagedCommandTimeoutError(timeoutMs: number | undefined) {
  return Object.assign(new Error(`Managed command timed out after ${timeoutMs}ms`), {
    code: "ETIMEDOUT",
  });
}

function createManagedCommandUnsupportedTreeVerificationError() {
  return Object.assign(
    new Error("Strict managed process-tree verification is not supported on Windows"),
    {
      code: "EPROCESS_TREE_VERIFICATION_UNSUPPORTED",
    },
  );
}

function createManagedCommandSetupCleanupError(error: unknown, cleanupError: unknown) {
  return new AggregateError(
    [error, cleanupError],
    "Managed command setup failed and its process tree could not be cleaned up",
    { cause: cleanupError },
  );
}

async function ensureManagedProcessTreeExit(child: ChildProcess, platform: NodeJS.Platform) {
  const initialStatus = inspectManagedProcessGroup(child, {
    errorPolicy: "indeterminate",
    platform,
  });
  if (initialStatus === "dead") {
    return;
  }
  let status: ReturnType<typeof inspectManagedProcessGroup> = initialStatus;
  // A missing group at signal time supersedes the earlier racy liveness probe.
  const termination = terminateManagedChild(child, "SIGKILL", { platform });
  const deadline = Date.now() + PROCESS_GROUP_DRAIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, PROCESS_GROUP_POLL_MS);
    });
    status = inspectManagedProcessGroup(child, { errorPolicy: "indeterminate", platform });
    if (status === "dead") {
      if (termination?.processTreeState !== "terminated") {
        throw createManagedCommandCleanupError(
          "Managed command exited while its process group remained active",
          child,
          platform,
          "terminated",
        );
      }
      return;
    }
  }
  const processTreeState = status === "indeterminate" ? "indeterminate" : "live";
  throw createManagedCommandCleanupError(
    processTreeState === "indeterminate"
      ? `Managed process-group state remained indeterminate for ${PROCESS_GROUP_DRAIN_TIMEOUT_MS}ms`
      : `Managed process group did not exit within ${PROCESS_GROUP_DRAIN_TIMEOUT_MS}ms`,
    child,
    platform,
    processTreeState,
  );
}

function createManagedCommandCleanupError(
  message: string,
  child: ChildProcess,
  platform: NodeJS.Platform,
  processTreeState: ProcessTreeState,
) {
  const processGroupId =
    platform !== "win32" &&
    child.pid !== undefined &&
    Number.isSafeInteger(child.pid) &&
    child.pid > 1
      ? child.pid
      : undefined;
  return Object.assign(new Error(message), {
    code: "EPROCESSGROUP_CLEANUP_FAILED",
    ...(platform === "win32" ? { manualRecoveryRequired: true } : {}),
    ...(processGroupId === undefined ? {} : { processGroupId }),
    processTreeState,
  });
}

function installSignalHandlers() {
  for (const signal of FORWARDED_SIGNALS) {
    if (signalHandlers.has(signal)) {
      continue;
    }
    const handler = () => forwardSignalToManagedChildren(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function removeSignalHandlersIfIdle() {
  if (managedChildren.size > 0) {
    return;
  }
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
  signalHandlers.clear();
}

function forwardSignalToManagedChildren(signal: NodeJS.Signals) {
  for (const forward of managedChildren) {
    forward(signal);
  }
}

export function createManagedCommandSpawnSpec({
  bin,
  args = [],
  cwd,
  env,
  stdio = "inherit",
  platform = process.platform,
  shell = platform === "win32",
  windowsVerbatimArguments,
  comSpec,
}: ManagedCommandOptions) {
  const invocation = createManagedCommandInvocation({
    bin,
    args,
    env,
    shell,
    windowsVerbatimArguments,
    platform,
    comSpec,
  });

  return {
    args: invocation.args,
    command: invocation.command,
    options: {
      cwd,
      env,
      stdio,
      shell: invocation.shell,
      detached: platform !== "win32",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    },
  };
}

export function createManagedCommandInvocation({
  bin,
  args = [],
  env,
  platform = process.platform,
  shell = platform === "win32",
  windowsVerbatimArguments,
  comSpec,
}: ManagedCommandOptions) {
  if (platform === "win32" && shell && args.length > 0) {
    return {
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(bin, args)],
      command: comSpec ?? resolveWindowsCmdExePath(env ?? process.env),
      shell: false,
      windowsVerbatimArguments: true,
    };
  }

  return {
    args,
    command: bin,
    shell,
    windowsVerbatimArguments,
  };
}

function signalNumberFor(signal: NodeJS.Signals) {
  switch (signal) {
    case "SIGHUP":
      return 1;
    case "SIGINT":
      return 2;
    case "SIGTERM":
      return 15;
    default:
      return osConstants.signals?.[signal] ?? 0;
  }
}

function isMissingProcessError(error: unknown) {
  return hasProcessErrorCode(error, "ESRCH");
}

function hasProcessErrorCode(error: unknown, code: string) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
