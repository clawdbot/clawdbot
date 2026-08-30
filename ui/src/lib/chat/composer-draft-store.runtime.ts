// Keep IndexedDB outside the startup graph; composers and session deletion load it on demand.
import type { ChatGoalDraftMode, DurableComposerDraftAttachment } from "./chat-types.ts";
import {
  openControlUiDatabase,
  requestResult,
  transactionComplete,
} from "./control-ui-database.runtime.ts";
import { isChatGoalDraftMode } from "./goal-draft.ts";
import { parseStoredChatOutboxScope, storedChatOutboxScopeKey } from "./outbox-store.ts";

const STORE_NAME = "composerDrafts";
const OWNER_INDEX = "ownerKey";
const CHAT_SCOPE_PREFIX = "chat:v3:";
const DRAFT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_ACTIVE_DRAFTS_PER_OWNER = 20;
const MAX_DURABLE_DRAFT_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type DurableComposerDraftScope = {
  gatewayOwner: string;
  recoveryScope: string;
  scopeKey: string;
};

type DurableComposerDraft = {
  revision: number;
  text: string;
  goalMode?: ChatGoalDraftMode;
  attachments: DurableComposerDraftAttachment[];
};

type ReadDurableComposerDraft = DurableComposerDraft & { writeId: string };

type StoredDurableComposerDraft = DurableComposerDraft & {
  key: string;
  ownerKey: string;
  gatewayOwner: string;
  recoveryScope: string;
  scopeKey: string;
  updatedAt: number;
  writeId: string;
};

type DurableComposerDraftReadResult =
  | { status: "found"; draft: ReadDurableComposerDraft }
  | { status: "not-found"; revision?: number; writeId?: string }
  | { status: "storage-failed" };

type DurableComposerDraftWriteResult =
  | { status: "persisted"; revision?: number; writeId?: string }
  | { status: "conflict" }
  | { status: "payload-too-large"; revision?: number; writeId?: string }
  | { status: "storage-failed" };

let lastFenceRevision = 0;

let sweptDatabase: IDBDatabase | null = null;
async function openDraftDatabase(): Promise<IDBDatabase> {
  const database = await openControlUiDatabase();
  if (sweptDatabase !== database) {
    sweptDatabase = database;
    // Draft expiry never visits outbox payloads: live queues have no age limit.
    globalThis.setTimeout(() => void sweepExpiredRecords(database).catch(() => undefined), 0);
  }
  return database;
}

function ownerKey(scope: DurableComposerDraftScope): string {
  return JSON.stringify([scope.gatewayOwner, scope.recoveryScope]);
}

function recordKey(scope: DurableComposerDraftScope): string {
  return JSON.stringify([scope.gatewayOwner, scope.recoveryScope, scope.scopeKey]);
}

function nextFenceRevision(baseline: number): number {
  const revision = Math.max(Date.now(), baseline + 1, lastFenceRevision + 1);
  lastFenceRevision = revision;
  return revision;
}

function isStoredAttachment(value: unknown): value is DurableComposerDraftAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }
  // SAFETY: IDB data is untrusted; every consumed field is validated below.
  const attachment = value as Partial<DurableComposerDraftAttachment>;
  return attachment.blob instanceof Blob && typeof attachment.mimeType === "string";
}

function parseStoredDraft(value: unknown): StoredDurableComposerDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  // SAFETY: IDB data is untrusted; every required record field is validated below.
  const record = value as Partial<StoredDurableComposerDraft>;
  if (
    typeof record.key !== "string" ||
    typeof record.ownerKey !== "string" ||
    typeof record.gatewayOwner !== "string" ||
    typeof record.recoveryScope !== "string" ||
    typeof record.scopeKey !== "string" ||
    typeof record.updatedAt !== "number" ||
    typeof record.writeId !== "string" ||
    typeof record.text !== "string" ||
    (record.goalMode !== undefined && !isChatGoalDraftMode(record.goalMode)) ||
    typeof record.revision !== "number" ||
    !Number.isSafeInteger(record.revision) ||
    record.revision <= 0 ||
    !Array.isArray(record.attachments) ||
    !record.attachments.every(isStoredAttachment)
  ) {
    return null;
  }
  // SAFETY: the complete stored shape and every attachment payload were validated above.
  return record as StoredDurableComposerDraft;
}

function isActiveDraft(record: StoredDurableComposerDraft): boolean {
  return Boolean(record.text || record.goalMode || record.attachments.length > 0);
}

function tombstone(record: StoredDurableComposerDraft, now: number): StoredDurableComposerDraft {
  const revision = nextFenceRevision(record.revision);
  return {
    ...record,
    revision,
    text: "",
    goalMode: undefined,
    attachments: [],
    updatedAt: now,
    writeId: `fence:${revision}`,
  };
}

