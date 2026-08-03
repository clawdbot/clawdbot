/** Process-local prompt projection state owned by an embedded session lifecycle. */
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { AgentMessage } from "../runtime/index.js";

export type ToolResultPromptProjectionState = {
  replacements: Map<string, AgentMessage>;
  frozen: Set<string>;
  ambiguousBaseKeys: Set<string>;
  sourceTextByKey: Map<string, string[]>;
};

type EmbeddedSessionPromptState = {
  activeProjectKeys: string[];
  toolResults: ToolResultPromptProjectionState;
  sentUserTurnIds: Set<string>;
};

const MAX_SESSION_PROMPT_STATES = 64;
const MAX_ACTIVE_PROJECT_KEYS = 4;
const SESSION_PROMPT_STATES_KEY = Symbol.for("openclaw.embeddedSessionPromptStates");
const sessionPromptStates = resolveGlobalSingleton(
  SESSION_PROMPT_STATES_KEY,
  () => new Map<string, EmbeddedSessionPromptState>(),
);

function createSessionPromptState(): EmbeddedSessionPromptState {
  return {
    activeProjectKeys: [],
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
  pruneMapToMaxSize(sessionPromptStates, MAX_SESSION_PROMPT_STATES);
  return created;
}

/** Records the prepared repository identity and snapshots this session's LRU active set. */
export function prepareEmbeddedSessionActiveProjectKeys(
  sessionId: string,
  projectKey: string | null,
): readonly string[] {
  const state = getEmbeddedSessionPromptState(sessionId);
  if (projectKey) {
    const existing = state.activeProjectKeys.indexOf(projectKey);
    if (existing >= 0) {
      state.activeProjectKeys.splice(existing, 1);
    }
    state.activeProjectKeys.unshift(projectKey);
    state.activeProjectKeys.length = Math.min(
      state.activeProjectKeys.length,
      MAX_ACTIVE_PROJECT_KEYS,
    );
  }
  // Consumers use set membership today; LRU order is retained for a possible future graduated boost.
  return [...state.activeProjectKeys];
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
