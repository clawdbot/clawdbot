import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  resumeToolRequest as embeddedResumeToolRequest,
  runToolRequest as embeddedRunToolRequest,
} from "@clawdbot/lobster/core";

export type LobsterEnvelope =
  | {
      ok: true;
      status: "ok" | "needs_approval" | "cancelled";
      output: unknown[];
      requiresApproval: null | {
        type: "approval_request";
        prompt: string;
        items: unknown[];
        resumeToken?: string;
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
  approve?: boolean;
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
  registry?: unknown;
  llmAdapters?: Record<string, unknown>;
};

type EmbeddedToolEnvelope = {
  protocolVersion?: number;
  ok: boolean;
  status?: "ok" | "needs_approval" | "needs_input" | "cancelled";
  output?: unknown[];
  requiresApproval?: {
    type?: "approval_request";
    prompt: string;
    items: unknown[];
    preview?: string;
    resumeToken?: string;
  } | null;
  requiresInput?: {
    prompt: string;
    schema?: unknown;
    items?: unknown[];
    resumeToken?: string;
    approvalId?: string;
  } | null;
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

type LoadEmbeddedToolRuntime = () => Promise<EmbeddedToolRuntime>;

function normalizeForCwdSandbox(p: string): string {
  const normalized = path.normalize(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

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

  const rel = path.relative(normalizeForCwdSandbox(base), normalizeForCwdSandbox(resolved));
  if (rel === "" || rel === ".") {
    return resolved;
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
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

function normalizeEnvelope(envelope: EmbeddedToolEnvelope): LobsterEnvelope {
  if (envelope.ok) {
    if (envelope.status === "needs_input") {
      return {
        ok: false,
        error: {
          type: "unsupported_status",
          message: "Lobster input requests are not supported by the OpenClaw Lobster tool yet",
        },
      };
    }
    return {
      ok: true,
      status: envelope.status ?? "ok",
      output: Array.isArray(envelope.output) ? envelope.output : [],
      requiresApproval: envelope.requiresApproval
        ? {
            type: "approval_request",
            prompt: envelope.requiresApproval.prompt,
            items: envelope.requiresApproval.items,
            ...(envelope.requiresApproval.resumeToken
              ? { resumeToken: envelope.requiresApproval.resumeToken }
              : {}),
          }
        : null,
    };
  }
  return {
    ok: false,
    error: {
      type: envelope.error?.type,
      message: envelope.error?.message ?? "lobster runtime failed",
    },
  };
}

function throwOnErrorEnvelope(envelope: LobsterEnvelope): Extract<LobsterEnvelope, { ok: true }> {
  if (envelope.ok) {
    return envelope;
  }
  throw new Error(envelope.error.message);
}

async function resolveWorkflowFile(candidate: string, cwd: string) {
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) {
    throw new Error("Workflow path is not a file");
  }
  const ext = path.extname(resolved).toLowerCase();
  if (![".lobster", ".yaml", ".yml", ".json"].includes(ext)) {
    throw new Error("Workflow file must end in .lobster, .yaml, .yml, or .json");
  }
  return resolved;
}

async function detectWorkflowFile(candidate: string, cwd: string) {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.includes("|")) {
    return null;
  }
  try {
    return await resolveWorkflowFile(trimmed, cwd);
  } catch {
    return null;
  }
}

function parseWorkflowArgs(argsJson: string) {
  return JSON.parse(argsJson) as Record<string, unknown>;
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
  fn: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = Math.max(200, timeoutMs);
  const controller = new AbortController();
  return await new Promise<T>((resolve, reject) => {
    const onTimeout = () => {
      const error = new Error("lobster runtime timed out");
      controller.abort(error);
      reject(error);
    };

    const timer = setTimeout(onTimeout, timeout);
    void fn(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function loadEmbeddedToolRuntimeFromPackage(): Promise<EmbeddedToolRuntime> {
  return {
    runToolRequest: embeddedRunToolRequest,
    resumeToolRequest: embeddedResumeToolRequest,
  };
}

export function createEmbeddedLobsterRunner(options?: {
  loadRuntime?: LoadEmbeddedToolRuntime;
}): LobsterRunner {
  const loadRuntime = options?.loadRuntime ?? loadEmbeddedToolRuntimeFromPackage;
  let runtimePromise: Promise<EmbeddedToolRuntime> | undefined;
  return {
    async run(params) {
      runtimePromise ??= loadRuntime();
      const runtime = await runtimePromise;
      return await withTimeout(params.timeoutMs, async (signal) => {
        const ctx = createEmbeddedToolContext(params, signal);

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
                args = parseWorkflowArgs(parsedArgsJson);
              } catch {
                throw new Error("run --args-json must be valid JSON");
              }
            }
            return throwOnErrorEnvelope(
              normalizeEnvelope(await runtime.runToolRequest({ filePath, args, ctx })),
            );
          }

          return throwOnErrorEnvelope(
            normalizeEnvelope(await runtime.runToolRequest({ pipeline, ctx })),
          );
        }

        const token = params.token?.trim() ?? "";
        if (!token) {
          throw new Error("token required");
        }
        if (typeof params.approve !== "boolean") {
          throw new Error("approve required");
        }

        return throwOnErrorEnvelope(
          normalizeEnvelope(
            await runtime.resumeToolRequest({
              token,
              approved: params.approve,
              ctx,
            }),
          ),
        );
      });
    },
  };
}
