// Lobster plugin module implements lobster runner behavior.
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";

type LobsterInputRequest = {
  type: "input_request";
  prompt: string;
  responseSchema: unknown;
  defaults?: unknown;
  subject?: unknown;
  resumeToken: string;
};

export class LobsterRunnerError extends Error {
  constructor(
    message: string,
    readonly type?: string,
  ) {
    super(message);
    this.name = "LobsterRunnerError";
  }
}

export type LobsterEnvelope =
  | {
      ok: true;
      status: "ok" | "needs_approval" | "needs_input" | "cancelled";
      output: unknown[];
      requiresInput?: LobsterInputRequest;
      requiresApproval: null | {
        type: "approval_request";
        prompt: string;
        items: unknown[];
        resumeToken?: string;
        approvalId?: string;
      };
    }
  | {
      ok: false;
      error: { type?: string; message: string };
    };

export type LobsterRunnerParams = {
  action: "run" | "resume";
  pipeline?: string;
  argsJson?: string;
  token?: string;
  approvalId?: string;
  approve?: boolean;
  response?: unknown;
  cancel?: boolean;
  /** Cancellation from the calling agent turn or direct tool request. */
  signal?: AbortSignal;
  /** Revalidate a managed flow's claim after async preparation, before runtime I/O. */
  beforeExecute?: () => void;
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
};

export type LobsterRunner = {
  run: (params: LobsterRunnerParams) => Promise<LobsterEnvelope>;
};

type EmbeddedToolContext = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  mode?: "tool" | "human" | "sdk";
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  signal?: AbortSignal;
};

type EmbeddedToolEnvelope = {
  ok: boolean;
  status?: "ok" | "needs_approval" | "needs_input" | "cancelled";
  output?: unknown[];
  requiresApproval?: {
    prompt: string;
    items: unknown[];
    resumeToken?: string;
    approvalId?: string;
  } | null;
  requiresInput?: Omit<LobsterInputRequest, "type"> | null;
  error?: {
    type?: string;
    message: string;
  };
};

type EmbeddedToolRuntime = {
  runToolRequest: (params: {
    pipeline?: string;
    filePath?: string;
    args?: Record<string, unknown>;
    ctx?: EmbeddedToolContext;
  }) => Promise<EmbeddedToolEnvelope>;
  resumeToolRequest: (params: {
    token?: string;
    approvalId?: string;
    approved?: boolean;
    response?: unknown;
    cancel?: boolean;
    ctx?: EmbeddedToolContext;
  }) => Promise<EmbeddedToolEnvelope>;
};

const workflowExts = new Set([".lobster", ".yaml", ".yml", ".json"]);

export function resolveLobsterCwd(cwdRaw: unknown): string {
  if (typeof cwdRaw !== "string" || !cwdRaw.trim()) {
    return process.cwd();
  }
  const cwd = cwdRaw.trim();
  if (path.isAbsolute(cwd)) {
    throw new Error("cwd must be a relative path");
  }
  const base = process.cwd();
  const resolved = path.resolve(base, cwd);

  if (!isPathInside(base, resolved)) {
    throw new Error("cwd must stay within the gateway working directory");
  }
  return resolved;
}

function createLimitedSink(maxBytes: number, label: "stdout" | "stderr") {
  let bytes = 0;
  return new Writable({
    write(chunk, _encoding, callback) {
      bytes += Buffer.byteLength(String(chunk), "utf8");
      if (bytes > maxBytes) {
        callback(new Error(`lobster ${label} exceeded maxStdoutBytes`));
        return;
      }
      callback();
    },
  });
}

function normalizeEnvelope(envelope: EmbeddedToolEnvelope): Extract<LobsterEnvelope, { ok: true }> {
  if (!envelope.ok) {
    throw new LobsterRunnerError(
      envelope.error?.message ?? "lobster runtime failed",
      envelope.error?.type,
    );
  }
  if (
    envelope.status === "needs_input" &&
    (!envelope.requiresInput?.resumeToken ||
      typeof envelope.requiresInput.prompt !== "string" ||
      envelope.requiresInput.responseSchema === undefined)
  ) {
    throw new Error("Lobster returned an incomplete input checkpoint");
  }
  return {
    ok: true,
    status: envelope.status ?? "ok",
    output: Array.isArray(envelope.output) ? envelope.output : [],
    ...(envelope.status === "needs_input" && envelope.requiresInput
      ? { requiresInput: { ...envelope.requiresInput, type: "input_request" as const } }
      : {}),
    requiresApproval: envelope.requiresApproval
      ? {
          type: "approval_request",
          prompt: envelope.requiresApproval.prompt,
          items: envelope.requiresApproval.items,
          ...(envelope.requiresApproval.resumeToken
            ? { resumeToken: envelope.requiresApproval.resumeToken }
            : {}),
          ...(envelope.requiresApproval.approvalId
            ? { approvalId: envelope.requiresApproval.approvalId }
            : {}),
        }
      : null,
  };
}

