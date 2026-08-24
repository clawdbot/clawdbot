import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { crabboxCommandError } from "./crabbox-worker-command-error.js";

const CRABBOX_HEARTBEAT_UPGRADE = "upgrade Crabbox to v0.44.0 or newer for `crabbox heartbeat`";

type HeartbeatContext = {
  binary: string;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  id: string;
  idleTimeout: string;
  provider: string;
};

type HeartbeatEntry = HeartbeatContext & {
  controller?: AbortController;
  failureWarned: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

function permanentHeartbeatFailure(result: SpawnResult): "command" | "provider" | undefined {
  const output = `${result.stderr}\n${result.stdout}`;
  if (
    result.termination === "exit" &&
    result.code === 2 &&
    /\bprovider=\S+ does not support lease heartbeat\b/iu.test(output)
  ) {
    return "provider";
  }
  const commandUnknown =
    /\b(?:unexpected argument|unknown command|unrecognized command)[^\r\n]*\bheartbeat\b/iu.test(
      output,
    ) || /\bheartbeat\b[^\r\n]*\b(?:unknown|unrecognized)\b/iu.test(output);
  return commandUnknown || (result.termination === "exit" && result.code === 2)
    ? "command"
    : undefined;
}

export function createCrabboxHeartbeatManager(dependencies: {
  run: (context: HeartbeatContext, signal: AbortSignal) => Promise<SpawnResult>;
  warn: (message: string) => void;
}) {
  const entries = new Map<string, HeartbeatEntry>();
  const isCurrent = (entry: HeartbeatEntry) => entries.get(entry.id) === entry;
  const warn = (entry: HeartbeatEntry, message: string) =>
    dependencies.warn(
      `${message}; cloud worker machines may be reaped after ${entry.idleTimeout} of coordinator-idle time`,
    );

  const schedule = (entry: HeartbeatEntry, delayMs = entry.heartbeatIntervalMs) => {
    if (!isCurrent(entry)) {
      return;
    }
    entry.timer = setTimeout(() => void heartbeat(entry), delayMs);
    entry.timer.unref?.();
  };

  const heartbeat = async (entry: HeartbeatEntry): Promise<void> => {
    if (!isCurrent(entry) || entry.controller) {
      return;
    }
    const controller = new AbortController();
    entry.controller = controller;
    let result: SpawnResult;
    const startedAt = Date.now();
    try {
      result = await dependencies.run(entry, controller.signal);
    } catch (error) {
      if (isCurrent(entry) && !entry.failureWarned) {
        entry.failureWarned = true;
        warn(entry, error instanceof Error ? error.message : "Crabbox heartbeat failed");
      }
      delete entry.controller;
      schedule(entry);
      return;
    }
    delete entry.controller;
    if (!isCurrent(entry)) {
      return;
    }
    if (result.termination === "exit" && result.code === 0) {
      entry.failureWarned = false;
      schedule(entry);
      return;
    }
    const permanentFailure = permanentHeartbeatFailure(result);
    if (permanentFailure) {
      const message =
        permanentFailure === "command"
          ? `Crabbox heartbeat is unavailable for worker lease ${entry.id}; ${CRABBOX_HEARTBEAT_UPGRADE}`
          : `Crabbox provider ${entry.provider} does not support heartbeat for worker lease ${entry.id}`;
      warn(entry, message);
      return;
    }
    if (!entry.failureWarned) {
      entry.failureWarned = true;
      const message = crabboxCommandError("heartbeat", result).message;
      warn(entry, message.replace("(timeout)", `(timeout after ${Date.now() - startedAt} ms)`));
    }
    schedule(entry);
  };

  return {
    start(context: HeartbeatContext): void {
      if (entries.has(context.id)) {
        return;
      }
      const entry = { ...context, failureWarned: false };
      entries.set(context.id, entry);
      schedule(entry, 0);
    },
    stop(leaseId: string): void {
      const entry = entries.get(leaseId);
      if (!entry) {
        return;
      }
      entries.delete(leaseId);
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.controller?.abort();
    },
  };
}
