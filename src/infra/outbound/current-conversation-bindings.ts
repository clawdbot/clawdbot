import fs from "node:fs";
import path from "node:path";
import { normalizeConversationText } from "../../acp/conversation-id.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { resolveStateDir } from "../../config/paths.js";
import { loadJsonFile } from "../../infra/json-file.js";
import { saveJsonFile } from "../../plugin-sdk/json-store.js";
import { getActivePluginChannelRegistryFromState } from "../../plugins/runtime-state.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { normalizeConversationRef } from "./session-binding-normalization.js";
import type {
  ConversationRef,
  SessionBindingBindInput,
  SessionBindingCapabilities,
  SessionBindingRecord,
  SessionBindingUnbindInput,
} from "./session-binding.types.js";

type PersistedCurrentConversationBindingsFile = {
  version: 1;
  bindings: SessionBindingRecord[];
};

const CURRENT_BINDINGS_FILE_VERSION = 1;
const CURRENT_BINDINGS_ID_PREFIX = "generic:";

let bindingsLoaded = false;
const bindingsByConversationKey = new Map<string, SessionBindingRecord>();

function buildConversationKey(ref: ConversationRef): string {
  const normalized = normalizeConversationRef(ref);
  return [
    normalized.channel,
    normalized.accountId,
    normalized.parentConversationId ?? "",
    normalized.conversationId,
  ].join("\u241f");
}

function buildBindingId(ref: ConversationRef): string {
  return `${CURRENT_BINDINGS_ID_PREFIX}${buildConversationKey(ref)}`;
}

function resolveBindingsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "bindings", "current-conversations.json");
}

function isBindingExpired(record: SessionBindingRecord, now = Date.now()): boolean {
  return typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)
    ? record.expiresAt <= now
    : false;
}

function toPersistedFile(): PersistedCurrentConversationBindingsFile {
  const bindings = [...bindingsByConversationKey.values()]
    .filter((record) => !isBindingExpired(record))
    .toSorted((a, b) => a.bindingId.localeCompare(b.bindingId));
  return {
    version: CURRENT_BINDINGS_FILE_VERSION,
    bindings,
  };
}

function loadBindingsIntoMemory(): void {
  if (bindingsLoaded) {
    return;
  }
  bindingsLoaded = true;
  bindingsByConversationKey.clear();
  const parsed = loadJsonFile(resolveBindingsFilePath()) as
    | PersistedCurrentConversationBindingsFile
    | undefined;
  const bindings = parsed?.version === CURRENT_BINDINGS_FILE_VERSION ? parsed.bindings : [];
  for (const record of bindings ?? []) {
    if (!record?.bindingId || !record?.conversation?.conversationId || isBindingExpired(record)) {
      continue;
    }
    const conversation = normalizeConversationRef(record.conversation);
    const targetSessionKey = record.targetSessionKey?.trim() ?? "";
    if (!targetSessionKey) {
      continue;
    }
    bindingsByConversationKey.set(buildConversationKey(conversation), {
      ...record,
      bindingId: buildBindingId(conversation),
      targetSessionKey,
      conversation,
    });
  }
}

function persistBindingsToDisk(): void {
  saveJsonFile(resolveBindingsFilePath(), toPersistedFile());
}

function pruneExpiredBinding(key: string): SessionBindingRecord | null {
  loadBindingsIntoMemory();
  const record = bindingsByConversationKey.get(key) ?? null;
  if (!record) {
    return null;
  }
  if (!isBindingExpired(record)) {
    return record;
  }
  bindingsByConversationKey.delete(key);
  persistBindingsToDisk();
  return null;
}

function resolveChannelSupportsCurrentConversationBinding(channel: string): boolean {
  const normalized =
    normalizeAnyChannelId(channel) ??
    normalizeOptionalLowercaseString(normalizeConversationText(channel));
  if (!normalized) {
    return false;
  }
  const matchesPluginId = (plugin: { id: string; meta?: { aliases?: readonly string[] } }) =>
    plugin.id === normalized ||
    (plugin.meta?.aliases ?? []).some(
      (alias) => normalizeOptionalLowercaseString(alias) === normalized,
    );
  // Read the already-installed runtime channel registry from shared state only.
  // Importing plugins/runtime here creates a module cycle through plugin-sdk
  // surfaces during bundled channel discovery.
  const plugin = getActivePluginChannelRegistryFromState()?.channels.find((entry) =>
    matchesPluginId(entry.plugin),
  )?.plugin;
  if (plugin?.conversationBindings?.supportsCurrentConversationBinding === true) {
    return true;
  }
  return false;
}

