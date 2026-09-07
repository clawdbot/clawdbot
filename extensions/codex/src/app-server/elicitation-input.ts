import { agentHarnessStructuredInput as structuredInput } from "openclaw/plugin-sdk/agent-harness-runtime";

type StructuredInputCompileResult = ReturnType<typeof structuredInput.compileForm>;

type CodexOrdinaryElicitation =
  | { kind: "ignored" }
  | { kind: "compiled"; input: StructuredInputCompileResult };

/** Compiles a validated Codex input snapshot before it enters the per-turn queue. */
export function compileCodexOrdinaryElicitation(params: {
  snapshot: Record<string, unknown>;
  turnId: string;
}): CodexOrdinaryElicitation {
  const requestTurnId = readValue(params.snapshot, "turnId");
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
  const mode = readCodexElicitationString(params.snapshot, "mode");
  if (mode === "url") {
    return {
      kind: "compiled",
      input: structuredInput.compileUrl({
        url: readValue(params.snapshot, "url"),
        elicitationId: readValue(params.snapshot, "elicitationId"),
        message: readValue(params.snapshot, "message"),
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
      schema: readValue(params.snapshot, "requestedSchema"),
      message: readCodexElicitationString(params.snapshot, "message"),
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
