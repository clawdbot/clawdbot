import { Routes } from "discord-api-types/v10";
import {
  registerSessionBindingAdapter,
  resolveThreadBindingConversationIdFromBindingId,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import {
  getRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { createDiscordRestClient } from "../client.js";
import {
  createThreadForBinding,
  createWebhookForChannel,
  findReusableWebhook,
  isDiscordThreadGoneError,
  isThreadArchived,
  maybeSendBindingMessage,
  resolveChannelIdForBinding,
  summarizeDiscordError,
} from "./thread-bindings.discord-api.js";
import {
  resolveThreadBindingFarewellText,
  resolveThreadBindingThreadName,
} from "./thread-bindings.messages.js";
import {
  BINDINGS_BY_THREAD_ID,
  forgetThreadBindingToken,
  getThreadBindingToken,
  MANAGERS_BY_ACCOUNT_ID,
  PERSIST_BY_ACCOUNT_ID,
  ensureBindingsLoaded,
  rememberThreadBindingToken,
  normalizeTargetKind,
  normalizeThreadBindingDurationMs,
  normalizeThreadId,
  rememberRecentUnboundWebhookEcho,
  removeBindingRecord,
  resolveBindingIdsForSession,
  resolveBindingRecordKey,
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingInactivityExpiresAt,
  resolveThreadBindingMaxAgeExpiresAt,
  resolveThreadBindingMaxAgeMs,
  resolveThreadBindingsPath,
  saveBindingsToDisk,
  setBindingRecord,
  THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS,
  shouldDefaultPersist,
  resetThreadBindingsForTests,
} from "./thread-bindings.state.js";
import {
  DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  DEFAULT_THREAD_BINDING_MAX_AGE_MS,
  THREAD_BINDINGS_SWEEP_INTERVAL_MS,
  type ThreadBindingManager,
  type ThreadBindingRecord,
} from "./thread-bindings.types.js";

function registerManager(manager: ThreadBindingManager) {
  MANAGERS_BY_ACCOUNT_ID.set(manager.accountId, manager);
}

function unregisterManager(accountId: string, manager: ThreadBindingManager) {
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing === manager) {
    MANAGERS_BY_ACCOUNT_ID.delete(accountId);
  }
}

const SWEEPERS_BY_ACCOUNT_ID = new Map<string, () => Promise<void>>();

function resolveEffectiveBindingExpiresAt(params: {
  record: ThreadBindingRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): number | undefined {
  const inactivityExpiresAt = resolveThreadBindingInactivityExpiresAt({
    record: params.record,
    defaultIdleTimeoutMs: params.defaultIdleTimeoutMs,
  });
  const maxAgeExpiresAt = resolveThreadBindingMaxAgeExpiresAt({
    record: params.record,
    defaultMaxAgeMs: params.defaultMaxAgeMs,
  });
  if (inactivityExpiresAt != null && maxAgeExpiresAt != null) {
    return Math.min(inactivityExpiresAt, maxAgeExpiresAt);
  }
  return inactivityExpiresAt ?? maxAgeExpiresAt;
}

function createNoopManager(accountIdRaw?: string): ThreadBindingManager {
  const accountId = normalizeAccountId(accountIdRaw);
  return {
    accountId,
    getIdleTimeoutMs: () => DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
    getMaxAgeMs: () => DEFAULT_THREAD_BINDING_MAX_AGE_MS,
    getByThreadId: () => undefined,
    getBySessionKey: () => undefined,
    listBySessionKey: () => [],
    listBindings: () => [],
    touchThread: () => null,
    bindTarget: async () => null,
    unbindThread: () => null,
    unbindBySessionKey: () => [],
    stop: () => {},
  };
}

function toSessionBindingTargetKind(raw: string): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toThreadBindingTargetKind(raw: BindingTargetKind): "subagent" | "acp" {
  return raw === "subagent" ? "subagent" : "acp";
}

function isDirectConversationBindingId(value?: string | null): boolean {
  const trimmed = normalizeOptionalString(value);
  return Boolean(trimmed && /^(user:|channel:)/i.test(trimmed));
}

function toSessionBindingRecord(
  record: ThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  const bindingId =
    resolveBindingRecordKey({
      accountId: record.accountId,
      threadId: record.threadId,
    }) ?? `${record.accountId}:${record.threadId}`;
  return {
    bindingId,
    targetSessionKey: record.targetSessionKey,
    targetKind: toSessionBindingTargetKind(record.targetKind),
    conversation: {
      channel: "discord",
      accountId: record.accountId,
      conversationId: record.threadId,
      parentConversationId: record.channelId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt: resolveEffectiveBindingExpiresAt({
      record,
      defaultIdleTimeoutMs: defaults.idleTimeoutMs,
      defaultMaxAgeMs: defaults.maxAgeMs,
    }),
    metadata: {
      agentId: record.agentId,
      label: record.label,
      webhookId: record.webhookId,
      webhookToken: record.webhookToken,
      boundBy: record.boundBy,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs: resolveThreadBindingIdleTimeoutMs({
        record,
        defaultIdleTimeoutMs: defaults.idleTimeoutMs,
      }),
      maxAgeMs: resolveThreadBindingMaxAgeMs({
        record,
        defaultMaxAgeMs: defaults.maxAgeMs,
      }),
      ...record.metadata,
    },
  };
}

export function createThreadBindingManager(
  params: {
    accountId?: string;
    token?: string;
    cfg?: OpenClawConfig;
    persist?: boolean;
    enableSweeper?: boolean;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
  } = {},
): ThreadBindingManager {
  ensureBindingsLoaded();
  const accountId = normalizeAccountId(params.accountId);
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing) {
    rememberThreadBindingToken({ accountId, token: params.token });
    return existing;
  }

  rememberThreadBindingToken({ accountId, token: params.token });

  const persist = params.persist ?? shouldDefaultPersist();
  PERSIST_BY_ACCOUNT_ID.set(accountId, persist);
  const idleTimeoutMs = normalizeThreadBindingDurationMs(
    params.idleTimeoutMs,
    DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  );
  const maxAgeMs = normalizeThreadBindingDurationMs(
    params.maxAgeMs,
    DEFAULT_THREAD_BINDING_MAX_AGE_MS,
  );
  const resolveCurrentCfg = () => getRuntimeConfigSnapshot() ?? params.cfg;
  const resolveCurrentToken = () => getThreadBindingToken(accountId) ?? params.token;

  let sweepTimer: NodeJS.Timeout | null = null;
  const runSweepOnce = async () => {
    const bindings = manager.listBindings();
    if (bindings.length === 0) {
      return;
    }
    let rest: ReturnType<typeof createDiscordRestClient>["rest"] | null = null;
    for (const snapshotBinding of bindings) {
      // Re-read live state after any awaited work from earlier iterations.
      // This avoids unbinding based on stale snapshot data when activity touches
      // happen while the sweeper loop is in-flight.
      const binding = manager.getByThreadId(snapshotBinding.threadId);
      if (!binding) {
        continue;
      }
      const now = Date.now();
      const inactivityExpiresAt = resolveThreadBindingInactivityExpiresAt({
        record: binding,
        defaultIdleTimeoutMs: idleTimeoutMs,
      });
      const maxAgeExpiresAt = resolveThreadBindingMaxAgeExpiresAt({
        record: binding,
        defaultMaxAgeMs: maxAgeMs,
      });
      const expirationCandidates: Array<{
        reason: "idle-expired" | "max-age-expired";
        at: number;
      }> = [];
      if (inactivityExpiresAt != null && now >= inactivityExpiresAt) {
        expirationCandidates.push({ reason: "idle-expired", at: inactivityExpiresAt });
      }
      if (maxAgeExpiresAt != null && now >= maxAgeExpiresAt) {
        expirationCandidates.push({ reason: "max-age-expired", at: maxAgeExpiresAt });
      }
      if (expirationCandidates.length > 0) {
        expirationCandidates.sort((a, b) => a.at - b.at);
        const reason = expirationCandidates[0]?.reason ?? "idle-expired";
        manager.unbindThread({
          threadId: binding.threadId,
          reason,
          sendFarewell: true,
          farewellText: resolveThreadBindingFarewellText({
            reason,
            idleTimeoutMs: resolveThreadBindingIdleTimeoutMs({
              record: binding,
              defaultIdleTimeoutMs: idleTimeoutMs,
            }),
            maxAgeMs: resolveThreadBindingMaxAgeMs({
              record: binding,
              defaultMaxAgeMs: maxAgeMs,
            }),
          }),
        });
        continue;
      }
      if (isDirectConversationBindingId(binding.threadId)) {
        continue;
      }
      if (!rest) {
        try {
          const cfg = resolveCurrentCfg();
          rest = createDiscordRestClient(
            {
              accountId,
              token: resolveCurrentToken(),
            },
            cfg,
          ).rest;
        } catch {
          return;
        }
      }
      try {
        const channel = await rest.get(Routes.channel(binding.threadId));
        if (!channel || typeof channel !== "object") {
          logVerbose(
            `discord thread binding sweep probe returned invalid payload for ${binding.threadId}`,
          );
          continue;
        }
        if (isThreadArchived(channel)) {
          manager.unbindThread({
            threadId: binding.threadId,
            reason: "thread-archived",
            sendFarewell: true,
          });
        }
      } catch (err) {
        if (isDiscordThreadGoneError(err)) {
          logVerbose(
            `discord thread binding sweep removing stale binding ${binding.threadId}: ${summarizeDiscordError(err)}`,
          );
          manager.unbindThread({
            threadId: binding.threadId,
            reason: "thread-delete",
            sendFarewell: false,
          });
          continue;
        }
        logVerbose(
          `discord thread binding sweep probe failed for ${binding.threadId}: ${summarizeDiscordError(err)}`,
        );
      }
    }
  };
  SWEEPERS_BY_ACCOUNT_ID.set(accountId, runSweepOnce);

  const manager: ThreadBindingManager = {
    accountId,
    getIdleTimeoutMs: () => idleTimeoutMs,
    getMaxAgeMs: () => maxAgeMs,
    getByThreadId: (threadId) => {
      const key = resolveBindingRecordKey({
        accountId,
        threadId,
      });
      if (!key) {
        return undefined;
      }
      const entry = BINDINGS_BY_THREAD_ID.get(key);
      if (!entry || entry.accountId !== accountId) {
        return undefined;
      }
      return entry;
    },
    getBySessionKey: (targetSessionKey) => {
      const all = manager.listBySessionKey(targetSessionKey);
      return all[0];
    },
    listBySessionKey: (targetSessionKey) => {
      const ids = resolveBindingIdsForSession({
        targetSessionKey,
        accountId,
      });
      return ids
        .map((bindingKey) => BINDINGS_BY_THREAD_ID.get(bindingKey))
        .filter((entry): entry is ThreadBindingRecord => Boolean(entry));
    },
    listBindings: () =>
      [...BINDINGS_BY_THREAD_ID.values()].filter((entry) => entry.accountId === accountId),
    touchThread: (touchParams) => {
      const key = resolveBindingRecordKey({
        accountId,
        threadId: touchParams.threadId,
      });
      if (!key) {
        return null;
      }
      const existing = BINDINGS_BY_THREAD_ID.get(key);
      if (!existing || existing.accountId !== accountId) {
        return null;
      }
      const now = Date.now();
      const at =
        typeof touchParams.at === "number" && Number.isFinite(touchParams.at)
          ? Math.max(0, Math.floor(touchParams.at))
          : now;
      const nextRecord: ThreadBindingRecord = {
        ...existing,
        lastActivityAt: Math.max(existing.lastActivityAt || 0, at),
      };
      setBindingRecord(nextRecord);
      if (touchParams.persist ?? persist) {
        saveBindingsToDisk({
          minIntervalMs: THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS,
        });
      }
      return nextRecord;
    },
    bindTarget: async (bindParams) => {
      const cfg = resolveCurrentCfg();
      let threadId = normalizeThreadId(bindParams.threadId);
      let channelId = normalizeOptionalString(bindParams.channelId) ?? "";
      const directConversationBinding =
        isDirectConversationBindingId(threadId) || isDirectConversationBindingId(channelId);

      if (!threadId && bindParams.createThread) {
        if (!channelId) {
          return null;
        }
        const threadName = resolveThreadBindingThreadName({
          agentId: bindParams.agentId,
          label: bindParams.label,
        });
        threadId =
          (await createThreadForBinding({
            cfg,
            accountId,
            token: resolveCurrentToken(),
            channelId,
            threadName: normalizeOptionalString(bindParams.threadName) ?? threadName,
          })) ?? undefined;
      }

      if (!threadId) {
        return null;
      }

      if (!channelId && directConversationBinding) {
        channelId = threadId;
      }

      if (!channelId) {
        channelId =
          (await resolveChannelIdForBinding({
            cfg,
            accountId,
            token: resolveCurrentToken(),
            threadId,
            channelId: bindParams.channelId,
          })) ?? "";
      }
      if (!channelId) {
        return null;
      }

      const existing = manager.getByThreadId(threadId);
      const targetSessionKey = normalizeOptionalString(bindParams.targetSessionKey) ?? "";
      if (!targetSessionKey) {
        return null;
      }

      const targetKind = normalizeTargetKind(bindParams.targetKind, targetSessionKey);
      let webhookId =
        normalizeOptionalString(bindParams.webhookId) ??
        normalizeOptionalString(existing?.webhookId) ??
        "";
      let webhookToken =
        normalizeOptionalString(bindParams.webhookToken) ??
        normalizeOptionalString(existing?.webhookToken) ??
        "";
      if (!directConversationBinding && (!webhookId || !webhookToken)) {
        const cachedWebhook = findReusableWebhook({ accountId, channelId });
        webhookId = cachedWebhook.webhookId ?? "";
        webhookToken = cachedWebhook.webhookToken ?? "";
      }
      if (!directConversationBinding && (!webhookId || !webhookToken)) {
        const createdWebhook = await createWebhookForChannel({
          cfg,
          accountId,
          token: resolveCurrentToken(),
          channelId,
        });
        webhookId = createdWebhook.webhookId ?? "";
        webhookToken = createdWebhook.webhookToken ?? "";
      }

      const now = Date.now();
      const record: ThreadBindingRecord = {
        accountId,
        channelId,
        threadId,
        targetKind,
        targetSessionKey,
        agentId:
          normalizeOptionalString(bindParams.agentId) ??
          normalizeOptionalString(existing?.agentId) ??
          resolveAgentIdFromSessionKey(targetSessionKey),
        label:
          normalizeOptionalString(bindParams.label) ?? normalizeOptionalString(existing?.label),
        webhookId: webhookId || undefined,
        webhookToken: webhookToken || undefined,
        boundBy:
          normalizeOptionalString(bindParams.boundBy) ??
          normalizeOptionalString(existing?.boundBy) ??
          "system",
        boundAt: now,
        lastActivityAt: now,
        idleTimeoutMs:
          typeof existing?.idleTimeoutMs === "number" ? existing.idleTimeoutMs : idleTimeoutMs,
        maxAgeMs: typeof existing?.maxAgeMs === "number" ? existing.maxAgeMs : maxAgeMs,
        metadata:
          bindParams.metadata && typeof bindParams.metadata === "object"
            ? { ...existing?.metadata, ...bindParams.metadata }
            : existing?.metadata
              ? { ...existing.metadata }
              : undefined,
      };

      setBindingRecord(record);
      if (persist) {
        saveBindingsToDisk();
      }

      const introText = bindParams.introText?.trim();
      if (introText) {
        void maybeSendBindingMessage({ cfg, record, text: introText });
      }
      return record;
    },
    unbindThread: (unbindParams) => {
      const bindingKey = resolveBindingRecordKey({
        accountId,
        threadId: unbindParams.threadId,
      });
      if (!bindingKey) {
        return null;
      }
      const existing = BINDINGS_BY_THREAD_ID.get(bindingKey);
      if (!existing || existing.accountId !== accountId) {
        return null;
      }
      const removed = removeBindingRecord(bindingKey);
      if (!removed) {
        return null;
      }
      rememberRecentUnboundWebhookEcho(removed);
      if (persist) {
        saveBindingsToDisk();
      }
      if (unbindParams.sendFarewell !== false) {
        const cfg = resolveCurrentCfg();
        const farewell = resolveThreadBindingFarewellText({
          reason: unbindParams.reason,
          farewellText: unbindParams.farewellText,
          idleTimeoutMs: resolveThreadBindingIdleTimeoutMs({
            record: removed,
            defaultIdleTimeoutMs: idleTimeoutMs,
          }),
          maxAgeMs: resolveThreadBindingMaxAgeMs({
            record: removed,
            defaultMaxAgeMs: maxAgeMs,
          }),
        });
        // Use bot send path for farewell messages so unbound threads don't process
        // webhook echoes as fresh inbound turns when allowBots is enabled.
        void maybeSendBindingMessage({
          cfg,
          record: removed,
          text: farewell,
          preferWebhook: false,
        });
      }
      return removed;
    },
    unbindBySessionKey: (unbindParams) => {
      const ids = resolveBindingIdsForSession({
        targetSessionKey: unbindParams.targetSessionKey,
        accountId,
        targetKind: unbindParams.targetKind,
      });
      if (ids.length === 0) {
        return [];
      }
      const removed: ThreadBindingRecord[] = [];
      for (const bindingKey of ids) {
        const binding = BINDINGS_BY_THREAD_ID.get(bindingKey);
        if (!binding) {
          continue;
        }
        const entry = manager.unbindThread({
          threadId: binding.threadId,
          reason: unbindParams.reason,
          sendFarewell: unbindParams.sendFarewell,
          farewellText: unbindParams.farewellText,
        });
        if (entry) {
          removed.push(entry);
        }
      }
      return removed;
    },
    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      SWEEPERS_BY_ACCOUNT_ID.delete(accountId);
      unregisterManager(accountId, manager);
      unregisterSessionBindingAdapter({
        channel: "discord",
        accountId,
        adapter: sessionBindingAdapter,
      });
      forgetThreadBindingToken(accountId);
    },
  };

  if (params.enableSweeper !== false) {
    sweepTimer = setInterval(() => {
      void runSweepOnce();
    }, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    // Keep the production process free to exit, but avoid breaking fake-timer
    // sweeper tests where unref'd intervals may never fire.
    if (!(process.env.VITEST || process.env.NODE_ENV === "test")) {
      sweepTimer.unref?.();
    }
  }

  const sessionBindingAdapter: SessionBindingAdapter = {
    channel: "discord",
    accountId,
    capabilities: {
      placements: ["current", "child"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== "discord") {
        return null;
      }
      const targetSessionKey = input.targetSessionKey.trim();
      if (!targetSessionKey) {
        return null;
      }
      const conversationId = normalizeOptionalString(input.conversation.conversationId) ?? "";
      const placement = input.placement === "child" ? "child" : "current";
      const metadata = input.metadata ?? {};
      const label = normalizeOptionalString(metadata.label);
      const threadName =
        typeof metadata.threadName === "string"
          ? normalizeOptionalString(metadata.threadName)
          : undefined;
      const introText =
        typeof metadata.introText === "string"
          ? normalizeOptionalString(metadata.introText)
          : undefined;
      const boundBy =
        typeof metadata.boundBy === "string"
          ? normalizeOptionalString(metadata.boundBy)
          : undefined;
      const agentId =
        typeof metadata.agentId === "string"
          ? normalizeOptionalString(metadata.agentId)
          : undefined;
      let threadId: string | undefined;
      let channelId = normalizeOptionalString(input.conversation.parentConversationId);
      let createThread = false;

      if (placement === "child") {
        createThread = true;
        if (!channelId && conversationId) {
          const cfg = resolveCurrentCfg();
          channelId =
            (await resolveChannelIdForBinding({
              cfg,
              accountId,
              token: resolveCurrentToken(),
              threadId: conversationId,
            })) ?? undefined;
        }
      } else {
        threadId = conversationId || undefined;
      }
      const bound = await manager.bindTarget({
        threadId,
        channelId,
        createThread,
        threadName,
        targetKind: toThreadBindingTargetKind(input.targetKind),
        targetSessionKey,
        agentId,
        label,
        boundBy,
        introText,
        metadata,
      });
      return bound
        ? toSessionBindingRecord(bound, {
            idleTimeoutMs,
            maxAgeMs,
          })
        : null;
    },
    listBySession: (targetSessionKey) =>
      manager
        .listBySessionKey(targetSessionKey)
        .map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs })),
    resolveByConversation: (ref) => {
      if (ref.channel !== "discord") {
        return null;
      }
      const binding = manager.getByThreadId(ref.conversationId);
      return binding ? toSessionBindingRecord(binding, { idleTimeoutMs, maxAgeMs }) : null;
    },
    touch: (bindingId, at) => {
      const threadId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId,
      });
      if (!threadId) {
        return;
      }
      manager.touchThread({ threadId, at, persist: true });
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        const removed = manager.unbindBySessionKey({
          targetSessionKey: input.targetSessionKey,
          reason: input.reason,
        });
        return removed.map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs }));
      }
      const threadId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!threadId) {
        return [];
      }
      const removed = manager.unbindThread({
        threadId,
        reason: input.reason,
      });
      return removed ? [toSessionBindingRecord(removed, { idleTimeoutMs, maxAgeMs })] : [];
    },
  };

  registerSessionBindingAdapter(sessionBindingAdapter);

  registerManager(manager);
  return manager;
}

export function createNoopThreadBindingManager(accountId?: string): ThreadBindingManager {
  return createNoopManager(accountId);
}

export function getThreadBindingManager(accountId?: string): ThreadBindingManager | null {
  const normalized = normalizeAccountId(accountId);
  return MANAGERS_BY_ACCOUNT_ID.get(normalized) ?? null;
}

export const __testing = {
  resolveThreadBindingsPath,
  resolveThreadBindingThreadName,
  resetThreadBindingsForTests,
  runThreadBindingSweepForAccount: async (accountId?: string) => {
    const sweep = SWEEPERS_BY_ACCOUNT_ID.get(normalizeAccountId(accountId));
    if (sweep) {
      await sweep();
    }
  },
};
