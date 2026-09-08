import { createHash } from "node:crypto";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { z } from "zod";

export const CODEX_MANAGED_THREAD_NAMESPACE = "app-server-managed-threads";
export const CODEX_MANAGED_THREAD_MAX_ENTRIES = 20_000;

const managedThreadSchema = z.object({
  version: z.literal(1),
  kind: z.literal("managed-thread"),
  sourceHomeId: z.string().min(1),
  threadId: z.string().min(1),
  rolloutPath: z.string().min(1).optional(),
});

export type StoredCodexManagedThread = z.infer<typeof managedThreadSchema>;

export type CodexManagedThreadStore = {
  has(sourceHomeId: string, threadId: string): Promise<boolean>;
  mark(params: { sourceHomeId: string; threadId: string; rolloutPath?: string }): Promise<boolean>;
  snapshot(): Promise<ReadonlyMap<string, ReadonlySet<string>>>;
};

export async function markStartedCodexManagedThread(
  store: CodexManagedThreadStore | undefined,
  params: { sourceHomeId: string; rolloutPath?: string; threadId: string },
): Promise<void> {
  if (!store) {
    return;
  }
  try {
    await store.mark({
      sourceHomeId: params.sourceHomeId,
      threadId: params.threadId,
      ...(params.rolloutPath ? { rolloutPath: params.rolloutPath } : {}),
    });
  } catch (error) {
    // Keep this boundary fail-open even for a custom or legacy store implementation.
    // A catalog duplicate is less harmful than rejecting an otherwise valid new session.
    embeddedAgentLog.warn("failed to record Codex managed thread ownership", { error });
  }
}

function managedThreadStoreKey(sourceHomeId: string, threadId: string): string {
  return `sha256:${createHash("sha256")
    .update("openclaw:codex-managed-thread:v1\0")
    .update(sourceHomeId)
    .update("\0")
    .update(threadId)
    .digest("hex")}`;
}

/** Durable ownership index for Codex threads created by OpenClaw. */
export function createCodexManagedThreadStore(
  state: Pick<
    PluginStateSyncKeyedStore<StoredCodexManagedThread>,
    "entries" | "lookup" | "registerIfAbsent"
  >,
): CodexManagedThreadStore {
  return {
    async has(sourceHomeId, threadId) {
      const parsed = managedThreadSchema.safeParse(
        state.lookup(managedThreadStoreKey(sourceHomeId, threadId)),
      );
      return (
        parsed.success &&
        parsed.data.sourceHomeId === sourceHomeId &&
        parsed.data.threadId === threadId
      );
    },
    async mark(params) {
      try {
        const value = managedThreadSchema.parse({
          version: 1,
          kind: "managed-thread",
          sourceHomeId: params.sourceHomeId.trim(),
          threadId: params.threadId.trim(),
          ...(params.rolloutPath?.trim() ? { rolloutPath: params.rolloutPath.trim() } : {}),
        });
        state.registerIfAbsent(managedThreadStoreKey(value.sourceHomeId, value.threadId), value);
        return true;
      } catch (error) {
        // Catalog ownership is advisory bookkeeping. Losing an old catalog exclusion is safer
        // than aborting a real Codex session start when plugin state is full or unavailable.
        embeddedAgentLog.warn("failed to record Codex managed thread ownership", { error });
        return false;
      }
    },
    async snapshot() {
      const byHome = new Map<string, Set<string>>();
      for (const entry of state.entries()) {
        const parsed = managedThreadSchema.safeParse(entry.value);
        if (!parsed.success) {
          continue;
        }
        const ids = byHome.get(parsed.data.sourceHomeId) ?? new Set<string>();
        ids.add(parsed.data.threadId);
        byHome.set(parsed.data.sourceHomeId, ids);
      }
      return byHome;
    },
  };
}
