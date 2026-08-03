// Runtime event helpers bridge core agent events into plugin runtime hooks.
import { onAgentEvent } from "../../infra/agent-events.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { PluginRuntime } from "./types.js";

/** Creates the plugin runtime event subscription facade. */
export function createRuntimeEvents(): PluginRuntime["events"] {
  return {
    onAgentEvent,
    onSessionTranscriptUpdate,
  };
}
