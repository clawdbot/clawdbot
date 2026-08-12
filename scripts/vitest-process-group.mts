// Shared Vitest child process-group signal forwarding helpers.
import { execFileSync, type ChildProcess } from "node:child_process";

type VitestProcessSignal = "SIGINT" | "SIGKILL" | "SIGTERM";
type KillProcess = (pid: number, signal?: VitestProcessSignal | 0) => boolean;
type VitestChild = Pick<ChildProcess, "pid">;
type SignalTargetParams = { childPid?: number; platform?: NodeJS.Platform };
type ProcessGroupParams = {
  child: VitestChild;
  kill?: KillProcess;
  platform?: NodeJS.Platform;
};
type ForwardSignalParams = ProcessGroupParams & {
  kill: KillProcess;
  signal: VitestProcessSignal | 0;
};
type CompletionParams = ProcessGroupParams & { child: ChildProcess; detached: boolean };
type CleanupParams = ProcessGroupParams & {
  cleanupSignal?: VitestProcessSignal;
  forceSignal?: VitestProcessSignal | null;
  forceSignalDelayMs?: number;
  forwardedSignals?: VitestProcessSignal[];
  onSignal?: (signal: VitestProcessSignal) => void;
  processObject?: NodeJS.Process;
};

export function shouldUseDetachedVitestProcessGroup(
  platform: NodeJS.Platform = process.platform,
): platform is Exclude<NodeJS.Platform, "win32"> {
  return platform !== "win32";
}

/**
 * Resolves the PID or process-group target for Vitest signal forwarding.
 */
export function resolveVitestProcessGroupSignalTarget(params: SignalTargetParams): number | null {
  const pid = params.childPid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return shouldUseDetachedVitestProcessGroup(params.platform) ? -pid : pid;
}

/**
 * Forwards a signal to the Vitest child or process group.
 */
export function forwardSignalToVitestProcessGroup(params: ForwardSignalParams) {
  const target = resolveVitestProcessGroupSignalTarget({
    childPid: params.child.pid,
    platform: params.platform,
  });
  if (target === null) {
    return false;
  }
  try {
    params.kill(target, params.signal);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH" || code === "EPERM") {
      return false;
    }
    throw error;
  }
}

/**
 * Force-cleans any remaining processes in a Vitest child process group.
 */
export function forceKillVitestProcessGroup(
  child: VitestChild,
  kill: KillProcess = process.kill.bind(process),
) {
  return forwardSignalToVitestProcessGroup({
    child,
    kill,
    signal: "SIGKILL",
  });
}

const PROCESS_GROUP_JOIN_TIMEOUT_MS = 1_000;
const PROCESS_GROUP_INSPECT_TIMEOUT_MS = 1_000;

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function isVitestProcessGroupAlive(target: number, kill: KillProcess) {
  try {
    kill(target, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    throw error;
  }
}

export function parseVitestProcessGroupMembers(output: string, processGroupId: number): string {
  const members: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match || Number(match[3]) !== processGroupId) {
      continue;
    }
    members.push(
      `pid=${match[1]} ppid=${match[2]} state=${match[4]} comm=${match[5]?.slice(0, 80)}`,
    );
    if (members.length >= 20) {
      break;
    }
  }
  return members.length > 0 ? members.join("; ") : "none";
}

function inspectVitestProcessGroup(processGroupId: number, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return "unavailable";
  }
  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,comm="], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: PROCESS_GROUP_INSPECT_TIMEOUT_MS,
    });
    return parseVitestProcessGroupMembers(output, processGroupId);
  } catch {
    return "unavailable";
  }
}

async function joinVitestProcessGroup(
  child: VitestChild,
  platform: NodeJS.Platform,
  kill: KillProcess,
) {
  const target = resolveVitestProcessGroupSignalTarget({ childPid: child.pid, platform });
  if (target === null) {
    return;
  }
  forwardSignalToVitestProcessGroup({ child, kill, platform, signal: "SIGKILL" });
  const deadlineAt = Date.now() + PROCESS_GROUP_JOIN_TIMEOUT_MS;
  while (isVitestProcessGroupAlive(target, kill)) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      const members = inspectVitestProcessGroup(child.pid!, platform);
      throw new Error(
        `[vitest] process group ${child.pid ?? "unknown"} remained alive ${PROCESS_GROUP_JOIN_TIMEOUT_MS}ms after SIGKILL; members: ${members}.`,
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(25, remainingMs));
    });
  }
}

