import type { RealtimeTalkEvent } from "./realtime-talk-shared.ts";

export type GatewayRelayEvent = {
  relaySessionId?: string;
  talkEvent?: RealtimeTalkEvent;
} & (
  | { type?: "ready" }
  | { type?: "audio"; audioBase64?: string }
  | { type?: "clear"; reason?: "barge-in" }
  | { type?: "mark"; markName?: string }
  | {
      type?: "transcript";
      role?: "user" | "assistant";
      text?: string;
      final?: boolean;
    }
  | {
      type?: "toolCall";
      callId?: string;
      name?: string;
      args?: unknown;
      forced?: boolean;
    }
  | { type?: "toolResult"; callId?: string }
  | { type?: "error"; message?: string }
  | { type?: "close"; reason?: string }
);

export type DelayedToolResult = {
  callId: string;
  result: unknown;
  options?: { suppressResponse?: boolean; willContinue?: boolean };
  timer?: number;
};
