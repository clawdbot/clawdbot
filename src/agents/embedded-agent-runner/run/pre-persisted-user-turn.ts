import type { AgentMessage } from "../../../../packages/agent-core/src/types.js";

export function sessionMessagesContainIdempotencyKey(
  messages: AgentMessage[],
  idempotencyKey: string,
): boolean {
  return messages.some(
    (message) =>
      typeof (message as { idempotencyKey?: unknown }).idempotencyKey === "string" &&
      (message as { idempotencyKey?: unknown }).idempotencyKey === idempotencyKey,
  );
}

export function reconcilePrePersistedCurrentUserTurn(params: {
  activeSession: { agent: { state: { messages: AgentMessage[] } } };
  durableUserTurnMessage: AgentMessage | undefined;
  preparedUserTurnMessage: AgentMessage | undefined;
  userTurnAlreadyPersisted: boolean;
}): boolean {
  if (!params.userTurnAlreadyPersisted) {
    return false;
  }
  const idempotencyKey = (
    params.preparedUserTurnMessage as { idempotencyKey?: unknown } | undefined
  )?.idempotencyKey;
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return false;
  }
  const durableIdempotencyKey = (
    params.durableUserTurnMessage as { idempotencyKey?: unknown } | undefined
  )?.idempotencyKey;
  const messages = params.activeSession.agent.state.messages;
  const tail = messages.at(-1) as (AgentMessage & { idempotencyKey?: unknown }) | undefined;
  const activeTailMatches = tail?.role === "user" && tail.idempotencyKey === idempotencyKey;
  if (!activeTailMatches && durableIdempotencyKey !== idempotencyKey) {
    return false;
  }
  if (activeTailMatches) {
    // Persistence is recorder-owned; either synchronized representation can
    // prove identity. Remove the active copy when present so the model sees it once.
    params.activeSession.agent.state.messages = messages.slice(0, -1);
  }
  return true;
}