function waitForChildCompletionEvent(child: ChildProcess, event: "exit" | "close") {
  return new Promise<{ code: number | null; signal: ChildProcess["signalCode"] }>(
    (resolve, reject) => {
      child.once(event, (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    },
  );
}

/**
 * Resolves only after the child completion contract and any owned POSIX group are joined.
 */
export function createVitestProcessCompletion(params: CompletionParams) {
  const exitCompletion = waitForChildCompletionEvent(params.child, "exit");
  const platform = params.platform ?? process.platform;
  if (!params.detached || !shouldUseDetachedVitestProcessGroup(platform)) {
    return exitCompletion;
  }

  const closeCompletion = waitForChildCompletionEvent(params.child, "close");
  // `close` drains inherited pipes, while the group join proves pipe-independent
  // descendants are gone before a sequential caller advances.
  const groupCompletion = exitCompletion.then(async (result) => {
    await joinVitestProcessGroup(params.child, platform, params.kill ?? process.kill.bind(process));
    return result;
  });
  return Promise.all([groupCompletion, closeCompletion]).then(([result]) => result);
}

function ensureProcessListenerCapacity(
  processObject: NodeJS.Process,
  eventName: string,
  additionalListeners = 1,
) {
  if (
    typeof processObject.getMaxListeners !== "function" ||
    typeof processObject.setMaxListeners !== "function" ||
    typeof processObject.listenerCount !== "function"
  ) {
    return;
  }

  const currentLimit = processObject.getMaxListeners();
  if (currentLimit === 0) {
    return;
  }

  const neededLimit = processObject.listenerCount(eventName) + additionalListeners + 1;
  if (neededLimit > currentLimit) {
    processObject.setMaxListeners(neededLimit);
  }
}

/**
 * Installs signal/exit cleanup handlers for a Vitest child process group.
 */
export function installVitestProcessGroupCleanup(params: CleanupParams) {
  const processObject = params.processObject ?? process;
  const platform = params.platform ?? process.platform;
  const kill = params.kill ?? process.kill.bind(process);
  const cleanupSignal = params.cleanupSignal ?? "SIGTERM";
  const forceSignal = params.forceSignal ?? null;
  const forceSignalDelayMs = params.forceSignalDelayMs ?? 0;
  const forwardedSignals = params.forwardedSignals ?? ["SIGINT", "SIGTERM"];
  const child = params.child;
  const onSignal = params.onSignal;

  let active = true;

  const forward = (signal: VitestProcessSignal) => {
    if (!active) {
      return;
    }
    forwardSignalToVitestProcessGroup({
      child,
      signal,
      platform,
      kill,
    });
  };

  const signalHandlers = new Map<VitestProcessSignal, () => void>();
  for (const signal of forwardedSignals) {
    const handler = () => {
      onSignal?.(signal);
      forward(signal);
      if (forceSignal) {
        if (forceSignalDelayMs > 0) {
          setTimeout(() => forward(forceSignal), forceSignalDelayMs).unref?.();
        } else {
          queueMicrotask(() => forward(forceSignal));
        }
      }
    };
    signalHandlers.set(signal, handler);
    ensureProcessListenerCapacity(processObject, signal);
    processObject.on(signal, handler);
  }

  const exitHandler = () => {
    forward(cleanupSignal);
  };
  ensureProcessListenerCapacity(processObject, "exit");
  processObject.on("exit", exitHandler);

  return () => {
    if (!active) {
      return;
    }
    active = false;
    for (const [signal, handler] of signalHandlers) {
      processObject.off(signal, handler);
    }
    processObject.off("exit", exitHandler);
  };
}
