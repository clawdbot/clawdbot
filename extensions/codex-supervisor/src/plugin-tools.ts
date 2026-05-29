import { jsonResult, readStringParam, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import {
  redactCodexSupervisorEndpoint,
  redactCodexSupervisorValue,
  sanitizeCodexSupervisorSessionListResult,
} from "./mcp-tools.js";
import type { CodexSupervisor } from "./supervisor.js";
import type { CodexSupervisorTurnMode } from "./types.js";

const EmptyParamsSchema = Type.Object({}, { additionalProperties: false });

const SessionsListParamsSchema = Type.Object(
  {
    include_stored: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const SessionReadParamsSchema = Type.Object(
  {
    endpoint_id: Type.Optional(Type.String()),
    thread_id: Type.String(),
    include_turns: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const SessionSendParamsSchema = Type.Object(
  {
    endpoint_id: Type.Optional(Type.String()),
    thread_id: Type.String(),
    text: Type.String(),
    mode: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("start"), Type.Literal("steer")]),
    ),
  },
  { additionalProperties: false },
);

const SessionInterruptParamsSchema = Type.Object(
  {
    endpoint_id: Type.Optional(Type.String()),
    thread_id: Type.String(),
    turn_id: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type CodexSupervisorToolPolicy = {
  allowRawTranscripts: boolean;
  allowWriteControls: boolean;
};

export type CodexSupervisorToolOptions = {
  supervisor: CodexSupervisor;
  policy: CodexSupervisorToolPolicy;
};

function asRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function readBooleanParam(params: Record<string, unknown>, key: string): boolean {
  return params[key] === true;
}

function readModeParam(params: Record<string, unknown>): CodexSupervisorTurnMode | undefined {
  const mode = readStringParam(params, "mode");
  if (!mode) {
    return undefined;
  }
  if (mode === "auto" || mode === "start" || mode === "steer") {
    return mode;
  }
  throw new Error("mode must be auto, start, or steer");
}

function requireRawTranscriptAccess(policy: CodexSupervisorToolPolicy): void {
  if (!policy.allowRawTranscripts) {
    throw new Error("Codex session reads are disabled for this codex-supervisor plugin config.");
  }
}

function requireWriteAccess(policy: CodexSupervisorToolPolicy): void {
  if (!policy.allowWriteControls) {
    throw new Error("Codex write controls are disabled for this codex-supervisor plugin config.");
  }
}

export function createCodexSupervisorTools({
  supervisor,
  policy,
}: CodexSupervisorToolOptions): AnyAgentTool[] {
  return [
    {
      name: "codex_endpoint_probe",
      label: "Codex Endpoint Probe",
      description: "Check configured Codex app-server endpoints.",
      parameters: EmptyParamsSchema,
      execute: async () => {
        const endpoints = supervisor.listEndpoints().map(redactCodexSupervisorEndpoint);
        const health = (await supervisor.probeEndpoints()).map(({ endpointId, ok }) => ({
          endpointId,
          ok,
        }));
        return jsonResult({
          summary: `codex endpoints: ${health.filter((entry) => entry.ok).length}/${health.length} ok`,
          endpoints,
          health,
        });
      },
    },
    {
      name: "codex_sessions_list",
      label: "Codex Sessions List",
      description: "List Codex sessions visible to the OpenClaw supervisor.",
      parameters: SessionsListParamsSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = asRecord(rawParams);
        const result = await supervisor.listSessionSnapshot({
          includeStored: readBooleanParam(params, "include_stored"),
        });
        return jsonResult({
          summary: `codex sessions: ${result.sessions.length}`,
          ...sanitizeCodexSupervisorSessionListResult(result, policy.allowRawTranscripts),
        });
      },
    },
    {
      name: "codex_session_read",
      label: "Codex Session Read",
      description: "Read one Codex session transcript from app-server.",
      parameters: SessionReadParamsSchema,
      execute: async (_toolCallId, rawParams) => {
        requireRawTranscriptAccess(policy);
        const params = asRecord(rawParams);
        const threadId = readStringParam(params, "thread_id", { required: true });
        const response = await supervisor.readSession({
          endpointId: readStringParam(params, "endpoint_id"),
          threadId,
          includeTurns: readBooleanParam(params, "include_turns"),
        });
        return jsonResult({
          summary: `codex session: ${threadId}`,
          response: redactCodexSupervisorValue(response),
        });
      },
    },
    {
      name: "codex_session_send",
      label: "Codex Session Send",
      description:
        "Send text to a Codex session. Idle sessions start a turn; active sessions are steered.",
      parameters: SessionSendParamsSchema,
      execute: async (_toolCallId, rawParams) => {
        requireWriteAccess(policy);
        const params = asRecord(rawParams);
        const result = await supervisor.sendToSession({
          endpointId: readStringParam(params, "endpoint_id"),
          threadId: readStringParam(params, "thread_id", { required: true }),
          text: readStringParam(params, "text", { required: true, allowEmpty: false }),
          mode: readModeParam(params),
        });
        return jsonResult({
          summary: `codex ${result.mode}: ${result.turnId ?? result.threadId}`,
          result,
        });
      },
    },
    {
      name: "codex_session_interrupt",
      label: "Codex Session Interrupt",
      description: "Interrupt an active Codex turn.",
      parameters: SessionInterruptParamsSchema,
      execute: async (_toolCallId, rawParams) => {
        requireWriteAccess(policy);
        const params = asRecord(rawParams);
        const result = await supervisor.interruptSession({
          endpointId: readStringParam(params, "endpoint_id"),
          threadId: readStringParam(params, "thread_id", { required: true }),
          turnId: readStringParam(params, "turn_id"),
        });
        return jsonResult({
          summary: `codex interrupted: ${result.turnId}`,
          result,
        });
      },
    },
  ];
}
