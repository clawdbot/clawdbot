// Feishu plugin module implements source-message recall cancellation.
import { createHash } from "node:crypto";
import {
  getChannelRuntimeContext,
  registerChannelRuntimeContext,
} from "openclaw/plugin-sdk/channel-runtime-context";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import type { PluginRuntime } from "../runtime-api.js";

const RUNTIME_CONTEXT_KEY = {
  channelId: "feishu",
  capability: "source-message-recall",
} as const;
// Match the shared durable-ingress completed/failed replay horizon. A recalled
// receive must stay suppressed for as long as its durable replay tombstone.
const PERSISTED_RECALL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECALLED_MESSAGES = 2_000;

type PersistedRecall = {
  recalledAt: number;
};

type SourceMessageState = {
  controllers: Set<AbortController>;
  pendingIngressCount: number;
  recalledAt?: number;
};

type RecallRegistry = {
  loaded: boolean;
  states: Map<string, SourceMessageState>;
  store: ReturnType<typeof openRecallStore>;
};

function openRecallStore(accountId: string) {
  const accountNamespace = createHash("sha256").update(accountId).digest("hex");
  return createPluginStateSyncKeyedStore<PersistedRecall>("feishu", {
    namespace: `feishu.source-message-recalls.${accountNamespace}`,
    maxEntries: MAX_RECALLED_MESSAGES,
    defaultTtlMs: PERSISTED_RECALL_TTL_MS,
  });
}

function sourceMessageKey(messageId: string): string {
  return createHash("sha256").update(messageId).digest("hex");
}

function normalize(value: string | undefined | null): string | undefined {
  return value?.trim() || undefined;
}

function normalizeMessageIds(values: readonly (string | undefined | null)[]): string[] {
  return [...new Set(values.map(normalize).filter((value): value is string => Boolean(value)))];
}

function isStateReferenced(state: SourceMessageState): boolean {
  return state.controllers.size > 0 || state.pendingIngressCount > 0;
}

function pruneRegistry(registry: RecallRegistry, now = Date.now()): void {
  for (const [messageKey, state] of registry.states) {
    if (
      !isStateReferenced(state) &&
      state.recalledAt !== undefined &&
      now - state.recalledAt >= PERSISTED_RECALL_TTL_MS
    ) {
      registry.states.delete(messageKey);
    }
  }
}

function syncPersistedRecalls(registry: RecallRegistry): void {
  const persisted = new Map(
    registry.store
      .entries()
      .filter((entry) => Number.isFinite(entry.value.recalledAt))
      .map((entry) => [entry.key, entry.value.recalledAt] as const),
  );
  for (const [messageKey, state] of registry.states) {
    const recalledAt = persisted.get(messageKey);
    state.recalledAt = recalledAt;
    if (recalledAt === undefined && !isStateReferenced(state)) {
      registry.states.delete(messageKey);
    }
  }
  for (const [messageKey, recalledAt] of persisted) {
    const state = registry.states.get(messageKey);
    if (state) {
      state.recalledAt = recalledAt;
      continue;
    }
    registry.states.set(messageKey, {
      controllers: new Set(),
      pendingIngressCount: 0,
      recalledAt,
    });
  }
  registry.loaded = true;
}

function invalidatePersistedRecalls(registry: RecallRegistry): void {
  registry.loaded = false;
  for (const [messageKey, state] of registry.states) {
    state.recalledAt = undefined;
    if (!isStateReferenced(state)) {
      registry.states.delete(messageKey);
    }
  }
}

function resolveRegistry(params: {
  channelRuntime?: PluginRuntime["channel"];
  accountId?: string | null;
}): RecallRegistry | undefined {
  const accountId = normalize(params.accountId);
  if (!params.channelRuntime || !accountId) {
    return undefined;
  }
  const key = { ...RUNTIME_CONTEXT_KEY, accountId };
  const existing = getChannelRuntimeContext({
    channelRuntime: params.channelRuntime,
    ...key,
  }) as RecallRegistry | undefined;
  if (existing) {
    if (!existing.loaded) {
      syncPersistedRecalls(existing);
    }
    return existing;
  }
  const store = openRecallStore(accountId);
  const registry: RecallRegistry = { loaded: false, states: new Map(), store };
  syncPersistedRecalls(registry);
  const lease = registerChannelRuntimeContext({
    channelRuntime: params.channelRuntime,
    ...key,
    context: registry,
  });
  return lease ? registry : undefined;
}

