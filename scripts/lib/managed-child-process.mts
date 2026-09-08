// Runs child commands with process-group signal forwarding and Windows shell normalization.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import { constants as osConstants, tmpdir } from "node:os";
import { Writable } from "node:stream";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "../windows-cmd-helpers.mjs";
import { findVitestResourceOwner } from "./vitest-resource-ownership.mts";
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
  timeoutKillGraceMs?: number;
  timeoutForceKillOnLeaderExit?: boolean;
  requireProcessTreeExit?: boolean;
  runTaskkill?: TaskkillRunner;
  onReady?: (child: ChildProcess) => void;
  signal?: AbortSignal;
  abortKillGraceMs?: number;
  onSignal?: (signal: NodeJS.Signals) => void;
};

type ManagedCommandOutcome =
  | { type: "completed"; exit: number | NodeJS.Signals }
  | { type: "failed"; error: unknown }
  | { type: "timeout" }
  | { type: "aborted" }
  | { type: "signal"; signal: NodeJS.Signals };

const managedChildren = new Set<(signal: NodeJS.Signals) => void>();
const signalHandlers = new Map<NodeJS.Signals, () => void>();

/** Nested command failures retain their owner's inputs until process cleanup is verified. */
export function hasUnjoinedWork(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  for (const current of pending) {
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    // Native execFileSync errors can point .error back to themselves. Skip only
    // that identity; other aggregate members and wrapper edges still need checking.
    seen.add(current);
    if ("processTreeState" in current && current.processTreeState !== "terminated") {
      return true;
    }
    if (current instanceof AggregateError) {
      for (const error of current.errors) {
        pending.push(error);
      }
    }
    if ("cause" in current) {
      pending.push(current.cause);
    }
    if ("error" in current) {
      pending.push(current.error);
    }
  }
  return false;
}

/** Return the conventional shell exit code for a signal. */
export function signalExitCode(signal: NodeJS.Signals) {
  const signalNumber = signalNumberFor(signal);
  return signalNumber ? 128 + signalNumber : 1;
}

