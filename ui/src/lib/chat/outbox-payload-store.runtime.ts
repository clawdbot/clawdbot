import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getSafeSessionStorage } from "../../local-storage.ts";
import type { ChatQueueItem } from "./chat-types.ts";
import type { DurableComposerDraftAttachment } from "./composer-draft-store.runtime.ts";
import {
  openControlUiDatabase,
  requestResult,
  transactionComplete,
} from "./control-ui-database.runtime.ts";

const STORE_NAME = "outboxPayloads";
const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
// Never evict a queued input to admit another one. The origin-wide bound also
// bounds orphaned payloads after a tab closes without retiring its metadata.
const MAX_RETAINED_BYTES = 250 * 1024 * 1024;
const MAX_RETAINED_PAYLOADS = 1000;
export type OutboxPayloadFailure = "capacity" | "unavailable" | "missing";
type PayloadReference = NonNullable<ChatQueueItem["attachmentPayload"]>;
type PayloadOwner = {
  tabId: string;
  gatewayOwner: string;
  recoveryScope: string;
  queueId: string;
};
type PayloadResult<T> =
  | { status: "ready"; value: T }
  | { status: "failed"; reason: OutboxPayloadFailure };
type StoredPayload = {
  key: string;
  owner: PayloadOwner;
  bytes: number;
  attachments: DurableComposerDraftAttachment[];
};

function storageFailure(error: unknown): { status: "failed"; reason: OutboxPayloadFailure } {
  return {
    status: "failed",
    reason:
      error instanceof DOMException && error.name === "QuotaExceededError"
        ? "capacity"
        : "unavailable",
  };
}

export async function writeOutboxPayload(
  owner: PayloadOwner,
  attachments: DurableComposerDraftAttachment[],
): Promise<PayloadResult<PayloadReference>> {
  const bytes = attachments.reduce((total, attachment) => total + attachment.blob.size, 0);
  if (bytes > MAX_PAYLOAD_BYTES) {
    return { status: "failed", reason: "capacity" };
  }
  try {
    const database = await openControlUiDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite", { durability: "strict" });
    const completed = transactionComplete(transaction);
    const store = transaction.objectStore(STORE_NAME);
    // IDB serializes this capacity check with every writer, including other tabs.
    const records: unknown[] = await requestResult(store.getAll()).catch(async (error: unknown) => {
      await completed;
      throw error;
    });
    const retainedBytes = records.reduce<number>(
      (total, value) =>
        total +
        (isRecord(value) &&
        typeof value.bytes === "number" &&
        Number.isSafeInteger(value.bytes) &&
        value.bytes >= 0
          ? value.bytes
          : MAX_RETAINED_BYTES),
      0,
    );
    if (records.length >= MAX_RETAINED_PAYLOADS || retainedBytes + bytes > MAX_RETAINED_BYTES) {
      await completed;
      return { status: "failed", reason: "capacity" };
    }
    const key = JSON.stringify([
      owner.gatewayOwner,
      owner.recoveryScope,
      owner.queueId,
      crypto.randomUUID(),
    ]);
    store.add({ key, owner, bytes, attachments } satisfies StoredPayload);
    await completed;
    return {
      status: "ready",
      value: {
        key,
        recoveryScope: owner.recoveryScope,
        tabId: owner.tabId,
      },
    };
  } catch (error) {
    return storageFailure(error);
  }
}

export async function readOutboxPayload(
  owner: PayloadOwner,
  reference: PayloadReference,
): Promise<PayloadResult<DurableComposerDraftAttachment[]>> {
  if (reference.recoveryScope !== owner.recoveryScope) {
    return { status: "failed", reason: "missing" };
  }
  try {
    const database = await openControlUiDatabase();
    const transaction = database.transaction(STORE_NAME);
    const completed = transactionComplete(transaction);
    const [value]: [unknown, void] = await Promise.all([
      requestResult(transaction.objectStore(STORE_NAME).get(reference.key)),
      completed,
    ]);
    if (
      !isRecord(value) ||
      !isRecord(value.owner) ||
      value.key !== reference.key ||
      value.owner.gatewayOwner !== owner.gatewayOwner ||
      value.owner.recoveryScope !== owner.recoveryScope ||
      value.owner.queueId !== owner.queueId ||
      value.owner.tabId !== reference.tabId ||
      !Array.isArray(value.attachments) ||
      !value.attachments.length
    ) {
      return { status: "failed", reason: "missing" };
    }
    const attachments: DurableComposerDraftAttachment[] = [];
    for (const entry of value.attachments) {
      if (
        !isRecord(entry) ||
        !(entry.blob instanceof Blob) ||
        typeof entry.mimeType !== "string" ||
        (entry.fileName !== undefined && typeof entry.fileName !== "string") ||
        (entry.sizeBytes !== undefined && entry.sizeBytes !== entry.blob.size)
      ) {
        return { status: "failed", reason: "missing" };
      }
      attachments.push({
        blob: entry.blob,
        mimeType: entry.mimeType,
        ...(typeof entry.fileName === "string" ? { fileName: entry.fileName } : {}),
        ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}),
      });
    }
    if (
      value.bytes !== attachments.reduce((total, attachment) => total + attachment.blob.size, 0)
    ) {
      return { status: "failed", reason: "missing" };
    }
    return { status: "ready", value: attachments };
  } catch (error) {
    return storageFailure(error);
  }
}

export async function removeOutboxPayloads(references: readonly PayloadReference[]): Promise<void> {
  try {
    // Duplicated storage carries the source marker until adoption finishes. Only
    // the document's held lock can authorize deletion, including cleanup callers.
    const tabId = await outboxPayloadTab();
    const owned = references.filter((reference) => reference.tabId === tabId);
    if (!owned.length) {
      return;
    }
    const database = await openControlUiDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    for (const reference of owned) {
      store.delete(reference.key);
    }
    await transactionComplete(transaction);
  } catch {
    // Metadata retirement is authoritative. A failed cleanup consumes the bounded
    // origin budget; it must not resurrect the row or turn an ACK into a retry.
  }
}

const TAB_STORAGE_KEY = "openclaw.control.outboxTab.v1";
let tabPromise: Promise<string> | null = null;
export function outboxPayloadTab(): Promise<string> {
  return (tabPromise ??= (async () => {
    const storage = getSafeSessionStorage();
    if (!storage || !globalThis.navigator?.locks) {
      throw new Error("Outbox ownership unavailable");
    }
    const claim = (id: string) =>
      new Promise<boolean>((resolve, reject) => {
        void navigator.locks
          .request(`openclaw-outbox:${id}`, { ifAvailable: true }, (lock) => {
            resolve(Boolean(lock));
            // A document holds its tab identity until the browser destroys it. A
            // duplicated sessionStorage must claim a new identity before using bytes.
            return lock ? new Promise<void>(() => {}) : undefined;
          })
          .catch(reject);
      });
    const previous = storage.getItem(TAB_STORAGE_KEY);
    const id = previous && (await claim(previous)) ? previous : crypto.randomUUID();
    if (id !== previous && !(await claim(id))) {
      throw new Error("Outbox ownership unavailable");
    }
    storage.setItem(TAB_STORAGE_KEY, id);
    return id;
  })().catch((error: unknown) => {
    tabPromise = null;
    throw error;
  }));
}
