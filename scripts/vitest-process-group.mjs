// Shared Vitest child process-group signal forwarding helpers.
export function shouldUseDetachedVitestProcessGroup(platform = process.platform) {
  return platform !== "win32";
}

/**
 * Resolves the PID or process-group target for Vitest signal forwarding.
 */
export function resolveVitestProcessGroupSignalTarget(params) {
  const pid = params.childPid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return shouldUseDetachedVitestProcessGroup(params.platform) ? -pid : pid;
}

/**
 * Forwards a signal to the Vitest child or process group.
 */
export function forwardSignalToVitestProcessGroup(params) {
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
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ESRCH" || error.code === "EPERM")
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Force-cleans any remaining processes in a Vitest child process group.
 */
export function forceKillVitestProcessGroup(child, kill = process.kill.bind(process)) {
  return forwardSignalToVitestProcessGroup({
    child,
    kill,
    signal: "SIGKILL",
  });
}

const PROCESS_GROUP_JOIN_TIMEOUT_MS = 1_000;

function isVitestProcessGroupAlive(target, kill) {
  try {
    kill(target, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

async function joinVitestProcessGroup(child, platform, kill) {
  const target = resolveVitestProcessGroupSignalTarget({ childPid: child.pid, platform });
  if (target === null) {
    return;
  }
  forwardSignalToVitestProcessGroup({ child, kill, platform, signal: "SIGKILL" });
  const deadlineAt = Date.now() + PROCESS_GROUP_JOIN_TIMEOUT_MS;
  while (isVitestProcessGroupAlive(target, kill)) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `[vitest] process group ${child.pid ?? "unknown"} remained alive ${PROCESS_GROUP_JOIN_TIMEOUT_MS}ms after SIGKILL; inspect its descendants before starting another shard.`,
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(25, remainingMs));
    });
  }
}

function waitForChildCompletionEvent(child, event) {
  return new Promise((resolve, reject) => {
    child.once(event, (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
}

/**
 * Resolves only after the child completion contract and any owned POSIX group are joined.
 */
export function createVitestProcessCompletion(params) {
  const exitCompletion = waitForChildCompletionEvent(params.child, "exit");
  const platform = params.platform ?? process.platform;
  if (params.detached !== true || !shouldUseDetachedVitestProcessGroup(platform)) {
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

function ensureProcessListenerCapacity(processObject, eventName, additionalListeners = 1) {
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
export function installVitestProcessGroupCleanup(params) {
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

  const forward = (signal) => {
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

  const signalHandlers = new Map();
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
