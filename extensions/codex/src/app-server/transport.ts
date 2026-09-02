/**
 * Shared transport lifecycle helpers for stdio and WebSocket Codex app-server
 * connections.
 */
import { finished } from "node:stream/promises";
import { terminateCodexAppServerDescendants } from "./transport-process-containment.js";

type TransportClose = { closing: Promise<boolean>; naturalExit: boolean };
const CODEX_APP_SERVER_TRANSPORT_CLOSES = new WeakMap<object, TransportClose>();

type TransportCloseOptions = { forceKillDelayMs?: number; drainStdio?: boolean };

/** True only after bounded settlement proves an exit that cleanup did not cause. */
export function hasCodexAppServerNaturalExit(child: CodexAppServerTransport): boolean {
  return CODEX_APP_SERVER_TRANSPORT_CLOSES.get(child)?.naturalExit === true;
}

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
  options: TransportCloseOptions = {},
): void {
  void beginCodexAppServerTransportClose(child, options).closing;
}

function beginCodexAppServerTransportClose(
  child: CodexAppServerTransport,
  options: TransportCloseOptions,
): TransportClose {
  const current = CODEX_APP_SERVER_TRANSPORT_CLOSES.get(child);
  if (current) {
    return current;
  }
  const closing = (async () => {
    if (hasCodexAppServerTransportExited(child)) {
      return true;
    }
    if (process.platform === "win32" || !child.pid || !child.kill) {
      finishCodexAppServerTransportClose(child, options);
      return false;
    }
    let resumeRoot: (() => void) | undefined;
    try {
      const contained = await terminateCodexAppServerDescendants(child);
      if (contained === "exited") {
        return true;
      }
      resumeRoot = contained;
    } catch {
      resumeRoot = undefined;
    }
    try {
      finishCodexAppServerTransportClose(child, options, resumeRoot);
    } catch {
      signalCodexAppServerTransport(child, "SIGKILL");
    }
    // Descendant termination or stdin EOF can make a launcher exit cleanly.
    // Record cleanup ownership here instead of inferring it from its exit code.
    return false;
  })();
  const closure = { closing, naturalExit: false };
  CODEX_APP_SERVER_TRANSPORT_CLOSES.set(child, closure);
  return closure;
}

function finishCodexAppServerTransportClose(
  child: CodexAppServerTransport,
  options: TransportCloseOptions,
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
    if (!options.drainStdio) {
      child.stdout.destroy?.();
      child.stderr.destroy?.();
    }
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
  options: TransportCloseOptions & { exitTimeoutMs?: number } = {},
): Promise<boolean> {
  const drained = options.drainStdio
    ? Promise.all(
        [child.stdout, child.stderr].map((stream) => finished(stream, { cleanup: true })),
      ).then(
        () => true,
        () => false,
      )
    : undefined;
  const closure = beginCodexAppServerTransportClose(child, options);
  const naturalExit = await closure.closing;
  const settled = await waitForCodexAppServerTransportExit(
    child,
    options.exitTimeoutMs ?? 2_000,
    drained,
  );
  closure.naturalExit = naturalExit && settled;
  if (options.drainStdio) {
    // Share the existing exit budget with pipe draining. A timed-out drain is
    // not a complete natural-exit diagnostic and must not authorize a retry.
    child.stdout.destroy?.();
    child.stderr.destroy?.();
  }
  return settled;
}

function hasCodexAppServerTransportExited(child: CodexAppServerTransport): boolean {
  return child.exitCode !== null && child.exitCode !== undefined
    ? true
    : child.signalCode !== null && child.signalCode !== undefined;
}

async function waitForCodexAppServerTransportExit(
  child: CodexAppServerTransport,
  timeoutMs: number,
  drained?: Promise<boolean>,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.off?.("exit", onExit);
      resolve(exited);
    };
    const onExit = () => {
      if (drained) {
        void drained.then(finish);
      } else {
        finish(true);
      }
    };
    const timeout = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    child.once("exit", onExit);
    if (hasCodexAppServerTransportExited(child)) {
      onExit();
    }
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