function expiredRecord(
  record: StoredDurableComposerDraft,
  now: number,
): StoredDurableComposerDraft | null | undefined {
  // Old chat identities may have collapsed main into global. Keep these bounded
  // drafts (including blobs) until migration or explicit destination confirmation.
  if (isLegacyChatDraft(record) || record.updatedAt > now - DRAFT_EXPIRY_MS) {
    return undefined;
  }
  return isActiveDraft(record) ? tombstone(record, now) : null;
}

async function sweepExpiredRecords(database: IDBDatabase): Promise<void> {
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const now = Date.now();
  const request = store.openCursor();
  request.addEventListener("success", () => {
    try {
      const cursor = request.result;
      if (!cursor) {
        return;
      }
      const record = parseStoredDraft(cursor.value);
      const expired = record ? expiredRecord(record, now) : undefined;
      if (expired === null) {
        cursor.delete();
      } else if (expired) {
        cursor.update(expired);
      }
      cursor.continue();
    } catch {
      transaction.abort();
    }
  });
  await transactionComplete(transaction);
}

async function pruneOwnerRecords(
  store: IDBObjectStore,
  currentOwnerKey: string,
  now: number,
): Promise<void> {
  const values: unknown[] = await requestResult(store.index(OWNER_INDEX).getAll(currentOwnerKey));
  const records = values.flatMap((value) => {
    const record = parseStoredDraft(value);
    return record ? [record] : [];
  });
  const active: StoredDurableComposerDraft[] = [];
  for (const record of records) {
    const expired = expiredRecord(record, now);
    if (expired === null) {
      store.delete(record.key);
      continue;
    }
    if (expired) {
      store.put(expired);
      continue;
    }
    if (isActiveDraft(record) && !isLegacyChatDraft(record)) {
      active.push(record);
    }
  }
  active.sort((left, right) => right.updatedAt - left.updatedAt);
  for (const record of active.slice(MAX_ACTIVE_DRAFTS_PER_OWNER)) {
    store.put(tombstone(record, now));
  }
}

function isLegacyChatDraft(record: StoredDurableComposerDraft): boolean {
  return (
    !record.scopeKey.startsWith(CHAT_SCOPE_PREFIX) &&
    record.scopeKey.includes("\u0000agent:") &&
    isActiveDraft(record)
  );
}

export type DurableComposerRecoveryEntry = {
  scopeKey: string;
  revision: number;
  writeId: string;
  text: string;
  attachmentNames: string[];
};

/** One transaction moves identifiable legacy rows; collisions and global stay unsent. */
export async function prepareDurableComposerRecovery(
  owner: Pick<DurableComposerDraftScope, "gatewayOwner" | "recoveryScope">,
): Promise<
  { status: "ready"; entries: DurableComposerRecoveryEntry[] } | { status: "storage-failed" }
> {
  let transaction: IDBTransaction | undefined;
  try {
    const database = await openDraftDatabase();
    transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const values: unknown[] = await requestResult(
      store.index(OWNER_INDEX).getAll(ownerKey({ ...owner, scopeKey: "" })),
    );
    const records = values.map(parseStoredDraft).filter((record) => record !== null);
    const entries: DurableComposerRecoveryEntry[] = [];
    let activeCount = records.filter(
      (record) => isActiveDraft(record) && !isLegacyChatDraft(record),
    ).length;
    for (const record of records) {
      if (!isLegacyChatDraft(record)) {
        continue;
      }
      if (
        record.gatewayOwner !== owner.gatewayOwner ||
        record.recoveryScope !== owner.recoveryScope
      ) {
        throw new Error("Composer recovery owner mismatch");
      }
      const originalScope = parseStoredChatOutboxScope(record.scopeKey);
      const identifiable = originalScope && !["global", "main"].includes(originalScope.sessionKey);
      const scope = {
        ...owner,
        scopeKey: `${CHAT_SCOPE_PREFIX}${originalScope ? storedChatOutboxScopeKey(originalScope) : record.scopeKey}`,
      };
      const destination = identifiable
        ? await requestResult(store.get(recordKey(scope)))
        : undefined;
      const retired = parseStoredDraft(destination);
      // Only an exact known target can retire its older draft. Today's config
      // cannot identify an old global bucket or retarget a qualified main key.
      if (
        identifiable &&
        retired &&
        !isActiveDraft(retired) &&
        retired.revision > record.revision
      ) {
        store.put(tombstone(record, Date.now()));
      } else if (
        identifiable &&
        activeCount < MAX_ACTIVE_DRAFTS_PER_OWNER &&
        destination === undefined
      ) {
        store.put({
          ...record,
          key: recordKey(scope),
          scopeKey: scope.scopeKey,
          updatedAt: Date.now(),
        });
        activeCount++;
        store.put(tombstone(record, Date.now()));
      } else {
        entries.push({
          scopeKey: record.scopeKey,
          revision: record.revision,
          writeId: record.writeId,
          text: record.text,
          attachmentNames: record.attachments.map((a) => a.fileName ?? a.mimeType),
        });
      }
    }
    await transactionComplete(transaction);
    return { status: "ready", entries };
  } catch {
    // A synchronous clone/validation error does not abort IndexedDB by itself.
    // Never commit only one side of a recovery transfer.
    try {
      transaction?.abort();
    } catch {
      /* The transaction already settled. */
    }
    return { status: "storage-failed" };
  }
}

