// Runs child commands with process-group signal forwarding and Windows shell normalization.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import { constants as osConstants } from "node:os";
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
};

type ManagedChild = {
  child: ChildProcess;
  forceKillTimer: ReturnType<typeof setTimeout> | null;
  receivedSignal?: NodeJS.Signals;
};

const managedChildren = new Set<ManagedChild>();
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
}: RunManagedCommandOptions) {
  if (platform === "win32" && requireProcessTreeExit) {
    throw createManagedCommandUnsupportedTreeVerificationError();
  }
  const spawnSpec = createManagedCommandSpawnSpec({
    bin,
    args,
    cwd,
    env,
    stdio,
    shell,
    windowsVerbatimArguments,
    platform,
    comSpec,
  });
  // A child can become ready before spawn returns. Catch OS signals first so
  // their callbacks wait for registration instead of orphaning a detached child.
  installSignalHandlers();
  let child: ChildProcess;
  try {
    child = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
  } catch (error) {
    removeSignalHandlersIfIdle();
    throw error;
  }
  const managedChild: ManagedChild = {
    child,
    forceKillTimer: null,
    receivedSignal: undefined,
  };
  managedChildren.add(managedChild);
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let signalTimeout!: () => void;
  let timedOut = false;
  let timeoutTermination: ManagedChildTermination | undefined;
  const timeoutTriggered = new Promise<void>((resolve) => {
    signalTimeout = resolve;
  });

  try {
    const childCompletion = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (managedChild.forceKillTimer) {
          clearTimeout(managedChild.forceKillTimer);
        }
        if (managedChild.receivedSignal) {
          terminateManagedChild(child, "SIGKILL");
          resolve(signalExitCode(managedChild.receivedSignal));
          return;
        }
        if (timedOut) {
          reject(createManagedCommandTimeoutError(timeoutMs));
          return;
        }
        resolve(signal ? signalExitCode(signal) : (status ?? 1));
      });
      if (timeoutMs !== undefined) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          // Shell commands may spawn grandchildren, so timeout cleanup owns the whole tree.
          timeoutTermination = terminateManagedChild(child, "SIGKILL", {
            platform,
            runTaskkill,
          });
          signalTimeout();
        }, timeoutMs);
      }
    });
    const childOutcome = childCompletion.then(
      (status) => ({ status, type: "completed" as const }),
      (error: unknown) => ({ error, type: "failed" as const }),
    );
    try {
      onReady?.(child);
    } catch (error) {
      const setupTermination = terminateManagedChild(child, "SIGKILL", {
        platform,
        runTaskkill,
      });
      try {
        await ensureManagedProcessTreeExit(child, platform, {
          windowsTermination: setupTermination,
        });
      } catch (cleanupError) {
        throw createManagedCommandSetupCleanupError(error, cleanupError);
      }
      throw error;
    }
    const timeoutOutcome = timeoutTriggered.then(() => ({ type: "timeout" as const }));
    const outcome =
      timeoutMs === undefined
        ? await childOutcome
        : await Promise.race([childOutcome, timeoutOutcome]);
    if (outcome.type === "timeout") {
      await ensureManagedProcessTreeExit(child, platform, {
        windowsTermination: timeoutTermination,
      });
      throw createManagedCommandTimeoutError(timeoutMs);
    }
    if (outcome.type === "failed") {
      if (timedOut) {
        await ensureManagedProcessTreeExit(child, platform, {
          windowsTermination: timeoutTermination,
        });
      }
      throw outcome.error;
    }
    if (requireProcessTreeExit) {
      await ensureManagedProcessTreeExit(child, platform, { terminateIfLive: true });
    }
    return outcome.status;
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    managedChildren.delete(managedChild);
    removeSignalHandlersIfIdle();
  }
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

async function ensureManagedProcessTreeExit(
  child: ChildProcess,
  platform: NodeJS.Platform,
  {
    terminateIfLive = false,
    windowsTermination,
  }: { terminateIfLive?: boolean; windowsTermination?: ManagedChildTermination } = {},
) {
  if (platform === "win32") {
    if (windowsTermination?.processTreeState === "indeterminate") {
      throw createManagedCommandCleanupError(
        "Windows taskkill could not verify managed process tree exit",
        child,
        platform,
        "indeterminate",
      );
    }
    return;
  }
  const initialStatus = inspectManagedProcessGroup(child, {
    errorPolicy: "indeterminate",
    platform,
  });
  if (initialStatus === "dead") {
    return;
  }
  let status: ReturnType<typeof inspectManagedProcessGroup> = initialStatus;
  // A missing group at signal time supersedes the earlier racy liveness probe.
  const termination = terminateIfLive
    ? terminateManagedChild(child, "SIGKILL", { platform })
    : undefined;
  const deadline = Date.now() + PROCESS_GROUP_DRAIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, PROCESS_GROUP_POLL_MS);
    });
    status = inspectManagedProcessGroup(child, { errorPolicy: "indeterminate", platform });
    if (status === "dead") {
      if (terminateIfLive && termination?.processTreeState !== "terminated") {
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
  for (const managedChild of managedChildren) {
    managedChild.receivedSignal ??= signal;
    terminateManagedChild(managedChild.child, signal);
    managedChild.forceKillTimer ??= setTimeout(() => {
      terminateManagedChild(managedChild.child, "SIGKILL");
    }, FORCE_KILL_DELAY_MS);
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
