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
type TaskkillRunner = (
  command: string,
  args: string[],
  options: { killSignal?: NodeJS.Signals; stdio?: StdioOptions; timeout?: number },
) => { error?: Error; status: number | null } | undefined;

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

/**
 * Return conventional shell exit code for a signal.
 *
 * @param {NodeJS.Signals} signal
 * @returns {number}
 */
export function signalExitCode(signal: NodeJS.Signals) {
  const signalNumber = signalNumberFor(signal);
  return signalNumber ? 128 + signalNumber : 1;
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals} [signal]
 * @param {{
 *   onProcessGroupSignalError?: (error: unknown) => void;
 *   platform?: NodeJS.Platform;
 *   runTaskkill?: typeof spawnSync;
 *   useProcessGroup?: boolean;
 * }} [options]
 * @returns {{ processTreeState: "indeterminate" | "signaled" | "terminated" } | undefined}
 */
export function terminateManagedChild(
  child: { kill(signal?: NodeJS.Signals): unknown; pid?: number },
  signal: NodeJS.Signals = "SIGTERM",
  {
    onProcessGroupSignalError,
    platform = process.platform,
    runTaskkill = spawnSync,
    useProcessGroup = platform !== "win32",
  }: {
    onProcessGroupSignalError?: (error: unknown) => void;
    platform?: NodeJS.Platform;
    runTaskkill?: TaskkillRunner;
    useProcessGroup?: boolean;
  } = {},
): ManagedChildTermination | undefined {
  if (!child.pid) {
    try {
      const delivered = child.kill(signal);
      if (platform !== "win32") {
        return { processTreeState: delivered === false ? "terminated" : "signaled" };
      }
    } catch {
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
    if (!isMissingProcessError(error)) {
      onProcessGroupSignalError?.(error);
    }
  }

  if (platform !== "win32") {
    try {
      const delivered = child.kill(signal);
      return { processTreeState: delivered === false ? "terminated" : "signaled" };
    } catch (error) {
      return isMissingProcessError(error) ? { processTreeState: "terminated" } : undefined;
    }
  }

  if (platform === "win32") {
    const taskkillPath = resolveWindowsTaskkillPath();
    const args = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") {
      args.push("/F");
    }
    const taskkillOptions = {
      killSignal: "SIGKILL",
      stdio: "ignore",
      timeout: TASKKILL_TIMEOUT_MS,
    } satisfies Parameters<TaskkillRunner>[2];
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
    } catch {
      // The leader may already be gone, but failed taskkill leaves descendants unverified.
    }
    return { processTreeState: "indeterminate" };
  }
  return undefined;
}

/**
 * Run a child command while forwarding termination signals to the managed process group.
 *
 * @param {{
 *   bin: string;
 *   args?: string[];
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 *   stdio?: import("node:child_process").StdioOptions;
 *   shell?: boolean;
 *   windowsVerbatimArguments?: boolean;
 *   platform?: NodeJS.Platform;
 *   comSpec?: string;
 *   timeoutMs?: number;
 *   requireProcessTreeExit?: boolean;
 *   runTaskkill?: typeof spawnSync;
 *   onReady?: (child: import("node:child_process").ChildProcess) => void;
 * }} options
 * @returns {Promise<number>}
 */
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
  const child = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
  const managedChild: ManagedChild = {
    child,
    forceKillTimer: null,
    receivedSignal: undefined,
  };
  addManagedChild(managedChild);
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
    removeManagedChild(managedChild);
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

function processGroupStatus(pid: number | undefined): "dead" | "indeterminate" | "live" {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1 || pid > 0x7fffffff) {
    return "indeterminate";
  }
  try {
    process.kill(-pid, 0);
    return "live";
  } catch (error) {
    return isMissingProcessError(error) ? "dead" : "indeterminate";
  }
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
  const initialStatus = processGroupStatus(child.pid);
  if (initialStatus === "dead") {
    return;
  }
  let status: ReturnType<typeof processGroupStatus> = initialStatus;
  // A missing group at signal time supersedes the earlier racy liveness probe.
  const termination = terminateIfLive
    ? terminateManagedChild(child, "SIGKILL", { platform })
    : undefined;
  const deadline = Date.now() + PROCESS_GROUP_DRAIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, PROCESS_GROUP_POLL_MS);
    });
    status = processGroupStatus(child.pid);
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

/**
 * Build the spawn command, args, and options used by managed command execution.
 *
 * @param {{
 *   child: import("node:child_process").ChildProcess;
 *   forceKillTimer: ReturnType<typeof setTimeout> | null;
 *   receivedSignal: string | null;
 * }} managedChild
 */
function addManagedChild(managedChild: ManagedChild) {
  managedChildren.add(managedChild);
  installSignalHandlers();
}

/**
 * Build a normalized command invocation, including cmd.exe wrapping on Windows.
 *
 * @param {{
 *   child: import("node:child_process").ChildProcess;
 *   forceKillTimer: ReturnType<typeof setTimeout> | null;
 *   receivedSignal: string | null;
 * }} managedChild
 */
function removeManagedChild(managedChild: ManagedChild) {
  managedChildren.delete(managedChild);
  if (managedChildren.size === 0) {
    removeSignalHandlers();
  }
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

function removeSignalHandlers() {
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
  signalHandlers.clear();
}

/**
 * @param {NodeJS.Signals} signal
 */
function forwardSignalToManagedChildren(signal: NodeJS.Signals) {
  for (const managedChild of managedChildren) {
    managedChild.receivedSignal ??= signal;
    terminateManagedChild(managedChild.child, signal);
    managedChild.forceKillTimer ??= setTimeout(() => {
      terminateManagedChild(managedChild.child, "SIGKILL");
    }, FORCE_KILL_DELAY_MS);
  }
}

/**
 * @param {{
 *   bin: string;
 *   args?: string[];
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 *   stdio?: import("node:child_process").StdioOptions;
 *   shell?: boolean;
 *   windowsVerbatimArguments?: boolean;
 *   platform?: NodeJS.Platform;
 *   comSpec?: string;
 * }} options
 */
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

/**
 * @param {{
 *   bin: string;
 *   args?: string[];
 *   env?: NodeJS.ProcessEnv;
 *   shell?: boolean;
 *   windowsVerbatimArguments?: boolean;
 *   platform?: NodeJS.Platform;
 *   comSpec?: string;
 * }} options
 */
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
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
}
