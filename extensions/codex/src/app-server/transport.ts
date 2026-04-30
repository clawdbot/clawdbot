export type CodexAppServerTransport = {
  stdin: {
    write: (data: string, callback?: (error?: Error | null) => void) => unknown;
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

export function closeCodexAppServerTransport(
  child: CodexAppServerTransport,
  options: { forceKillDelayMs?: number } = {},
): void {
  child.stdout.destroy?.();
  child.stderr.destroy?.();
  child.stdin.end?.();
  child.stdin.destroy?.();
  signalCodexAppServerTransport(child, "SIGTERM");
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
  child.once("exit", () => clearTimeout(forceKill));
  child.unref?.();
  child.stdout.unref?.();
  child.stderr.unref?.();
  child.stdin.unref?.();
}

export async function closeCodexAppServerTransportAndWait(
  child: CodexAppServerTransport,
  options: { exitTimeoutMs?: number; forceKillDelayMs?: number } = {},
): Promise<boolean> {
  if (!hasCodexAppServerTransportExited(child)) {
    closeCodexAppServerTransport(child, options);
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
    timeout.unref?.();
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
