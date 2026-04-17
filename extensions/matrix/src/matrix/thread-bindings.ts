import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  registerSessionBindingAdapter,
  resolveThreadBindingFarewellText,
  type SessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/thread-bindings-runtime";
import { claimCurrentTokenStorageState, resolveMatrixStateFilePath } from "./client/storage.js";
import type { MatrixAuth } from "./client/types.js";
import type { MatrixClient } from "./sdk.js";
import { sendMessageMatrix } from "./send.js";
import {
  deleteMatrixThreadBindingManagerEntry,
  getMatrixThreadBindingManager,
  getMatrixThreadBindingManagerEntry,
  listBindingsForAccount,
  removeBindingRecord,
  resetMatrixThreadBindingsForTests,
  resolveBindingKey,
  resolveEffectiveBindingExpiry,
  setBindingRecord,
  setMatrixThreadBindingIdleTimeoutBySessionKey,
  setMatrixThreadBindingManagerEntry,
  setMatrixThreadBindingMaxAgeBySessionKey,
  toMatrixBindingTargetKind,
  toSessionBindingRecord,
  type MatrixThreadBindingManager,
  type MatrixThreadBindingRecord,
} from "./thread-bindings-shared.js";

const STORE_VERSION = 1;
const THREAD_BINDINGS_SWEEP_INTERVAL_MS = 60_000;
const TOUCH_PERSIST_DELAY_MS = 30_000;

type StoredMatrixThreadBindingState = {
  version: number;
  bindings: MatrixThreadBindingRecord[];
};

function _normalizeDurationMs(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(0, Math.floor(raw));
}