export function terminateManagedChild(
  child: ManagedProcessGroupChild & { kill(signal: NodeJS.Signals): unknown },
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

  // After exit this PID can name another process. Keep descendant cleanup
  // unverified instead of targeting that potentially unrelated owner.
  if (child.exitCode != null || child.signalCode != null) {
    return { processTreeState: "indeterminate" };
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
    if (platform === "linux" && (child.exitCode != null || child.signalCode != null)) {
      if (isLinuxZombieProcessGroup(pid)) {
        return "dead";
      }
      // The group may be reaped while ps runs. Recheck kernel existence without
      // treating an empty or failed snapshot as proof of completion.
      process.kill(-pid, 0);
    }
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

function isLinuxZombieProcessGroup(pid: number): boolean {
  // Detached children lead their own session. Linux kill(0) includes zombies,
  // which cannot write or respond to signals while awaiting their parent's reap.
  // Enumerate threads (-L): a process row reports only the group leader's state,
  // and a pthread_exit leader reads Z while sibling threads still run and write.
  const result = spawnSync("ps", ["-s", String(pid), "-L", "-o", "pgid=,state="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROCESS_GROUP_DRAIN_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const zombie = new RegExp(`^\\s*${pid}\\s+Z\\s*$`, "u");
  // Missing, failed or unrecognized snapshots never certify completion.
  return (
    !result.error &&
    result.status === 0 &&
    result.stdout
      .trim()
      .split("\n")
      .every((row) => zombie.test(row))
  );
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
  stdio = "inherit",
  platform = process.platform,
  timeoutMs,
  timeoutKillGraceMs,
  timeoutForceKillOnLeaderExit = false,
  requireProcessTreeExit = false,
  runTaskkill = spawnSync,
  onReady,
  signal,
  abortKillGraceMs,
  onSignal,
  ...commandOptions
}: RunManagedCommandOptions) {
  if (platform === "win32" && requireProcessTreeExit) {
    throw Object.assign(
      new Error("Strict managed process-tree verification is not supported on Windows"),
      { code: "EPROCESS_TREE_VERIFICATION_UNSUPPORTED" },
    );
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
    ...commandOptions,
    stdio: managedStdio,
    platform,
  });
  const commandEnv = commandOptions.env ?? process.env;
  let releaseClaim = findVitestResourceOwner(
    commandEnv.TMPDIR || commandEnv.TMP || commandEnv.TEMP || tmpdir(),
  )?.claim();
  const releaseOwnership = () => {
    releaseClaim?.();
    releaseClaim = undefined;
  };
  // Register before spawn: a child can become ready before spawn returns.
  installSignalHandlers();
  let child: ChildProcess;
  try {
    child = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
  } catch (error) {
    removeSignalHandlersIfIdle();
    releaseOwnership();
    throw error;
  }
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let finalization: Promise<{ type: "failed"; error: unknown } | undefined> | undefined;
  let cancellation: ManagedCommandOutcome | undefined;
  let notifyOutcome!: (outcome: ManagedCommandOutcome) => void;
  const completion = new Promise<ManagedCommandOutcome>((resolve) => {
    notifyOutcome = resolve;
  });
  const finalize = (
    stopSignal?: NodeJS.Signals,
    forceKillDelayMs?: number,
    forceKillOnLeaderExit = false,
  ) => {
    // Observe eager rejection even when cancellation starts inside onReady.
    // Physical release stays in onTerminated: strict cleanup can release, then fail.
    return (finalization ??= finalizeManagedChild(child, stopSignal, {
      platform,
      runTaskkill,
      forceKillDelayMs,
      forceKillOnLeaderExit,
      onTerminated: releaseOwnership,
    }).then(
      () => undefined,
      (error: unknown) => ({ type: "failed" as const, error }),
    ));
  };
  const stop = (outcome: ManagedCommandOutcome, ...termination: Parameters<typeof finalize>) => {
    cancellation ??= outcome;
    clearTimeout(timeoutTimer);
    const joined = finalize(...termination);
    notifyOutcome(cancellation);
    return joined;
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
    child.once("error", (error) => {
      clearTimeout(timeoutTimer);
      notifyOutcome({ type: "failed", error });
    });
    // The wall deadline includes output drainage, but not group verification after close.
    child.once("close", () => clearTimeout(timeoutTimer));
    // Strict owners must start cleanup at exit: descendants can hold output
    // open indefinitely. Finalization still joins the group and output pipes.
    child.once(requireProcessTreeExit ? "exit" : "close", (status, received) => {
      notifyOutcome({
        type: "completed",
        exit: received ?? status ?? 1,
      });
    });
    if (timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        void stop({ type: "timeout" }, "SIGTERM", timeoutKillGraceMs, timeoutForceKillOnLeaderExit);
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
      if (cleanup && cleanup.error !== error) {
        throw createManagedCommandSetupCleanupError(error, cleanup.error);
      }
      throw error;
    }
    let outcome = await completion;
    if (outcome.type === "completed" && requireProcessTreeExit) {
      // Preserve actual signal cleanup; numeric 143 must still reject lingering descendants.
      const exitSignal = typeof outcome.exit === "string" ? outcome.exit : undefined;
      void finalize(exitSignal);
    }
    // Cleanup failure overrides the first cancellation, including during strict drainage.
    const cleanup = finalization ? await finalization : undefined;
    outcome = cleanup ?? cancellation ?? outcome;
    // Preserve the ordinary API's close-based contract. Cancellation and strict
    // commands release only at the finalizer's positive termination boundary.
    if (outcome.type === "completed" && !requireProcessTreeExit && !cancellation) {
      releaseOwnership();
    }
    if (outcome.type === "failed") {
      throw outcome.error;
    }
    if (outcome.type === "timeout") {
      throw Object.assign(new Error(`Managed command timed out after ${timeoutMs}ms`), {
        code: "ETIMEDOUT",
      });
    }
    if (outcome.type === "aborted") {
      throw Object.assign(new Error("Managed command aborted"), { code: "ABORT_ERR" });
    }
    if (outcome.type === "signal") {
      return signalExitCode(outcome.signal);
    }
    return typeof outcome.exit === "string" ? signalExitCode(outcome.exit) : outcome.exit;
  } finally {
    clearTimeout(timeoutTimer);
    signal?.removeEventListener("abort", abort);
    managedChildren.delete(forwardSignal);
    removeSignalHandlersIfIdle();
    if (!child.pid) {
      releaseOwnership();
    }
  }
}

async function finalizeManagedChild(
  child: ChildProcess,
  signal: NodeJS.Signals | undefined,
  {
    platform,
    runTaskkill,
    forceKillDelayMs = FORCE_KILL_DELAY_MS,
    forceKillOnLeaderExit = false,
    onTerminated,
  }: {
    platform: NodeJS.Platform;
    runTaskkill: TaskkillRunner;
    forceKillDelayMs?: number;
    forceKillOnLeaderExit?: boolean;
    onTerminated: () => void;
  },
) {
  // Nested wrappers own detached groups. Let them forward the signal before
  // killing their leader, then join inherited pipes as well as our own group.
  // Normal exit has no grace period: surviving group members are a failure.
  const termination =
    !signal &&
    inspectManagedProcessGroup(child, { errorPolicy: "indeterminate", platform }) === "dead"
      ? { processTreeState: "terminated" }
      : terminateManagedChild(child, signal ?? "SIGKILL", { platform, runTaskkill });
  if (platform === "win32" && termination?.processTreeState !== "terminated") {
    throw createManagedCommandCleanupError(
      "Windows taskkill could not verify managed process tree exit",
      child,
      platform,
      "indeterminate",
    );
  }
  const forceAt = Date.now() + (signal ? forceKillDelayMs : 0);
  const deadline = forceAt + PROCESS_GROUP_DRAIN_TIMEOUT_MS;
  let forced = !signal || platform === "win32";
  let groupState: "dead" | "indeterminate" | "live" = "indeterminate";
  while (true) {
    groupState =
      platform === "win32"
        ? "dead"
        : inspectManagedProcessGroup(child, { errorPolicy: "indeterminate", platform });
    const exited = child.exitCode !== null || child.signalCode !== null;
    const pipesClosed = [child.stdout, child.stderr].every((pipe) => !pipe || pipe.closed);
    if (groupState === "dead" && exited && pipesClosed) {
      onTerminated();
      // A missing group at signal time supersedes the earlier racy liveness probe.
      if (!signal && termination?.processTreeState !== "terminated") {
        throw createManagedCommandCleanupError(
          "Managed command exited while its process group remained active",
          child,
          platform,
          "terminated",
        );
      }
      return;
    }
    const now = Date.now();
    // Bounded timeout callers can retire remaining descendants as soon as the
    // leader exits. Other owners retain their configured graceful-drain window.
    if (!forced && (now >= forceAt || (forceKillOnLeaderExit && exited))) {
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
  // escaped descendant holding stdio as successful completion or cancellation.
  child.stdout?.destroy();
  child.stderr?.destroy();
  throw createManagedCommandCleanupError(
    "Managed command cleanup could not verify child, process group, and output closure",
    child,
    platform,
    groupState === "live" ? "live" : "indeterminate",
  );
}

function createManagedCommandSetupCleanupError(error: unknown, cleanupError: unknown) {
  return new AggregateError(
    [error, cleanupError],
    "Managed command setup failed and its process tree could not be cleaned up",
    { cause: cleanupError },
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

export function createManagedCommandSpawnSpec(options: ManagedCommandOptions) {
  const { cwd, env, stdio = "inherit", platform = process.platform } = options;
  const { args, command, ...invocationOptions } = createManagedCommandInvocation(options);

  return {
    args,
    command,
    options: {
      cwd,
      env,
      stdio,
      ...invocationOptions,
      detached: platform !== "win32",
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
