/**
 * Shared transport lifecycle helpers for stdio and WebSocket Codex app-server
 * connections.
 */
import { terminateCodexAppServerDescendants } from "./transport-process-containment.js";

const CODEX_APP_SERVER_TRANSPORT_CLOSES = new WeakMap<object, Promise<void>>();

/** Child-process-like transport shape consumed by the Codex app-server client. */
export type CodexAppServerTransport = {
  stdin: {
    write: (data: string | Uint8Array, callback?: (error?: Error | null) => void) => unknown;
    end?: () => unknown;
    destroy?: () => unknown;
    unref?: () => unknown;
    on?: (event: "error", listener: (error: Error) => void) => unknown;
  };
  stdout: NodeJS.ReadableStream & {
    destroy?: () => unknown;
    unref?: () => unknown;
  };
  stderr: NodeJS.ReadableStream & {
    destroy?: () => unknown;
    unref?: () => unknown;
  };
  pid?: number;
  exitCode?: number | null;
  signalCode?: string | null;
  killed?: boolean;
  kill?: (signal?: NodeJS.Signals) => unknown;
  unref?: () => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

/** Starts graceful transport shutdown and schedules a force kill fallback. */
export function closeCodexAppServerTransport(
  child: CodexAppServerTransport,
  options: { forceKillDelayMs?: number } = {},
): void {
  void beginCodexAppServerTransportClose(child, options);
}

function beginCodexAppServerTransportClose(
  child: CodexAppServerTransport,
  options: { forceKillDelayMs?: number },
): Promise<void> {
  const current = CODEX_APP_SERVER_TRANSPORT_CLOSES.get(child);
  if (current) {
    return current;
  }
  if (
    process.platform === "win32" ||
    !child.pid ||
    !child.kill ||
    hasCodexAppServerTransportExited(child)
  ) {
    finishCodexAppServerTransportClose(child, options);
    const completed = Promise.resolve();
    CODEX_APP_SERVER_TRANSPORT_CLOSES.set(child, completed);
    return completed;
  }
  const closing = (async () => {
    let resumeRoot: (() => void) | undefined;
    try {
      resumeRoot = await terminateCodexAppServerDescendants(child);
    } catch {
      resumeRoot = undefined;
    }
    try {
      finishCodexAppServerTransportClose(child, options, resumeRoot);
    } catch {
      signalCodexAppServerTransport(child, "SIGKILL");
    }
  })();
  CODEX_APP_SERVER_TRANSPORT_CLOSES.set(child, closing);
  return closing;
}

function finishCodexAppServerTransportClose(
  child: CodexAppServerTransport,
  options: { forceKillDelayMs?: number },
  resumeRoot?: () => void,
): void {
  const forceKillDelayMs = options.forceKillDelayMs ?? 1_000;
  const forceKill = setTimeout(
    () => {
      if (hasCodexAppServerTransportExited(child)) {
        return;
      }
      signalCodexAppServerTransport(child, "SIGKILL");
    },
    Math.max(1, forceKillDelayMs),
  );
  forceKill.unref?.();
  child.once("exit", () => {
    clearTimeout(forceKill);
    child.stdout.destroy?.();
    child.stderr.destroy?.();
  });
  try {
    child.stdin.end?.();
    child.stdin.destroy?.();
  } finally {
    resumeRoot?.();
  }
  child.unref?.();
  child.stdout.unref?.();
  child.stderr.unref?.();
  child.stdin.unref?.();
}

/** Closes a transport and waits briefly for an exit event. */
export async function closeCodexAppServerTransportAndWait(
  child: CodexAppServerTransport,
  options: { exitTimeoutMs?: number; forceKillDelayMs?: number } = {},
): Promise<boolean> {
  if (!hasCodexAppServerTransportExited(child)) {
    await beginCodexAppServerTransportClose(child, options);
  }
  return await waitForCodexAppServerTransportExit(child, options.exitTimeoutMs ?? 2_000);
}

function hasCodexAppServerTransportExited(child: CodexAppServerTransport): boolean {
  return child.exitCode !== null && child.exitCode !== undefined
    ? true
    : child.signalCode !== null && child.signalCode !== undefined;
}

async function waitForCodexAppServerTransportExit(
  child: CodexAppServerTransport,
  timeoutMs: number,
): Promise<boolean> {
  if (hasCodexAppServerTransportExited(child)) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const onExit = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(
      () => {
        if (settled) {
          return;
        }
        settled = true;
        child.off?.("exit", onExit);
        resolve(false);
      },
      Math.max(1, timeoutMs),
    );
    child.once("exit", onExit);
  });
}

function signalCodexAppServerTransport(
  child: CodexAppServerTransport,
  signal: NodeJS.Signals,
): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the child handle. The process may already be gone or not
      // be a process-group leader on older call sites.
    }
  }
  child.kill?.(signal);
}
