/**
 * Shared display and chunking types for embedded-agent subscription handlers.
 */
import type { AgentCommandOutputEventFields } from "../infra/agent-activity-events.js";
import type { BlockReplyChunking } from "./embedded-agent-block-chunker.js";

/** Rendering mode for completed tool results in subscribed replies. */
export type ToolResultFormat = "markdown" | "plain";
/** Detail level for in-flight tool progress messages. */
export type ToolProgressDetailMode = "explain" | "raw" | "plain";

export type EmbeddedAgentEvent = {
  stream: string;
  data: Record<string, unknown> &
    Omit<Partial<AgentCommandOutputEventFields>, "phase" | "status"> & {
      phase?: string;
      status?: string;
      args?: Record<string, unknown>;
      summary?: string;
      commandBearing?: boolean;
      isError?: boolean;
    };
  sessionKey?: string;
};

export type { BlockReplyChunking };