function isMissingPathError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function detectWorkflowFile(candidate: string, cwd: string) {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.includes("|") || !workflowExts.has(path.extname(trimmed).toLowerCase())) {
    return null;
  }
  const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
  try {
    if (!(await stat(resolved)).isFile()) {
      throw new Error("Workflow path is not a file");
    }
    return resolved;
  } catch (error) {
    if (/\s/.test(trimmed) && isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

function createEmbeddedToolContext(
  params: LobsterRunnerParams,
  signal?: AbortSignal,
): EmbeddedToolContext {
  const env = { ...process.env } as Record<string, string | undefined>;
  return {
    cwd: params.cwd,
    env,
    mode: "tool",
    stdin: Readable.from([]),
    stdout: createLimitedSink(Math.max(1024, params.maxStdoutBytes), "stdout"),
    stderr: createLimitedSink(Math.max(1024, params.maxStdoutBytes), "stderr"),
    signal,
  };
}

async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const timeout = Math.max(200, timeoutMs);
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onTimeout = () => {
      const error = new Error("lobster runtime timed out");
      controller.abort(error);
      reject(error);
    };

    const timer = setTimeout(onTimeout, timeout);
    void fn(signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(toLintErrorObject(error, "Non-Error rejection"));
      },
    );
  });
}

async function loadEmbeddedToolRuntimeFromPackage(): Promise<EmbeddedToolRuntime> {
  // Joined specifier keeps bundlers from statically resolving
  // @clawdbot/lobster/core; the plugin's declared @clawdbot/lobster dependency
  // provides it at runtime, so it is a used direct dependency.
  const coreSpecifier = ["@clawdbot", "lobster", "core"].join("/");
  return (await import(coreSpecifier)) as EmbeddedToolRuntime;
}

export function createEmbeddedLobsterRunner(options?: {
  loadRuntime?: () => Promise<EmbeddedToolRuntime>;
}): LobsterRunner {
  const loadRuntime = options?.loadRuntime ?? loadEmbeddedToolRuntimeFromPackage;
  let runtimePromise: Promise<EmbeddedToolRuntime> | undefined;
  return {
    async run(params) {
      params.signal?.throwIfAborted();
      runtimePromise ??= loadRuntime();
      const runtime = await runtimePromise;
      return await withTimeout(
        params.timeoutMs,
        async (signal) => {
          const ctx = createEmbeddedToolContext(params, signal);
          let envelope: EmbeddedToolEnvelope;

          if (params.action === "run") {
            const pipeline = params.pipeline?.trim() ?? "";
            if (!pipeline) {
              throw new Error("pipeline required");
            }

            const filePath = await detectWorkflowFile(pipeline, params.cwd);
            if (filePath) {
              const parsedArgsJson = params.argsJson?.trim() ?? "";
              let args: Record<string, unknown> | undefined;
              if (parsedArgsJson) {
                try {
                  args = JSON.parse(parsedArgsJson) as Record<string, unknown>;
                } catch {
                  throw new Error("run --args-json must be valid JSON");
                }
              }
              signal.throwIfAborted();
              params.beforeExecute?.();
              envelope = await runtime.runToolRequest({ filePath, args, ctx });
            } else {
              signal.throwIfAborted();
              params.beforeExecute?.();
              envelope = await runtime.runToolRequest({ pipeline, ctx });
            }
          } else {
            const token = params.token?.trim() ?? "";
            const approvalId = params.approvalId?.trim() ?? "";
            if (!token && !approvalId) {
              throw new Error("token or approvalId required");
            }
            const decisions =
              Number(typeof params.approve === "boolean") +
              Number(params.response !== undefined) +
              Number(params.cancel === true);
            if (decisions !== 1) {
              throw new Error("Exactly one of approve, response, or cancel required");
            }
            signal.throwIfAborted();
            params.beforeExecute?.();
            envelope = await runtime.resumeToolRequest({
              ...(token ? { token } : {}),
              ...(approvalId ? { approvalId } : {}),
              ...(params.approve !== undefined ? { approved: params.approve } : {}),
              ...(params.response !== undefined ? { response: params.response } : {}),
              ...(params.cancel === true ? { cancel: true } : {}),
              ctx,
            });
          }
          return normalizeEnvelope(envelope);
        },
        params.signal,
      );
    },
  };
}
