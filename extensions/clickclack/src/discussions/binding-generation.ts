import { randomUUID } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

type DiscussionBindingGeneration = {
  destinationIdentity: string;
  generation: string;
  pending?: {
    accountId: string;
    serverBaseUrl: string;
    workspaceId: string;
    sessionId: string;
    externalRef: string;
    credentialFingerprint: string;
  };
};

export type PendingDiscussionOpen = NonNullable<DiscussionBindingGeneration["pending"]> & {
  sessionKey: string;
  generation: string;
};

const DISCUSSION_GENERATIONS_NAMESPACE = "discussion-binding-generations";
const MAX_PENDING_DISCUSSION_GENERATIONS = 10_000;
const storesByRuntime = new WeakMap<
  PluginRuntime,
  PluginStateSyncKeyedStore<DiscussionBindingGeneration>
>();

function getGenerationStore(
  runtime: PluginRuntime,
): PluginStateSyncKeyedStore<DiscussionBindingGeneration> {
  const existing = storesByRuntime.get(runtime);
  if (existing) {
    return existing;
  }
  const created = runtime.state.openSyncKeyedStore<DiscussionBindingGeneration>({
    namespace: DISCUSSION_GENERATIONS_NAMESPACE,
    maxEntries: MAX_PENDING_DISCUSSION_GENERATIONS,
    // A pending record may be the only evidence for a remotely committed channel
    // whose response was lost. Reject new opens instead of evicting that evidence.
    overflowPolicy: "reject-new",
  });
  storesByRuntime.set(runtime, created);
  return created;
}

/** Reserves a generation so an interrupted channel create can be adopted on retry. */
export function reserveDiscussionBindingGeneration(params: {
  runtime: PluginRuntime;
  sessionKey: string;
  destinationIdentity: string;
  createGeneration?: () => string;
}): string {
  const store = getGenerationStore(params.runtime);
  const existing = store.lookup(params.sessionKey);
  if (existing?.destinationIdentity === params.destinationIdentity) {
    return existing.generation;
  }
  const generation = (params.createGeneration ?? randomUUID)();
  store.register(params.sessionKey, {
    destinationIdentity: params.destinationIdentity,
    generation,
  });
  return generation;
}

/** Clears only the completed reservation; future opens must mint a new ownership ref. */
export function clearDiscussionBindingGeneration(params: {
  runtime: PluginRuntime;
  sessionKey: string;
  expectedGeneration?: string;
}): void {
  const store = getGenerationStore(params.runtime);
  const existing = store.lookup(params.sessionKey);
  if (!existing) {
    return;
  }
  if (params.expectedGeneration && existing.generation !== params.expectedGeneration) {
    return;
  }
  store.delete(params.sessionKey);
}

/** Quarantines a destination before the first fallible channel create. */
export function recordPendingDiscussionOpen(params: {
  runtime: PluginRuntime;
  sessionKey: string;
  generation: string;
  pending: NonNullable<DiscussionBindingGeneration["pending"]>;
}): void {
  const store = getGenerationStore(params.runtime);
  const existing = store.lookup(params.sessionKey);
  if (!existing || existing.generation !== params.generation) {
    throw new Error("ClickClack discussion generation changed before channel creation");
  }
  store.register(params.sessionKey, { ...existing, pending: params.pending });
}

export function listPendingDiscussionOpens(runtime: PluginRuntime): PendingDiscussionOpen[] {
  return getGenerationStore(runtime)
    .entries()
    .flatMap((entry) =>
      entry.value.pending
        ? [{ sessionKey: entry.key, generation: entry.value.generation, ...entry.value.pending }]
        : [],
    );
}

export function hasPendingDiscussionOpenForDestination(params: {
  runtime: PluginRuntime;
  serverBaseUrl: string;
  workspaceId: string;
}): boolean {
  const serverBaseUrl = params.serverBaseUrl.replace(/\/+$/u, "");
  return listPendingDiscussionOpens(params.runtime).some(
    (pending) =>
      pending.serverBaseUrl === serverBaseUrl && pending.workspaceId === params.workspaceId,
  );
}