export async function restoreDurableComposerRecovery(
  destination: DurableComposerDraftScope,
  source: DurableComposerRecoveryEntry,
  expectedDestinationRevision: number,
  expectedDestinationWriteId: string | undefined,
  isCurrent: () => boolean,
  minimumRevision: number,
): Promise<DurableComposerDraftWriteResult> {
  let transaction: IDBTransaction | undefined;
  try {
    const database = await openDraftDatabase();
    transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const original = parseStoredDraft(
      await requestResult(store.get(recordKey({ ...destination, scopeKey: source.scopeKey }))),
    );
    const current = parseStoredDraft(await requestResult(store.get(recordKey(destination))));
    if (
      !isCurrent() ||
      !original ||
      !isLegacyChatDraft(original) ||
      original.gatewayOwner !== destination.gatewayOwner ||
      original.recoveryScope !== destination.recoveryScope ||
      original.revision !== source.revision ||
      original.writeId !== source.writeId ||
      (current?.revision ?? 0) !== expectedDestinationRevision ||
      current?.writeId !== expectedDestinationWriteId ||
      (current && isActiveDraft(current))
    ) {
      transaction.abort();
      return { status: "conflict" };
    }
    const revision = nextFenceRevision(
      Math.max(minimumRevision, original.revision, current?.revision ?? 0),
    );
    store.put({
      ...original,
      key: recordKey(destination),
      scopeKey: destination.scopeKey,
      revision,
      writeId: `recovered:${revision}`,
      updatedAt: Date.now(),
    });
    store.put(tombstone(original, Date.now()));
    await transactionComplete(transaction);
    return { status: "persisted", revision };
  } catch {
    // A synchronous clone/validation error does not abort IndexedDB by itself.
    // Never commit only one side of a recovery transfer.
    try {
      transaction?.abort();
    } catch {
      /* The transaction already settled. */
    }
    return { status: "storage-failed" };
  }
}

export async function readDurableComposerDraft(
  scope: DurableComposerDraftScope,
): Promise<DurableComposerDraftReadResult> {
  try {
    const database = await openDraftDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const value = await requestResult(store.get(recordKey(scope)));
    const record = parseStoredDraft(value);
    const now = Date.now();
    if (!record) {
      if (value !== undefined) {
        store.delete(recordKey(scope));
      }
      await transactionComplete(transaction);
      return { status: "not-found" };
    }
    if (
      record.gatewayOwner !== scope.gatewayOwner ||
      record.recoveryScope !== scope.recoveryScope ||
      record.scopeKey !== scope.scopeKey
    ) {
      transaction.abort();
      return { status: "storage-failed" };
    }
    const expired = expiredRecord(record, now);
    if (expired === null) {
      store.delete(record.key);
      await transactionComplete(transaction);
      return { status: "not-found" };
    }
    if (expired) {
      store.put(expired);
      await transactionComplete(transaction);
      return { status: "not-found", revision: expired.revision, writeId: expired.writeId };
    }
    await transactionComplete(transaction);
    if (!isActiveDraft(record)) {
      return { status: "not-found", revision: record.revision, writeId: record.writeId };
    }
    return {
      status: "found",
      draft: {
        revision: record.revision,
        writeId: record.writeId,
        text: record.text,
        ...(record.goalMode ? { goalMode: record.goalMode } : {}),
        attachments: record.attachments,
      },
    };
  } catch {
    return { status: "storage-failed" };
  }
}

