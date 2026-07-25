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

export function detachPrePersistedCurrentUserTurn(params: {
  activeSession: { agent: { state: { messages: AgentMessage[] } } };
  preparedUserTurnMessage: AgentMessage | undefined;
  suppressNextUserMessagePersistence: boolean | undefined;
  userTurnAlreadyPersisted: boolean;
}): boolean {
  if (!params.suppressNextUserMessagePersistence || !params.userTurnAlreadyPersisted) {
    return false;
  }
  const idempotencyKey = (
    params.preparedUserTurnMessage as { idempotencyKey?: unknown } | undefined
  )?.idempotencyKey;
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return false;
  }
  const messages = params.activeSession.agent.state.messages;
  const tail = messages.at(-1) as (AgentMessage & { idempotencyKey?: unknown }) | undefined;
  if (tail?.role !== "user" || tail.idempotencyKey !== idempotencyKey) {
    return false;
  }
  // The durable transcript remains authoritative. Remove only its exact active
  // tail copy so Agent.prompt() submits the current user turn once to the model.
  params.activeSession.agent.state.messages = messages.slice(0, -1);
  return true;
}
