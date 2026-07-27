import { spawn } from "node:child_process";
import os from "node:os";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import { appendBoundedTextTail, SESSION_TOOL_STDERR_TAIL_BYTES } from "./sessions/tools/limits.js";
import { TOOL_SEARCH_CODE_MODE_CHILD_SOURCE } from "./tool-search-code-mode-child.js";
import { toToolSearchJsonSafe } from "./tool-search-json.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import type {
  CodeModeBridgeMethod,
  CodeModeBridgeResultMessage,
  CodeModeChildMessage,
  ToolSearchConfig,
  ToolSearchToolContext,
} from "./tool-search-types.js";
import { asToolParamsRecord, ToolInputError } from "./tools/common.js";

export async function runCodeMode(params: {
  toolCallId: string;
  ctx: ToolSearchToolContext;
  code: string;
  config: ToolSearchConfig;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) {
  const runtime = new ToolSearchRuntime(params.ctx, params.config);
  const logs: string[] = [];
  const value = await runCodeModeChild({
    code: params.code,
    config: params.config,
    logs,
    parentToolCallId: params.toolCallId,
    runtime,
    signal: params.signal,
    onUpdate: params.onUpdate,
  });
  return {
    ok: true,
    value: toToolSearchJsonSafe(value),
    logs,
    telemetry: runtime.telemetry(),
  };
}

function buildCodeModeChildArgs(): string[] {
  if (!process.allowedNodeEnvironmentFlags.has("--permission")) {
    throw new ToolInputError("tool_search_code requires a Node runtime with --permission support.");
  }
  return ["--permission", "--input-type=module", "--eval", TOOL_SEARCH_CODE_MODE_CHILD_SOURCE];
}

function isCodeModeBridgeMethod(value: unknown): value is CodeModeBridgeMethod {
  return value === "search" || value === "describe" || value === "call";
}

async function runCodeModeBridgeRequest(
  runtime: ToolSearchRuntime,
  method: CodeModeBridgeMethod,
  args: unknown,
  options?: {
    parentToolCallId?: string;
    signal?: AbortSignal;
    onUpdate?: AgentToolUpdateCallback;
  },
): Promise<unknown> {
  const values = Array.isArray(args) ? args : [];
  switch (method) {
    case "search": {
      const query = values[0];
      if (typeof query !== "string") {
        throw new ToolInputError("search query must be a string.");
      }
      const optionsLocal = isRecord(values[1]) ? values[1] : undefined;
      return await runtime.search(query, {
        limit: typeof optionsLocal?.limit === "number" ? optionsLocal.limit : undefined,
      });
    }
    case "describe": {
      const id = values[0];
      if (typeof id !== "string") {
        throw new ToolInputError("describe id must be a string.");
      }
      return await runtime.describe(id, { recoverySurface: "code-mode" });
    }
    case "call": {
      const id = values[0];
      if (typeof id !== "string") {
        throw new ToolInputError("call id must be a string.");
      }
      return await runtime.call(id, values[1] ?? {}, {
        ...options,
        recoverySurface: "code-mode",
      });
    }
  }
  throw new ToolInputError("Unsupported tool_search_code bridge method.");
}

export function appendToolSearchCodeStderrTail(current: string, chunk: string): string {
  return appendBoundedTextTail(current, chunk, SESSION_TOOL_STDERR_TAIL_BYTES);
}

export function runCodeModeChild(params: {
  code: string;
  config: ToolSearchConfig;
  logs: string[];
  parentToolCallId: string;
  runtime: ToolSearchRuntime;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, buildCodeModeChildArgs(), {
      cwd: os.tmpdir(),
      env: {},
      // The worker returns logs/results over IPC and never writes stdout.
      // Ignore it so an unused pipe cannot fill or surface unhandled errors.
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderrTail = "";
    let settled = false;
    let timedOut = false;
    let exitRejectionTimer: ReturnType<typeof setTimeout> | undefined;
    const bridgeAbortController = new AbortController();
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (exitRejectionTimer) {
        clearTimeout(exitRejectionTimer);
      }
      params.signal?.removeEventListener("abort", abortFromParent);
      child.kill();
      callback();
    };
    const abortFromParent: () => void = () => {
      bridgeAbortController.abort(params.signal?.reason);
      child.kill("SIGKILL");
      settle(() => reject(new Error("tool_search_code aborted")));
    };
    const timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timedOut = true;
      bridgeAbortController.abort(new Error("tool_search_code timed out"));
      child.kill("SIGKILL");
      settle(() => reject(new Error("tool_search_code timed out")));
    }, params.config.codeTimeoutMs);
    params.signal?.addEventListener("abort", abortFromParent, { once: true });
    if (params.signal?.aborted) {
      abortFromParent();
      return;
    }

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = appendToolSearchCodeStderrTail(stderrTail, chunk);
    });
    child.stderr?.on("error", (error) => {
      settle(() => reject(error));
    });
    child.on("error", (error) => {
      settle(() => reject(error));
    });
    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }
      const rejectOnExit = () => {
        const suffix = stderrTail.trim();
        const detail = suffix ? `: ${sliceUtf16Safe(suffix, -500)}` : "";
        settle(() =>
          reject(
            new Error(
              timedOut
                ? "tool_search_code timed out"
                : `tool_search_code child exited with ${signal ?? code}${detail}`,
            ),
          ),
        );
      };
      if (code === 0 && signal === null) {
        // A clean exit can race the final IPC result.
        exitRejectionTimer = setTimeout(rejectOnExit, 250);
        return;
      }
      rejectOnExit();
    });
    child.on("message", (message: CodeModeChildMessage) => {
      if (settled || !isRecord(message) || typeof message.type !== "string") {
        return;
      }
      if (message.type === "log") {
        const items = Array.isArray(message.items) ? message.items : [];
        params.logs.push(items.map((item) => String(item)).join(" "));
        return;
      }
      if (message.type === "result") {
        if (message.ok) {
          settle(() => resolve(message.value));
        } else {
          settle(() =>
            reject(new Error(typeof message.error === "string" ? message.error : "code failed")),
          );
        }
        return;
      }
      if (message.type !== "bridge") {
        return;
      }
      const id = typeof message.id === "string" ? message.id : "";
      const method = isCodeModeBridgeMethod(message.method) ? message.method : undefined;
      if (!id || !method) {
        return;
      }
      void runCodeModeBridgeRequest(params.runtime, method, message.args, {
        parentToolCallId: params.parentToolCallId,
        signal: bridgeAbortController.signal,
        onUpdate: params.onUpdate,
      })
        .then((value) => {
          if (settled || !child.connected) {
            return;
          }
          const response: CodeModeBridgeResultMessage = {
            type: "bridge-result",
            id,
            ok: true,
            value: toToolSearchJsonSafe(value),
          };
          child.send(response, () => undefined);
        })
        .catch((error: unknown) => {
          if (settled || !child.connected) {
            return;
          }
          const response: CodeModeBridgeResultMessage = {
            type: "bridge-result",
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
          child.send(response, () => undefined);
        });
    });

    child.send({ type: "run", code: params.code, timeoutMs: params.config.codeTimeoutMs });
  });
}

export function readToolSearchCode(args: unknown): string {
  const params = asToolParamsRecord(args);
  const code = params.code;
  if (typeof code !== "string" || !code.trim()) {
    throw new ToolInputError("code must be a non-empty string.");
  }
  return code;
}
