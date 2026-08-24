import type { ChatRunStartupPhase } from "../../../../packages/gateway-protocol/src/index.js";

export type { ChatRunStartupPhase } from "../../../../packages/gateway-protocol/src/index.js";

export type ChatRunStartupState =
  | { state: "status"; runId: string; phase: ChatRunStartupPhase }
  | { state: "activity"; runId: string };

export type ChatRunStartupStatus = Extract<ChatRunStartupState, { state: "status" }>;

export function activeChatRunStartupStatus(
  startup: ChatRunStartupState | null | undefined,
): ChatRunStartupStatus | null {
  return startup?.state === "status" ? startup : null;
}