export async function writeDurableComposerDraft(
  scope: DurableComposerDraftScope,
  draft: DurableComposerDraft,
  options: {
    expectedRevision: number;
    expectedWriteId?: string;
    expectedWriteIds?: readonly string[];
    writeId: string;
  },
): Promise<DurableComposerDraftWriteResult> {
  const payloadBytes = draft.attachments.reduce((total, attachment) => {
    return total + attachment.blob.size;
  }, 0);
  if (payloadBytes > MAX_DURABLE_DRAFT_ATTACHMENT_BYTES) {
    const fallbackResult = await writeDurableComposerDraft(
      scope,
      { revision: draft.revision, text: draft.text, goalMode: draft.goalMode, attachments: [] },
      options,
    );
    return fallbackResult.status === "persisted"
      ? {
          status: "payload-too-large",
          revision: fallbackResult.revision,
          writeId: fallbackResult.writeId,
        }
      : fallbackResult;
  }
  try {
    const database = await openDraftDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const key = recordKey(scope);
    const current = parseStoredDraft(await requestResult(store.get(key)));
    if (current?.revision === draft.revision) {
      transaction.abort();
      return current.writeId === options.writeId
        ? { status: "persisted", revision: current.revision, writeId: current.writeId }
        : { status: "conflict" };
    }
    const expectedCurrent = current
      ? (current.revision === options.expectedRevision &&
          (options.expectedWriteId === undefined || current.writeId === options.expectedWriteId)) ||
        options.expectedWriteIds?.includes(current.writeId) === true
      : options.expectedRevision === 0 && options.expectedWriteId === undefined;
    if (!expectedCurrent || (current?.revision ?? 0) > draft.revision) {
      transaction.abort();
      return { status: "conflict" };
    }
    const now = Date.now();
    const record: StoredDurableComposerDraft = {
      key,
      ownerKey: ownerKey(scope),
      gatewayOwner: scope.gatewayOwner,
      recoveryScope: scope.recoveryScope,
      scopeKey: scope.scopeKey,
      revision: draft.revision,
      text: draft.text,
      ...(draft.goalMode ? { goalMode: draft.goalMode } : {}),
      attachments: draft.attachments,
      updatedAt: now,
      writeId: options.writeId,
    };
    store.put(record);
    await pruneOwnerRecords(store, record.ownerKey, now);
    await transactionComplete(transaction);
    return { status: "persisted", revision: draft.revision, writeId: options.writeId };
  } catch {
    return { status: "storage-failed" };
  }
}

export async function retireDurableComposerDraft(
  scope: DurableComposerDraftScope,
  minimumRevision = 0,
  retireBeforeRevision?: number,
): Promise<DurableComposerDraftWriteResult> {
  try {
    const database = await openDraftDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const now = Date.now();
    const result = await retireDurableDraftInStore(
      store,
      scope,
      minimumRevision,
      retireBeforeRevision,
      now,
    );
    if (result.status === "conflict") {
      transaction.abort();
      return result;
    }
    await pruneOwnerRecords(store, ownerKey(scope), now);
    await transactionComplete(transaction);
    return result;
  } catch {
    return { status: "storage-failed" };
  }
}

async function retireDurableDraftInStore(
  store: IDBObjectStore,
  scope: DurableComposerDraftScope,
  minimumRevision: number,
  retireBeforeRevision: number | undefined,
  now: number,
): Promise<DurableComposerDraftWriteResult> {
  const key = recordKey(scope);
  const current = parseStoredDraft(await requestResult(store.get(key)));
  if (retireBeforeRevision !== undefined && (current?.revision ?? 0) >= retireBeforeRevision) {
    return { status: "conflict" };
  }
  const revision = nextFenceRevision(Math.max(minimumRevision, current?.revision ?? 0));
  const writeId = `retired:${revision}`;
  store.put({
    key,
    ownerKey: ownerKey(scope),
    gatewayOwner: scope.gatewayOwner,
    recoveryScope: scope.recoveryScope,
    scopeKey: scope.scopeKey,
    revision,
    text: "",
    attachments: [],
    updatedAt: now,
    writeId,
  } satisfies StoredDurableComposerDraft);
  return { status: "persisted", revision, writeId };
}

export async function retireDurableComposerDrafts(
  owner: Pick<DurableComposerDraftScope, "gatewayOwner" | "recoveryScope">,
  retirements: readonly {
    scopeKey: string;
    minimumRevision: number;
    retireBeforeRevision: number;
  }[],
): Promise<"completed" | "storage-failed"> {
  try {
    const database = await openDraftDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const now = Date.now();
    for (const retirement of retirements) {
      await retireDurableDraftInStore(
        store,
        { ...owner, scopeKey: retirement.scopeKey },
        retirement.minimumRevision,
        retirement.retireBeforeRevision,
        now,
      );
    }
    await pruneOwnerRecords(store, ownerKey({ ...owner, scopeKey: "" }), now);
    await transactionComplete(transaction);
    return "completed";
  } catch {
    return "storage-failed";
  }
}
