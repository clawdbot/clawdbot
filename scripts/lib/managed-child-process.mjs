// Runs child commands with process-group signal forwarding and Windows shell normalization.
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { buildCmdExeCommandLine } from "../windows-cmd-helpers.mjs";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const FORCE_KILL_DELAY_MS = 5_000;
const managedChildren = new Set();
const signalHandlers = new Map();

/**
 * Return conventional shell exit code for a signal.
 *
 * @param {NodeJS.Signals} signal
 * @returns {number}
 */
export function signalExitCode(signal) {
  const signalNumber = signalNumberFor(signal);
  return signalNumber ? 128 + signalNumber : 1;
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals} [signal]
 */
function terminateManagedChild(child, signal = "SIGTERM") {
  if (!child.pid) {
    return;
  }

  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
      return;
    }
  } catch (error) {
    if (!isMissingProcessError(error)) {
      try {
        child.kill(signal);
      } catch {
        // The process may have already exited between the group kill and fallback kill.
      }
    }
    return;
  }

  child.kill(signal);
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
  shell = process.platform === "win32",
  windowsVerbatimArguments,
  platform = process.platform,
  comSpec,
  onReady,
}) {
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
  const managedChild = {
    child,
    forceKillTimer: null,
    receivedSignal: null,
  };
  addManagedChild(managedChild);
  onReady?.(child);

  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => {
        if (managedChild.forceKillTimer) {
          clearTimeout(managedChild.forceKillTimer);
        }
        resolve(
          managedChild.receivedSignal
            ? signalExitCode(managedChild.receivedSignal)
            : signal
              ? signalExitCode(signal)
              : (status ?? 1),
        );
      });
    });
  } finally {
    removeManagedChild(managedChild);
  }
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
function addManagedChild(managedChild) {
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
function removeManagedChild(managedChild) {
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
function forwardSignalToManagedChildren(signal) {
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
  shell = process.platform === "win32",
  windowsVerbatimArguments,
  platform = process.platform,
  comSpec,
}) {
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
  shell = process.platform === "win32",
  windowsVerbatimArguments,
  platform = process.platform,
  comSpec,
}) {
  if (platform === "win32" && shell && args.length > 0) {
    return {
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(bin, args)],
      command: comSpec ?? env?.ComSpec ?? env?.COMSPEC ?? process.env.ComSpec ?? "cmd.exe",
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

function signalNumberFor(signal) {
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

function isMissingProcessError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
}
