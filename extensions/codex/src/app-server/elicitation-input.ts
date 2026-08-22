import { agentHarnessStructuredInput as structuredInput } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { JsonValue } from "./protocol.js";

type StructuredInputCompileResult = ReturnType<typeof structuredInput.compileForm>;

type CodexOrdinaryElicitation =
  | { kind: "ignored" }
  | { kind: "compiled"; input: StructuredInputCompileResult };

/** Snapshots and compiles ordinary Codex input before it enters the per-turn queue. */
export function compileCodexOrdinaryElicitation(params: {
  value: JsonValue | undefined;
  threadId: string;
  turnId: string;
}): CodexOrdinaryElicitation {
  if (readRawOwnString(params.value, "threadId") !== params.threadId) {
    return { kind: "ignored" };
  }
  const snapshot = structuredInput.snapshot(params.value);
  if (!structuredInput.isRecord(snapshot)) {
    return {
      kind: "compiled",
      input: {
        kind: "unsupported",
        message: "OpenClaw declined a malformed or over-limit MCP elicitation request.",
      },
    };
  }
  const requestTurnId = readValue(snapshot, "turnId");
  if (typeof requestTurnId === "string" && requestTurnId !== params.turnId) {
    return { kind: "ignored" };
  }
  if (requestTurnId !== null && typeof requestTurnId !== "string") {
    return {
      kind: "compiled",
      input: {
        kind: "unsupported",
        message: "OpenClaw declined an MCP elicitation with invalid turn correlation.",
      },
    };
  }
  const mode = readCodexElicitationString(snapshot, "mode");
  if (mode === "url") {
    return {
      kind: "compiled",
      input: structuredInput.compileUrl({
        url: readValue(snapshot, "url"),
        elicitationId: readValue(snapshot, "elicitationId"),
        message: readValue(snapshot, "message"),
        fallbackMessage: "Codex provided a URL",
        protocolName: "MCP",
      }),
    };
  }
  if (mode !== "form" && mode !== "openai/form") {
    return {
      kind: "compiled",
      input: {
        kind: "unsupported",
        message: `OpenClaw does not support MCP elicitation mode ${JSON.stringify(mode ?? "unknown")}.`,
      },
    };
  }
  return {
    kind: "compiled",
    input: structuredInput.compileForm({
      schema: readValue(snapshot, "requestedSchema"),
      message: readCodexElicitationString(snapshot, "message"),
      fallbackMessage: "Codex needs input",
      options: {
        protocolName: mode === "openai/form" ? "OpenAI" : "MCP",
        allowEmptyForm: true,
        minimumChoiceCount: 1,
        allowEnumNames: true,
        allowImagePicker: mode === "openai/form",
        metadata: { secretPath: ["isSecret"] },
      },
    }),
  };
}

function readValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function readCodexElicitationString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = readValue(record, key);
  return typeof value === "string" ? value : undefined;
}

function readRawOwnString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}
