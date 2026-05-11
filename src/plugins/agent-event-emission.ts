import { emitAgentEvent } from "../infra/agent-events.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  isPluginJsonValue,
  type PluginAgentEventEmitParams,
  type PluginAgentEventEmitResult,
  type PluginJsonValue,
} from "./host-hooks.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

const HOST_OWNED_AGENT_EVENT_STREAMS = new Set<string>([
  "lifecycle",
  "tool",
  "assistant",
  "error",
  "item",
  "plan",
  "approval",
  "command_output",
  "patch",
  "compaction",
  "thinking",
  "model",
]);

function isPluginOwnedAgentEventStream(pluginId: string, stream: string): boolean {
  return stream === pluginId || stream.startsWith(`${pluginId}.`);
}

function normalizePluginEventData(params: {
  pluginId: string;
  pluginName?: string;
  data: PluginJsonValue;
}): Record<string, unknown> {
  if (params.data && typeof params.data === "object" && !Array.isArray(params.data)) {
    return {
      ...params.data,
      pluginId: params.pluginId,
      ...(params.pluginName ? { pluginName: params.pluginName } : {}),
    };
  }
  return {
    value: params.data,
    pluginId: params.pluginId,
    ...(params.pluginName ? { pluginName: params.pluginName } : {}),
  };
}

export function emitPluginAgentEvent(params: {
  pluginId: string;
  pluginName?: string;
  origin: PluginOrigin;
  event: PluginAgentEventEmitParams;
}): PluginAgentEventEmitResult {
  const runId = normalizeOptionalString(params.event.runId);
  const sessionKey = normalizeOptionalString(params.event.sessionKey);
  const stream = normalizeOptionalString(params.event.stream);
  if (!runId || !stream) {
    return { emitted: false, reason: "runId and stream are required" };
  }
  if (!isPluginJsonValue(params.event.data)) {
    return { emitted: false, reason: "event data must be JSON-compatible" };
  }
  if (params.origin !== "bundled" && HOST_OWNED_AGENT_EVENT_STREAMS.has(stream)) {
    return { emitted: false, reason: `stream ${stream} is reserved for bundled plugins` };
  }
  if (params.origin !== "bundled" && !isPluginOwnedAgentEventStream(params.pluginId, stream)) {
    return {
      emitted: false,
      reason: `stream ${stream} must be scoped to plugin ${params.pluginId}`,
    };
  }
  emitAgentEvent({
    runId,
    stream,
    ...(sessionKey ? { sessionKey } : {}),
    data: normalizePluginEventData({
      pluginId: params.pluginId,
      pluginName: params.pluginName,
      data: params.event.data,
    }),
  });
  return { emitted: true, stream };
}
