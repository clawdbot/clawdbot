/** Process-local prompt projection state owned by an embedded session lifecycle. */
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { AgentMessage } from "../runtime/index.js";

export type ToolResultPromptProjectionState = {
  replacements: Map<string, AgentMessage>;
  frozen: Set<string>;
  ambiguousBaseKeys: Set<string>;
  sourceTextByKey: Map<string, string[]>;
};

export type EmbeddedSessionPromptState = {
  toolResults: ToolResultPromptProjectionState;
  sentUserTurnIds: Set<string>;
};

const MAX_SESSION_PROMPT_STATES = 64;
const SESSION_PROMPT_STATES_KEY = Symbol.for("openclaw.embeddedSessionPromptStates");
const sessionPromptStates = resolveGlobalSingleton(
  SESSION_PROMPT_STATES_KEY,
  () => new Map<string, EmbeddedSessionPromptState>(),
);

function createSessionPromptState(): EmbeddedSessionPromptState {
  return {
    toolResults: {
      replacements: new Map<string, AgentMessage>(),
      frozen: new Set<string>(),
      ambiguousBaseKeys: new Set<string>(),
      sourceTextByKey: new Map<string, string[]>(),
    },
    sentUserTurnIds: new Set<string>(),
  };
}

export function cloneToolResultPromptProjectionState(
  state: ToolResultPromptProjectionState,
): ToolResultPromptProjectionState {
  return {
    replacements: new Map(state.replacements),
    frozen: new Set(state.frozen),
    ambiguousBaseKeys: new Set(state.ambiguousBaseKeys),
    sourceTextByKey: new Map(state.sourceTextByKey),
  };
}

export function getEmbeddedSessionPromptState(sessionId: string): EmbeddedSessionPromptState {
  const existing = sessionPromptStates.get(sessionId);
  if (existing) {
    sessionPromptStates.delete(sessionId);
    sessionPromptStates.set(sessionId, existing);
    return existing;
  }
  const created = createSessionPromptState();
  sessionPromptStates.set(sessionId, created);
  while (sessionPromptStates.size > MAX_SESSION_PROMPT_STATES) {
    const oldest = sessionPromptStates.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    sessionPromptStates.delete(oldest);
  }
  return created;
}

export function clearEmbeddedSessionPromptStates(sessionIds: Iterable<string | undefined>): void {
  for (const sessionId of sessionIds) {
    const normalized = sessionId?.trim();
    if (normalized) {
      sessionPromptStates.delete(normalized);
    }
  }
}

export function markSessionUserTurnsSent(
  state: EmbeddedSessionPromptState,
  messages: AgentMessage[],
): void {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    const idempotencyKey = (message as { idempotencyKey?: unknown }).idempotencyKey;
    if (typeof idempotencyKey === "string" && idempotencyKey.length > 0) {
      state.sentUserTurnIds.add(idempotencyKey);
    }
  }
}

export function hasSessionUserTurnBeenSent(
  state: EmbeddedSessionPromptState,
  message: AgentMessage | undefined,
): boolean | undefined {
  if (!message || message.role !== "user") {
    return undefined;
  }
  const idempotencyKey = (message as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof idempotencyKey === "string" && idempotencyKey.length > 0
    ? state.sentUserTurnIds.has(idempotencyKey)
    : undefined;
}

export const testing = {
  reset() {
    sessionPromptStates.clear();
  },
};
