/**
 * MCP tool registration plus redaction helpers for Codex Supervisor sessions
 * and endpoint metadata.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodexSupervisor } from "./supervisor.js";
import type {
  CodexSupervisorEndpoint,
  CodexSupervisorSession,
  CodexSupervisorSessionListResult,
} from "./types.js";

/** Env gate for exposing transcript-derived fields through standalone MCP. */
export const RAW_TRANSCRIPTS_ENV = "OPENCLAW_CODEX_SUPERVISOR_ALLOW_RAW_TRANSCRIPTS";
/** Env gate for mutating/steering Codex sessions through standalone MCP. */
export const WRITE_CONTROLS_ENV = "OPENCLAW_CODEX_SUPERVISOR_ALLOW_WRITE_CONTROLS";

/** Optional policy callbacks for standalone MCP tool exposure. */
export type CodexSupervisorMcpToolOptions = {
  rawTranscriptReadsAllowed?: () => boolean;
  writeControlsAllowed?: () => boolean;
};

function textResult(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function redactString(value: string): string {
  return value
    .replace(/\b(?:sk|glpat|xox[baprs])-[-_a-zA-Z0-9]{12,}\b/g, "[redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs)_[-_a-zA-Z0-9]{12,}\b/g, "[redacted]")
    .replace(/\bBearer\s+[-._~+/a-zA-Z0-9]+=*/g, "Bearer [redacted]");
}

/**
 * Redacts common secret-bearing fields and token-like substrings before tool
 * results leave the supervisor.
 */
export function redactCodexSupervisorValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (/authorization|password|secret|token|api[-_]?key/i.test(key)) {
      return "[redacted]";
    }
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactCodexSupervisorValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
      entryKey,
      redactCodexSupervisorValue(entryValue, entryKey),
    ]),
  );
}

function redactEndpointUrl(value: string): string {
  if (value.startsWith("unix://")) {
    return "unix://";
  }
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    if (url.search) {
      url.search = "?[redacted]";
    }
    return url.toString();
  } catch {
    return "[redacted]";
  }
}

/** Returns endpoint metadata safe for tool results. */
export function redactCodexSupervisorEndpoint(
  endpoint: CodexSupervisorEndpoint,
): Record<string, unknown> {
  return {
    id: endpoint.id,
    transport: endpoint.transport,
    ...(endpoint.label ? { label: endpoint.label } : {}),
    ...(endpoint.transport === "websocket" ? { url: redactEndpointUrl(endpoint.url) } : {}),
  };
}

function rawTranscriptReadsAllowed(): boolean {
  return process.env[RAW_TRANSCRIPTS_ENV] === "1";
}

function writeControlsAllowed(): boolean {
  return process.env[WRITE_CONTROLS_ENV] === "1";
}

function rawTranscriptReadsAllowedFor(opts: CodexSupervisorMcpToolOptions): boolean {
  return opts.rawTranscriptReadsAllowed
    ? opts.rawTranscriptReadsAllowed()
    : rawTranscriptReadsAllowed();
}

function writeControlsAllowedFor(opts: CodexSupervisorMcpToolOptions): boolean {
  return opts.writeControlsAllowed ? opts.writeControlsAllowed() : writeControlsAllowed();
}

function sanitizeSessionForMcp(
  session: CodexSupervisorSession,
  includeTranscriptDerivedFields: boolean,
): Record<string, unknown> {
  const sanitized = redactCodexSupervisorValue(session) as Record<string, unknown>;
  if (!includeTranscriptDerivedFields) {
    delete sanitized.preview;
    delete sanitized.name;
  }
  return sanitized;
}

/**
 * Sanitizes session-list output, optionally including transcript-derived
 * preview/name fields only when the caller has opted in.
 */
export function sanitizeCodexSupervisorSessionListResult(
  result: CodexSupervisorSessionListResult,
  includeTranscriptDerivedFields = rawTranscriptReadsAllowed(),
): Record<string, unknown> {
  return {
    sessions: result.sessions.map((session) =>
      sanitizeSessionForMcp(session, includeTranscriptDerivedFields),
    ),
    errors: includeTranscriptDerivedFields
      ? redactCodexSupervisorValue(result.errors)
      : result.errors.map(({ endpointId, ok }) => ({ endpointId, ok })),
  };
}