export function getGenericCurrentConversationBindingCapabilities(params: {
  channel: string;
  accountId: string;
}): SessionBindingCapabilities | null {
  void params.accountId;
  if (!resolveChannelSupportsCurrentConversationBinding(params.channel)) {
    return null;
  }
  return {
    adapterAvailable: true,
    bindSupported: true,
    unbindSupported: true,
    placements: ["current"],
  };
}

export async function bindGenericCurrentConversation(
  input: SessionBindingBindInput,
): Promise<SessionBindingRecord | null> {
  const conversation = normalizeConversationRef(input.conversation);
  const targetSessionKey = input.targetSessionKey.trim();
  if (!conversation.channel || !conversation.conversationId || !targetSessionKey) {
    return null;
  }
  loadBindingsIntoMemory();
  const now = Date.now();
  const ttlMs =
    typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs)
      ? Math.max(0, Math.floor(input.ttlMs))
      : undefined;
  const key = buildConversationKey(conversation);
  const existing = pruneExpiredBinding(key);
  const record: SessionBindingRecord = {
    bindingId: buildBindingId(conversation),
    targetSessionKey,
    targetKind: input.targetKind,
    conversation,
    status: "active",
    boundAt: now,
    ...(ttlMs != null ? { expiresAt: now + ttlMs } : {}),
    metadata: {
      ...existing?.metadata,
      ...input.metadata,
      lastActivityAt: now,
    },
  };
  bindingsByConversationKey.set(key, record);
  persistBindingsToDisk();
  return record;
}

export function resolveGenericCurrentConversationBinding(
  ref: ConversationRef,
): SessionBindingRecord | null {
  return pruneExpiredBinding(buildConversationKey(ref));
}

export function listGenericCurrentConversationBindingsBySession(
  targetSessionKey: string,
): SessionBindingRecord[] {
  loadBindingsIntoMemory();
  const results: SessionBindingRecord[] = [];
  for (const key of bindingsByConversationKey.keys()) {
    const record = pruneExpiredBinding(key);
    if (!record || record.targetSessionKey !== targetSessionKey) {
      continue;
    }
    results.push(record);
  }
  return results;
}

export function touchGenericCurrentConversationBinding(bindingId: string, at = Date.now()): void {
  loadBindingsIntoMemory();
  if (!bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX)) {
    return;
  }
  const key = bindingId.slice(CURRENT_BINDINGS_ID_PREFIX.length);
  const record = pruneExpiredBinding(key);
  if (!record) {
    return;
  }
  bindingsByConversationKey.set(key, {
    ...record,
    metadata: {
      ...record.metadata,
      lastActivityAt: at,
    },
  });
  persistBindingsToDisk();
}

export async function unbindGenericCurrentConversationBindings(
  input: SessionBindingUnbindInput,
): Promise<SessionBindingRecord[]> {
  loadBindingsIntoMemory();
  const removed: SessionBindingRecord[] = [];
  const normalizedBindingId = input.bindingId?.trim();
  const normalizedTargetSessionKey = input.targetSessionKey?.trim();
  if (normalizedBindingId?.startsWith(CURRENT_BINDINGS_ID_PREFIX)) {
    const key = normalizedBindingId.slice(CURRENT_BINDINGS_ID_PREFIX.length);
    const record = pruneExpiredBinding(key);
    if (record) {
      bindingsByConversationKey.delete(key);
      removed.push(record);
      persistBindingsToDisk();
    }
    return removed;
  }
  if (!normalizedTargetSessionKey) {
    return removed;
  }
  for (const key of bindingsByConversationKey.keys()) {
    const record = pruneExpiredBinding(key);
    if (!record || record.targetSessionKey !== normalizedTargetSessionKey) {
      continue;
    }
    bindingsByConversationKey.delete(key);
    removed.push(record);
  }
  if (removed.length > 0) {
    persistBindingsToDisk();
  }
  return removed;
}

export const __testing = {
  resetCurrentConversationBindingsForTests(params?: {
    deletePersistedFile?: boolean;
    env?: NodeJS.ProcessEnv;
  }) {
    bindingsLoaded = false;
    bindingsByConversationKey.clear();
    if (params?.deletePersistedFile) {
      const filePath = resolveBindingsFilePath(params.env);
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // ignore test cleanup failures
      }
    }
  },
  resolveBindingsFilePath,
};
