/** Transcript-backed prompt projection state cached by an embedded session lifecycle. */
import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { AgentMessage } from "../runtime/index.js";

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

export type ToolResultPromptProjectionState = {
  replacements: Map<string, { content: ToolResultMessage["content"]; cacheTtl?: "soft" | "hard" }>;
  frozen: Set<string>;
  ambiguousBaseKeys: Set<string>;
  sourceHashByKey: Map<string, string>;
  /** Cache-TTL marks read from the transcript marker; the projection owner materializes them on the next replay. */
  restoredCacheTtl: Map<string, RestoredCacheTtlMark>;
  lastWrittenSnapshotHash?: string;
};

type RestoredCacheTtlMark = { mode: "soft" } | { mode: "hard"; placeholder: string };

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

export function createToolResultPromptProjectionState(): ToolResultPromptProjectionState {
  return {
    replacements: new Map(),
    frozen: new Set<string>(),
    ambiguousBaseKeys: new Set<string>(),
    sourceHashByKey: new Map<string, string>(),
    restoredCacheTtl: new Map(),
  };
}

function createSessionPromptState(): EmbeddedSessionPromptState {
  return {
    activeProjectKeys: [],
    toolResults: createToolResultPromptProjectionState(),
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
    sourceHashByKey: new Map(state.sourceHashByKey),
    restoredCacheTtl: new Map(state.restoredCacheTtl),
    lastWrittenSnapshotHash: state.lastWrittenSnapshotHash,
  };
}

export function recordToolResultPromptProjection(
  state: ToolResultPromptProjectionState,
  key: string,
  message: ToolResultMessage,
  cacheTtl = state.replacements.get(key)?.cacheTtl,
): void {
  // Ordinary replay merges canonical metadata and non-text blocks. Keeping them
  // here would pin full read/web payloads after attempt teardown; TTL owns exact content.
  state.replacements.set(key, {
    cacheTtl,
    content: cacheTtl
      ? message.content
      : message.content.flatMap((block) =>
          isRecord(block) && block.type === "text" && typeof block.text === "string"
            ? [{ type: "text" as const, text: block.text }]
            : [],
        ),
  });
}

/** TTL trims are re-derived; ordinary trims retain only text, never images or tool metadata. */
export function serializeCacheTtlToolResultProjections(state: ToolResultPromptProjectionState) {
  const marks = new Map(state.restoredCacheTtl);
  for (const [key, projection] of state.replacements) {
    if (projection.cacheTtl === "soft") {
      marks.set(key, { mode: "soft" });
    } else if (projection.cacheTtl === "hard") {
      const placeholder = projection.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      marks.set(key, { mode: "hard", placeholder });
    }
  }
  return {
    prunedToolResults: [...marks].map(([key, mark]) => Object.assign({ key }, mark)),
    ambiguousToolResultBaseKeys: [...state.ambiguousBaseKeys],
    frozenToolResults: [...state.sourceHashByKey].flatMap(([key, sourceHash]) => {
      if (!state.frozen.has(key)) {
        return [];
      }
      const projection = state.replacements.get(key);
      return [
        {
          key,
          sourceHash,
          ...(!projection?.cacheTtl && projection
            ? {
                texts: projection.content.flatMap((block) =>
                  block.type === "text" ? [block.text] : [],
                ),
              }
            : {}),
        },
      ];
    }),
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

export function hashToolResultProjectionSnapshot(
  snapshot: ReturnType<typeof serializeCacheTtlToolResultProjections>,
): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function persistToolResultProjections(
  state: ToolResultPromptProjectionState,
  appendEntry: (customType: string, data: unknown) => void,
): void {
  if (state.frozen.size === 0) {
    return;
  }
  const snapshot = serializeCacheTtlToolResultProjections(state);
  const hash = hashToolResultProjectionSnapshot(snapshot);
  if (hash === state.lastWrittenSnapshotHash) {
    return;
  }
  appendEntry("openclaw.cache-ttl", snapshot);
  // A failed owned write must leave the snapshot eligible for persistence.
  state.lastWrittenSnapshotHash = hash;
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