/**
 * Registers MCP tools for endpoint probing, session listing, reads, sends, and
 * interrupts.
 */
export function registerCodexSupervisorMcpTools(
  server: McpServer,
  supervisor: CodexSupervisor,
  opts: CodexSupervisorMcpToolOptions = {},
): void {
  server.tool(
    "codex_endpoint_probe",
    "Check configured Codex app-server endpoints.",
    {},
    async () => {
      const endpoints = supervisor.listEndpoints().map(redactCodexSupervisorEndpoint);
      const health = (await supervisor.probeEndpoints()).map(({ endpointId, ok }) => ({
        endpointId,
        ok,
      }));
      return textResult(
        `codex endpoints: ${health.filter((entry) => entry.ok).length}/${health.length} ok`,
        {
          endpoints,
          health,
        },
      );
    },
  );

  server.tool(
    "codex_sessions_list",
    "List Codex sessions visible to the OpenClaw supervisor.",
    {
      include_stored: z.boolean().optional(),
      max_stored_sessions: z.number().int().min(1).max(1000).optional(),
    },
    async ({ include_stored, max_stored_sessions }) => {
      const result = await supervisor.listSessionSnapshot({
        includeStored: include_stored ?? false,
        maxStoredSessions: max_stored_sessions,
      });
      return textResult(
        `codex sessions: ${result.sessions.length}`,
        sanitizeCodexSupervisorSessionListResult(result, rawTranscriptReadsAllowedFor(opts)),
      );
    },
  );

  server.tool(
    "codex_session_read",
    "Read one Codex session transcript from app-server.",
    {
      endpoint_id: z.string().optional(),
      thread_id: z.string().min(1),
      include_turns: z.boolean().optional(),
    },
    async ({ endpoint_id, thread_id, include_turns }) => {
      if (!rawTranscriptReadsAllowedFor(opts)) {
        return errorResult(
          `Codex session reads are disabled; set ${RAW_TRANSCRIPTS_ENV}=1 for a trusted supervisor-only MCP`,
        );
      }
      const includeTurns = include_turns ?? false;
      try {
        const response = await supervisor.readSession({
          endpointId: endpoint_id,
          threadId: thread_id,
          includeTurns,
        });
        return textResult(`codex session: ${thread_id}`, {
          response: redactCodexSupervisorValue(response),
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.tool(
    "codex_session_send",
    "Send text to a Codex session. Idle sessions start a turn; active sessions are steered.",
    {
      endpoint_id: z.string().optional(),
      thread_id: z.string().min(1),
      text: z.string().min(1),
      mode: z.enum(["auto", "start", "steer"]).optional(),
    },
    async ({ endpoint_id, thread_id, text, mode }) => {
      if (!writeControlsAllowedFor(opts)) {
        return errorResult(
          `Codex write controls are disabled; set ${WRITE_CONTROLS_ENV}=1 for a trusted supervisor-only MCP`,
        );
      }
      try {
        const result = await supervisor.sendToSession({
          endpointId: endpoint_id,
          threadId: thread_id,
          text,
          mode,
        });
        return textResult(`codex ${result.mode}: ${result.turnId ?? thread_id}`, { result });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.tool(
    "codex_session_interrupt",
    "Interrupt an active Codex turn.",
    {
      endpoint_id: z.string().optional(),
      thread_id: z.string().min(1),
      turn_id: z.string().optional(),
    },
    async ({ endpoint_id, thread_id, turn_id }) => {
      if (!writeControlsAllowedFor(opts)) {
        return errorResult(
          `Codex write controls are disabled; set ${WRITE_CONTROLS_ENV}=1 for a trusted supervisor-only MCP`,
        );
      }
      try {
        const result = await supervisor.interruptSession({
          endpointId: endpoint_id,
          threadId: thread_id,
          turnId: turn_id,
        });
        return textResult(`codex interrupted: ${result.turnId}`, { result });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );
}