function resolveState(registry: RecallRegistry, messageId: string, now = Date.now()) {
  pruneRegistry(registry, now);
  const existing = registry.states.get(messageId);
  if (existing) {
    return existing;
  }
  const state: SourceMessageState = {
    controllers: new Set(),
    pendingIngressCount: 0,
  };
  registry.states.set(messageId, state);
  return state;
}

export function isFeishuSourceMessageRecalled(params: {
  channelRuntime?: PluginRuntime["channel"];
  accountId?: string | null;
  messageId?: string | null;
}): boolean {
  const messageId = normalize(params.messageId);
  const registry = resolveRegistry(params);
  if (!messageId || !registry) {
    return false;
  }
  pruneRegistry(registry);
  return registry.states.get(sourceMessageKey(messageId))?.recalledAt !== undefined;
}

export function recallFeishuSourceMessage(params: {
  channelRuntime?: PluginRuntime["channel"];
  accountId?: string | null;
  messageId?: string | null;
}): { abortedRuns: number; alreadyRecalled: boolean; recorded: boolean } {
  const messageId = normalize(params.messageId);
  const registry = resolveRegistry(params);
  if (!messageId || !registry) {
    return { abortedRuns: 0, alreadyRecalled: false, recorded: false };
  }
  const now = Date.now();
  const messageKey = sourceMessageKey(messageId);
  pruneRegistry(registry, now);
  const existingState = registry.states.get(messageKey);
  const alreadyRecalled = existingState?.recalledAt !== undefined;
  const boundControllers = existingState ? [...existingState.controllers] : [];
  // Persist before aborting active work. A failed write must not make a recall
  // look authoritative in memory while a restarted gateway can forget it.
  // The shared plugin-wide 50k fuse can reject this write; callers surface that
  // failure and active work remains authorized until durable state is readable.
  registry.store.register(messageKey, { recalledAt: now });
  try {
    syncPersistedRecalls(registry);
  } catch (error) {
    // The write committed, so this source is durably recalled even when the
    // post-write snapshot cannot be refreshed. Abort its known work, discard
    // cached recall facts, and force the next access to reload authoritatively.
    for (const controller of boundControllers) {
      if (!controller.signal.aborted) {
        controller.abort(new Error(`Feishu source message ${messageId} was recalled`));
      }
    }
    invalidatePersistedRecalls(registry);
    throw error;
  }
  const state = registry.states.get(messageKey);
  let abortedRuns = 0;
  for (const controller of state?.controllers ?? []) {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`Feishu source message ${messageId} was recalled`));
      abortedRuns += 1;
    }
  }
  return { abortedRuns, alreadyRecalled, recorded: true };
}

export function retainFeishuSourceMessageIngress(params: {
  channelRuntime?: PluginRuntime["channel"];
  accountId?: string | null;
  messageId?: string | null;
}): { dispose: () => void } | undefined {
  const messageId = normalize(params.messageId);
  const registry = resolveRegistry(params);
  if (!messageId || !registry) {
    return undefined;
  }
  const messageKey = sourceMessageKey(messageId);
  const state = resolveState(registry, messageKey);
  state.pendingIngressCount += 1;
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      state.pendingIngressCount -= 1;
      const now = Date.now();
      if (!isStateReferenced(state) && state.recalledAt === undefined) {
        registry.states.delete(messageKey);
      }
      pruneRegistry(registry, now);
    },
  };
}

export function bindFeishuSourceMessageRun(params: {
  channelRuntime?: PluginRuntime["channel"];
  accountId?: string | null;
  messageId?: string | null;
  messageIds?: readonly (string | undefined | null)[];
}): { abortSignal: AbortSignal; dispose: () => void } | undefined {
  const messageIds = normalizeMessageIds([...(params.messageIds ?? []), params.messageId]);
  const registry = resolveRegistry(params);
  if (messageIds.length === 0 || !registry) {
    return undefined;
  }
  const bindings = messageIds.map((messageId) => {
    const controller = new AbortController();
    const messageKey = sourceMessageKey(messageId);
    const state = resolveState(registry, messageKey);
    if (state.recalledAt !== undefined) {
      controller.abort(new Error(`Feishu source message ${messageId} was recalled`));
    } else {
      state.controllers.add(controller);
    }
    return { controller, messageId, messageKey, state };
  });
  let disposed = false;
  return {
    abortSignal:
      bindings.length === 1
        ? bindings[0]!.controller.signal
        : AbortSignal.any(bindings.map(({ controller }) => controller.signal)),
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const now = Date.now();
      for (const { controller, messageKey, state } of bindings) {
        state.controllers.delete(controller);
        if (!isStateReferenced(state) && state.recalledAt === undefined) {
          registry.states.delete(messageKey);
        }
      }
      pruneRegistry(registry, now);
    },
  };
}
