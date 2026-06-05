// Telegram User Credential Io script supports OpenClaw repository automation.
import { spawn } from "node:child_process";
import { readBoundedResponseText } from "../lib/bounded-response.ts";

export type JsonObject = Record<string, unknown>;

type FetchJsonParams = {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  init: RequestInit;
  label: string;
  maxBodyBytes?: number;
  timeoutMs: number;
  url: string;
};

type RunCommandOptions = {
  outputLimit?: number;
  timeoutKillGraceMs?: number;
  timeoutMs: number;
};

const DEFAULT_OUTPUT_LIMIT = 128 * 1024;
const DEFAULT_FETCH_BODY_LIMIT = 1024 * 1024;
const KILL_GRACE_MS = readKillGraceMs();
const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};
const ACTIVE_CHILD_TREE_KILLERS = new Set<(signal: NodeJS.Signals) => void>();
let forwardedSignalExitCode: number | undefined;
let forwardedSignalForceKillTimer: NodeJS.Timeout | undefined;

function readKillGraceMs() {
  const raw = process.env.OPENCLAW_QA_CREDENTIAL_KILL_GRACE_MS?.trim();
  if (!raw) {
    return 5_000;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(
      `OPENCLAW_QA_CREDENTIAL_KILL_GRACE_MS must be a non-negative integer; got: ${raw}`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `OPENCLAW_QA_CREDENTIAL_KILL_GRACE_MS must be a non-negative integer; got: ${raw}`,
    );
  }
  return parsed;
}

function finishForwardedSignalIfIdle() {
  if (forwardedSignalExitCode === undefined || ACTIVE_CHILD_TREE_KILLERS.size > 0) {
    return;
  }
  if (forwardedSignalForceKillTimer) {
    clearTimeout(forwardedSignalForceKillTimer);
    forwardedSignalForceKillTimer = undefined;
  }
  process.exit(forwardedSignalExitCode);
}

for (const signal of Object.keys(SIGNAL_EXIT_CODES) as Array<keyof typeof SIGNAL_EXIT_CODES>) {
  process.on(signal, () => {
    forwardedSignalExitCode ??= SIGNAL_EXIT_CODES[signal];
    if (ACTIVE_CHILD_TREE_KILLERS.size === 0) {
      finishForwardedSignalIfIdle();
      return;
    }
    const activeKillers = Array.from(ACTIVE_CHILD_TREE_KILLERS);
    for (const killChildTree of activeKillers) {
      killChildTree(signal);
    }
    forwardedSignalForceKillTimer ??= setTimeout(() => {
      for (const killChildTree of activeKillers) {
        killChildTree("SIGKILL");
      }
      process.exit(forwardedSignalExitCode);
    }, KILL_GRACE_MS);
  });
}

function timeoutError(message: string) {
  return Object.assign(new Error(message), { code: "ETIMEDOUT" });
}

function bodyTooLargeError(message: string) {
  return Object.assign(new Error(message), { code: "ETOOBIG" });
}

function resolveFetchBodyLimit(limit: number | undefined) {
  if (limit !== undefined) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`fetch JSON body limit must be a positive integer; got: ${limit}`);
    }
    return limit;
  }
  const raw = process.env.OPENCLAW_QA_CREDENTIAL_HTTP_MAX_BODY_BYTES?.trim();
  if (!raw) {
    return DEFAULT_FETCH_BODY_LIMIT;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(
      `OPENCLAW_QA_CREDENTIAL_HTTP_MAX_BODY_BYTES must be a positive integer; got: ${raw}`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `OPENCLAW_QA_CREDENTIAL_HTTP_MAX_BODY_BYTES must be a positive integer; got: ${raw}`,
    );
  }
  return parsed;
}

function appendBounded(previous: string, chunk: Buffer, limit: number) {
  const next = previous + chunk.toString();
  if (next.length <= limit) {
    return next;
  }
  return next.slice(next.length - limit);
}

export function runCommand(
  command: string,
  args: string[],
  cwd: string | undefined,
  options: RunCommandOptions,
) {
  return new Promise<void>((resolve, reject) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: useProcessGroup,
    });
    const activeChildTree = registerActiveChildProcessTree(child);
    const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let pendingTimeoutReject: (() => void) | undefined;
    let timedOutError: Error | undefined;
    const timeoutMs = Math.max(1, options.timeoutMs);
    const timeoutKillGraceMs = Math.max(0, options.timeoutKillGraceMs ?? KILL_GRACE_MS);
    const clearTimers = () => {
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      activeChildTree.unregister();
      reject(error);
    };
    const timeout: NodeJS.Timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOutError = timeoutError(
        `${command} ${args.join(" ")} timed out after ${timeoutMs}ms\n${stdout}${stderr}`,
      );
      activeChildTree.killChildTree("SIGTERM");
      killTimer = setTimeout(() => {
        killTimer = undefined;
        activeChildTree.killChildTree("SIGKILL");
        pendingTimeoutReject?.();
      }, timeoutKillGraceMs);
    }, timeoutMs);
    timeout.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk, outputLimit);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk, outputLimit);
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      if (forwardedSignalExitCode !== undefined) {
        activeChildTree.unregister({
          finishForwardedSignal: !childProcessTreeMayStillExist(child),
        });
        return;
      }
      if (timedOutError && killTimer && childProcessTreeMayStillExist(child)) {
        const error = timedOutError;
        pendingTimeoutReject = () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimers();
          activeChildTree.unregister();
          reject(error);
        };
        return;
      }
      settled = true;
      clearTimers();
      activeChildTree.unregister();
      if (timedOutError) {
        reject(timedOutError);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(new Error(`${command} ${args.join(" ")} failed with ${detail}\n${stdout}${stderr}`));
    });
  });
}

function signalChildProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group can disappear between timeout and cleanup.
    }
  }
  child.kill(signal);
}

function childProcessTreeMayStillExist(child: ReturnType<typeof spawn>) {
  if (process.platform === "win32" || !child.pid) {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function registerActiveChildProcessTree(child: ReturnType<typeof spawn>) {
  const killChildTree = (signal: NodeJS.Signals) => signalChildProcessTree(child, signal);
  ACTIVE_CHILD_TREE_KILLERS.add(killChildTree);
  return {
    killChildTree,
    unregister: (options: { finishForwardedSignal?: boolean } = {}) => {
      ACTIVE_CHILD_TREE_KILLERS.delete(killChildTree);
      if (options.finishForwardedSignal ?? true) {
        finishForwardedSignalIfIdle();
      }
    },
  };
}

export async function fetchJsonWithTimeout(params: FetchJsonParams) {
  const timeoutMs = Math.max(1, params.timeoutMs);
  const maxBodyBytes = resolveFetchBodyLimit(params.maxBodyBytes);
  const controller = new AbortController();
  const error = timeoutError(`${params.label} timed out after ${timeoutMs}ms`);
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    const response = await Promise.race([
      (params.fetchImpl ?? fetch)(params.url, {
        ...params.init,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    const rawPayload = await readBoundedResponseText(response, params.label, maxBodyBytes, {
      createTooLargeError: bodyTooLargeError,
      timeoutPromise,
    });
    const payload = JSON.parse(rawPayload) as JsonObject;
    return { payload, response };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
