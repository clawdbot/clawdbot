// Tokenjuice plugin module implements tool result middleware behavior.
import process from "node:process";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareEvent,
  OpenClawAgentToolResult,
} from "openclaw/plugin-sdk/agent-harness";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createTokenjuiceOpenClawEmbeddedExtension } from "./runtime-api.js";

type TokenjuiceToolResultHandler = (
  event: {
    toolName: string;
    input: Record<string, unknown>;
    content: OpenClawAgentToolResult["content"];
    details: unknown;
    isError?: boolean;
  },
  ctx: { cwd: string },
) => Promise<Partial<OpenClawAgentToolResult> | void> | Partial<OpenClawAgentToolResult> | void;

function normalizeDetails(
  event: AgentToolResultMiddlewareEvent,
  current: OpenClawAgentToolResult,
): unknown {
  if (
    (event.toolName !== "exec" && event.toolName !== "bash") ||
    typeof event.args.command !== "string" ||
    !event.args.command
  ) {
    return current.details;
  }
  const metadata = isRecord(current.details) ? { ...current.details } : {};
  // Tokenjuice reads text content when `aggregated` is absent, then merges details
  // into its response. Drop the duplicate raw copy or compaction can exceed host limits.
  delete metadata.aggregated;
  // A concrete status is already canonical. Other terminal hints are preserved below
  // while supplying only the completed/failed status Tokenjuice requires.
  if (typeof metadata.status === "string" && metadata.status.trim()) {
    return metadata;
  }
  const rawExitCode = metadata.exitCode;
  const failed =
    event.isError === true ||
    metadata.ok === false ||
    metadata.success === false ||
    metadata.timedOut === true ||
    Boolean(metadata.error) ||
    (typeof rawExitCode === "number" && Number.isFinite(rawExitCode) && rawExitCode !== 0);
  const exitCode =
    typeof rawExitCode === "number" && Number.isFinite(rawExitCode) ? rawExitCode : failed ? 1 : 0;
  return {
    ...metadata,
    status: failed ? "failed" : "completed",
    exitCode,
  };
}

export function createTokenjuiceAgentToolResultMiddleware(): AgentToolResultMiddleware {
  const handlers: TokenjuiceToolResultHandler[] = [];
  createTokenjuiceOpenClawEmbeddedExtension()({
    on(event, handler) {
      if (event === "tool_result") {
        handlers.push(handler as TokenjuiceToolResultHandler);
      }
    },
  });

  return async (event) => {
    let current = event.result;
    const workdir = event.args.workdir;
    const cwd = event.cwd?.trim()
      ? event.cwd
      : typeof workdir === "string" && workdir.trim()
        ? workdir
        : process.cwd();
    for (const handler of handlers) {
      const next = await handler(
        {
          toolName: event.toolName,
          input: event.args,
          content: current.content,
          details: normalizeDetails(event, current),
          isError: event.isError,
        },
        { cwd },
      );
      if (next) {
        current = Object.assign({}, current, {
          content: next.content ?? current.content,
          details: next.details ?? current.details,
        });
      }
    }
    return current === event.result ? undefined : { result: current };
  };
}