function resolveBindingsPath(params: {
  auth: MatrixAuth;
  accountId: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): string {
  return resolveMatrixStateFilePath({
    auth: params.auth,
    accountId: params.accountId,
    env: params.env,
    stateDir: params.stateDir,
    filename: "thread-bindings.json",
  });
}

async function loadBindingsFromDisk(filePath: string, accountId: string) {
  const { value } = await readJsonFileWithFallback<StoredMatrixThreadBindingState | null>(
    filePath,
    null,
  );
  if (value?.version !== STORE_VERSION || !Array.isArray(value.bindings)) {
    return [];
  }
  const loaded: MatrixThreadBindingRecord[] = [];
  for (const entry of value.bindings) {
    const conversationId = normalizeOptionalString(entry?.conversationId);
    const parentConversationId = normalizeOptionalString(entry?.parentConversationId);
    const targetSessionKey = normalizeOptionalString(entry?.targetSessionKey) ?? "";
    if (!conversationId || !targetSessionKey) {
      continue;
    }
    const boundAt =
      typeof entry?.boundAt === "number" && Number.isFinite(entry.boundAt)
        ? Math.floor(entry.boundAt)
        : Date.now();
    const lastActivityAt =
      typeof entry?.lastActivityAt === "number" && Number.isFinite(entry.lastActivityAt)
        ? Math.floor(entry.lastActivityAt)
        : boundAt;
    loaded.push({
      accountId,
      conversationId,
      ...(parentConversationId ? { parentConversationId } : {}),
      targetKind: entry?.targetKind === "subagent" ? "subagent" : "acp",
      targetSessionKey,
      agentId: normalizeOptionalString(entry?.agentId) || undefined,
      label: normalizeOptionalString(entry?.label) || undefined,
      boundBy: normalizeOptionalString(entry?.boundBy) || undefined,
      boundAt,
      lastActivityAt: Math.max(lastActivityAt, boundAt),
      idleTimeoutMs:
        typeof entry?.idleTimeoutMs === "number" && Number.isFinite(entry.idleTimeoutMs)
          ? Math.max(0, Math.floor(entry.idleTimeoutMs))
          : undefined,
      maxAgeMs:
        typeof entry?.maxAgeMs === "number" && Number.isFinite(entry.maxAgeMs)
          ? Math.max(0, Math.floor(entry.maxAgeMs))
          : undefined,
    });
  }
  return loaded;
}

function toStoredBindingsState(
  bindings: MatrixThreadBindingRecord[],
): StoredMatrixThreadBindingState {
  return {
    version: STORE_VERSION,
    bindings: [...bindings].toSorted((a, b) => a.boundAt - b.boundAt),
  };
}

async function persistBindingsSnapshot(
  filePath: string,
  bindings: MatrixThreadBindingRecord[],
): Promise<void> {
  await writeJsonFileAtomically(filePath, toStoredBindingsState(bindings));
  claimCurrentTokenStorageState({
    rootDir: path.dirname(filePath),
  });
}

function buildMatrixBindingIntroText(params: {
  metadata?: Record<string, unknown>;
  targetSessionKey: string;
}): string {
  const introText = normalizeOptionalString(params.metadata?.introText);
  if (introText) {
    return introText;
  }
  const label = normalizeOptionalString(params.metadata?.label);
  const agentId =
    normalizeOptionalString(params.metadata?.agentId) ||
    resolveAgentIdFromSessionKey(params.targetSessionKey);
  const base = label || agentId || "session";
  return `⚙️ ${base} session active. Messages here go directly to this session.`;
}

async function sendBindingMessage(params: {
  client: MatrixClient;
  accountId: string;
  roomId: string;
  threadId?: string;
  text: string;
}): Promise<string | null> {
  const trimmed = params.text.trim();
  if (!trimmed) {
    return null;
  }
  const result = await sendMessageMatrix(`room:${params.roomId}`, trimmed, {
    client: params.client,
    accountId: params.accountId,
    ...(params.threadId ? { threadId: params.threadId } : {}),
  });
  return result.messageId || null;
}

async function sendFarewellMessage(params: {
  client: MatrixClient;
  accountId: string;
  record: MatrixThreadBindingRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
  reason?: string;
}): Promise<void> {
  const roomId = params.record.parentConversationId ?? params.record.conversationId;
  const idleTimeoutMs =
    typeof params.record.idleTimeoutMs === "number"
      ? params.record.idleTimeoutMs
      : params.defaultIdleTimeoutMs;
  const maxAgeMs =
    typeof params.record.maxAgeMs === "number" ? params.record.maxAgeMs : params.defaultMaxAgeMs;
  const farewellText = resolveThreadBindingFarewellText({
    reason: params.reason,
    idleTimeoutMs,
    maxAgeMs,
  });
  await sendBindingMessage({
    client: params.client,
    accountId: params.accountId,
    roomId,
    threadId:
      params.record.parentConversationId &&
      params.record.parentConversationId !== params.record.conversationId
        ? params.record.conversationId
        : undefined,
    text: farewellText,
  }).catch(() => {});
}

export async function createMatrixThreadBindingManager(params: {
  accountId: string;
  auth: MatrixAuth;
  client: MatrixClient;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  idleTimeoutMs: number;
  maxAgeMs: number;
  enableSweeper?: boolean;
  logVerboseMessage?: (message: string) => void;
}): Promise<MatrixThreadBindingManager> {
  if (params.auth.accountId !== params.accountId) {
    throw new Error(
      `Matrix thread binding account mismatch: requested ${params.accountId}, auth resolved ${params.auth.accountId}`,
    );
  }
  const filePath = resolveBindingsPath({
    auth: params.auth,
    accountId: params.accountId,
    env: params.env,
    stateDir: params.stateDir,
  });
  const existingEntry = getMatrixThreadBindingManagerEntry(params.accountId);
  if (existingEntry) {
    if (existingEntry.filePath === filePath) {
      return existingEntry.manager;
    }
    existingEntry.manager.stop();
  }
  const loaded = await loadBindingsFromDisk(filePath, params.accountId);
  for (const record of loaded) {
    setBindingRecord(record);
  }

  let persistQueue: Promise<void> = Promise.resolve();
  const enqueuePersist = (bindings?: MatrixThreadBindingRecord[]) => {
    const snapshot = bindings ?? listBindingsForAccount(params.accountId);
    const next = persistQueue
      .catch(() => {})
      .then(async () => {
        await persistBindingsSnapshot(filePath, snapshot);
      });
    persistQueue = next;
    return next;
  };
  const persist = async () => await enqueuePersist();
  const persistSafely = (reason: string, bindings?: MatrixThreadBindingRecord[]) => {
    void enqueuePersist(bindings).catch((err) => {
      params.logVerboseMessage?.(
        `matrix: failed persisting thread bindings account=${params.accountId} action=${reason}: ${String(err)}`,
      );
    });
  };
  const defaults = {
    idleTimeoutMs: params.idleTimeoutMs,
    maxAgeMs: params.maxAgeMs,
  };
  let persistTimer: NodeJS.Timeout | null = null;
  const schedulePersist = (delayMs: number) => {
    if (persistTimer) {
      return;
    }
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistSafely("delayed-touch");
    }, delayMs);
    persistTimer.unref?.();
  };
  const updateBindingsBySessionKey = (input: {
    targetSessionKey: string;
    update: (entry: MatrixThreadBindingRecord, now: number) => MatrixThreadBindingRecord;
    persistReason: string;
  }): MatrixThreadBindingRecord[] => {
    const targetSessionKey = input.targetSessionKey.trim();
    if (!targetSessionKey) {
      return [];
    }
    const now = Date.now();
    const nextBindings = listBindingsForAccount(params.accountId)
      .filter((entry) => entry.targetSessionKey === targetSessionKey)
      .map((entry) => input.update(entry, now));
    if (nextBindings.length === 0) {
      return [];
    }
    for (const entry of nextBindings) {
      setBindingRecord(entry);
    }
    persistSafely(input.persistReason);
    return nextBindings;
  };

  const manager: MatrixThreadBindingManager = {
    accountId: params.accountId,
    getIdleTimeoutMs: () => defaults.idleTimeoutMs,
    getMaxAgeMs: () => defaults.maxAgeMs,
    persist,
    getByConversation: ({ conversationId, parentConversationId }) =>
      listBindingsForAccount(params.accountId).find((entry) => {
        if (entry.conversationId !== conversationId.trim()) {
          return false;
        }
        if (!parentConversationId) {
          return true;
        }
        return (entry.parentConversationId ?? "") === parentConversationId.trim();
      }),
    listBySessionKey: (targetSessionKey) =>
      listBindingsForAccount(params.accountId).filter(
        (entry) => entry.targetSessionKey === targetSessionKey.trim(),
      ),
    listBindings: () => listBindingsForAccount(params.accountId),
    touchBinding: (bindingId, at) => {
      const record = listBindingsForAccount(params.accountId).find(
        (entry) => resolveBindingKey(entry) === bindingId.trim(),
      );
      if (!record) {
        return null;
      }
      const nextRecord = {
        ...record,
        lastActivityAt:
          typeof at === "number" && Number.isFinite(at)
            ? Math.max(record.lastActivityAt, Math.floor(at))
            : Date.now(),
      };
      setBindingRecord(nextRecord);
      schedulePersist(TOUCH_PERSIST_DELAY_MS);
      return nextRecord;
    },
    setIdleTimeoutBySessionKey: ({ targetSessionKey, idleTimeoutMs }) => {
      return updateBindingsBySessionKey({
        targetSessionKey,
        persistReason: "idle-timeout-update",
        update: (entry, now) => ({
          ...entry,
          idleTimeoutMs: Math.max(0, Math.floor(idleTimeoutMs)),
          lastActivityAt: now,
        }),
      });
    },
    setMaxAgeBySessionKey: ({ targetSessionKey, maxAgeMs }) => {
      return updateBindingsBySessionKey({
        targetSessionKey,
        persistReason: "max-age-update",
        update: (entry, now) => ({
          ...entry,
          maxAgeMs: Math.max(0, Math.floor(maxAgeMs)),
          lastActivityAt: now,
        }),
      });
    },
    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
      }
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
        persistSafely("shutdown-flush");
      }
      unregisterSessionBindingAdapter({
        channel: "matrix",
        accountId: params.accountId,
        adapter: sessionBindingAdapter,
      });
      if (getMatrixThreadBindingManagerEntry(params.accountId)?.manager === manager) {
        deleteMatrixThreadBindingManagerEntry(params.accountId);
      }
      for (const record of listBindingsForAccount(params.accountId)) {
        removeBindingRecord(record);
      }
    },
  };

  let sweepTimer: NodeJS.Timeout | null = null;
  const removeRecords = (records: MatrixThreadBindingRecord[]) => {
    if (records.length === 0) {
      return [];
    }
    return records
      .map((record) => removeBindingRecord(record))
      .filter((record): record is MatrixThreadBindingRecord => Boolean(record));
  };
  const sendFarewellMessages = async (
    removed: MatrixThreadBindingRecord[],
    reason: string | ((record: MatrixThreadBindingRecord) => string | undefined),
  ) => {
    await Promise.all(
      removed.map(async (record) => {
        await sendFarewellMessage({
          client: params.client,
          accountId: params.accountId,
          record,
          defaultIdleTimeoutMs: defaults.idleTimeoutMs,
          defaultMaxAgeMs: defaults.maxAgeMs,
          reason: typeof reason === "function" ? reason(record) : reason,
        });
      }),
    );
  };
  const unbindRecords = async (records: MatrixThreadBindingRecord[], reason: string) => {
    const removed = removeRecords(records);
    if (removed.length === 0) {
      return [];
    }
    await persist();
    await sendFarewellMessages(removed, reason);
    return removed.map((record) => toSessionBindingRecord(record, defaults));
  };

  const sessionBindingAdapter: SessionBindingAdapter = {
    channel: "matrix",
    accountId: params.accountId,
    capabilities: { placements: ["current", "child"], bindSupported: true, unbindSupported: true },
    bind: async (input) => {
      const conversationId = input.conversation.conversationId.trim();
      const parentConversationId = normalizeOptionalString(input.conversation.parentConversationId);
      const targetSessionKey = input.targetSessionKey.trim();
      if (!conversationId || !targetSessionKey) {
        return null;
      }

      let boundConversationId = conversationId;
      let boundParentConversationId = parentConversationId;
      const introText = buildMatrixBindingIntroText({
        metadata: input.metadata,
        targetSessionKey,
      });

      if (input.placement === "child") {
        const roomId = parentConversationId || conversationId;
        const rootEventId = await sendBindingMessage({
          client: params.client,
          accountId: params.accountId,
          roomId,
          text: introText,
        });
        if (!rootEventId) {
          return null;
        }
        boundConversationId = rootEventId;
        boundParentConversationId = roomId;
      }

      const now = Date.now();
      const record: MatrixThreadBindingRecord = {
        accountId: params.accountId,
        conversationId: boundConversationId,
        ...(boundParentConversationId ? { parentConversationId: boundParentConversationId } : {}),
        targetKind: toMatrixBindingTargetKind(input.targetKind),
        targetSessionKey,
        agentId:
          normalizeOptionalString(input.metadata?.agentId) ||
          resolveAgentIdFromSessionKey(targetSessionKey),
        label: normalizeOptionalString(input.metadata?.label) || undefined,
        boundBy: normalizeOptionalString(input.metadata?.boundBy) || "system",
        boundAt: now,
        lastActivityAt: now,
        idleTimeoutMs: defaults.idleTimeoutMs,
        maxAgeMs: defaults.maxAgeMs,
      };
      setBindingRecord(record);
      await persist();

      if (input.placement === "current" && introText) {
        const roomId = boundParentConversationId || boundConversationId;
        const threadId =
          boundParentConversationId && boundParentConversationId !== boundConversationId
            ? boundConversationId
            : undefined;
        await sendBindingMessage({
          client: params.client,
          accountId: params.accountId,
          roomId,
          threadId,
          text: introText,
        }).catch(() => {});
      }

      return toSessionBindingRecord(record, defaults);
    },
    listBySession: (targetSessionKey) =>
      manager
        .listBySessionKey(targetSessionKey)
        .map((record) => toSessionBindingRecord(record, defaults)),
    resolveByConversation: (ref) => {
      const record = manager.getByConversation({
        conversationId: ref.conversationId,
        parentConversationId: ref.parentConversationId,
      });
      return record ? toSessionBindingRecord(record, defaults) : null;
    },
    touch: (bindingId, at) => {
      manager.touchBinding(bindingId, at);
    },
    unbind: async (input) => {
      const removed = await unbindRecords(
        listBindingsForAccount(params.accountId).filter((record) => {
          if (input.bindingId?.trim()) {
            return resolveBindingKey(record) === input.bindingId.trim();
          }
          if (input.targetSessionKey?.trim()) {
            return record.targetSessionKey === input.targetSessionKey.trim();
          }
          return false;
        }),
        input.reason,
      );
      return removed;
    },
  };

  registerSessionBindingAdapter(sessionBindingAdapter);

  if (params.enableSweeper !== false) {
    sweepTimer = setInterval(() => {
      const now = Date.now();
      const expired = listBindingsForAccount(params.accountId)
        .map((record) => ({
          record,
          lifecycle: resolveEffectiveBindingExpiry({
            record,
            defaultIdleTimeoutMs: defaults.idleTimeoutMs,
            defaultMaxAgeMs: defaults.maxAgeMs,
          }),
        }))
        .filter(
          (
            entry,
          ): entry is {
            record: MatrixThreadBindingRecord;
            lifecycle: { expiresAt: number; reason: "idle-expired" | "max-age-expired" };
          } =>
            typeof entry.lifecycle.expiresAt === "number" &&
            entry.lifecycle.expiresAt <= now &&
            Boolean(entry.lifecycle.reason),
        );
      if (expired.length === 0) {
        return;
      }
      const reasonByBindingKey = new Map(
        expired.map(({ record, lifecycle }) => [resolveBindingKey(record), lifecycle.reason]),
      );
      void (async () => {
        const removed = removeRecords(expired.map(({ record }) => record));
        if (removed.length === 0) {
          return;
        }
        for (const record of removed) {
          const reason = reasonByBindingKey.get(resolveBindingKey(record));
          params.logVerboseMessage?.(
            `matrix: auto-unbinding ${record.conversationId} due to ${reason}`,
          );
        }
        await persist();
        await sendFarewellMessages(removed, (record) =>
          reasonByBindingKey.get(resolveBindingKey(record)),
        );
      })().catch((err) => {
        params.logVerboseMessage?.(
          `matrix: failed auto-unbinding expired bindings account=${params.accountId}: ${String(err)}`,
        );
      });
    }, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  setMatrixThreadBindingManagerEntry(params.accountId, {
    filePath,
    manager,
  });
  return manager;
}
export {
  getMatrixThreadBindingManager,
  resetMatrixThreadBindingsForTests,
  setMatrixThreadBindingIdleTimeoutBySessionKey,
  setMatrixThreadBindingMaxAgeBySessionKey,
};
