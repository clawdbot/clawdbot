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
const KILL_GRACE_MS = 5_000;

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
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
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
      reject(error);
    };
    const timeout: NodeJS.Timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOutError = timeoutError(
        `${command} ${args.join(" ")} timed out after ${timeoutMs}ms\n${stdout}${stderr}`,
      );
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeoutKillGraceMs);
      killTimer.unref?.();
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
      settled = true;
      clearTimers();
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
