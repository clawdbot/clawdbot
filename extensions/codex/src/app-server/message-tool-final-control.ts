import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { normalizeCodexDynamicToolName } from "./dynamic-tool-profile.js";

type MutableDynamicTool = {
  name: string;
  parameters?: unknown;
};

/**
 * `final` is a Codex-only control for message-tool-only source delivery. Keep
 * it on the projected Codex schema so other agent runtimes never receive an
 * API contract they do not implement.
 */
export function addCodexMessageToolOnlyFinalControl<T extends MutableDynamicTool>(
  tools: T[],
  sourceReplyDeliveryMode: EmbeddedRunAttemptParams["sourceReplyDeliveryMode"],
): T[] {
  if (sourceReplyDeliveryMode !== "message_tool_only") {
    return tools;
  }
  // These tools are attempt-fresh. Mutating preserves their WeakMap ownership
  // metadata without exposing a clone helper through the public plugin SDK.
  for (const tool of tools) {
    if (normalizeCodexDynamicToolName(tool.name) === "message") {
      const mutableTool: MutableDynamicTool = tool;
      mutableTool.parameters = addCodexMessageToolOnlyFinalParameter(mutableTool.parameters);
    }
  }
  return tools;
}

function addCodexMessageToolOnlyFinalParameter(parameters: unknown): unknown {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return parameters;
  }
  const schema = parameters as Record<string, unknown>;
  const rawProperties = schema.properties;
  if (!rawProperties || typeof rawProperties !== "object" || Array.isArray(rawProperties)) {
    return parameters;
  }
  return {
    ...schema,
    properties: {
      ...rawProperties,
      final: {
        type: "boolean",
        description:
          "Set true only when this message is intended to complete the reply to the current source conversation. OpenClaw stops after confirming delivery.",
      },
    },
  };
}
