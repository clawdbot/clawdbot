import { t } from "../../i18n/index.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  outboxPayloadTab,
  readOutboxPayload,
  removeOutboxPayloads,
  writeOutboxPayload,
  type OutboxPayloadFailure,
} from "../../lib/chat/outbox-payload-store.runtime.ts";
import { storageTargetForGateway, type ChatComposerScope } from "../../lib/chat/outbox-store.ts";
import {
  captureDurableChatAttachments,
  readBlobAsDataUrl,
} from "./durable-composer-persistence.ts";

type Host = ChatComposerScope & {
  client?: { recoveryScope?: string; recoveryScopeReady?: boolean } | null;
  selectedChatSessionIncognito?: boolean;
};
type PayloadResult =
  | { status: "ready"; item: ChatQueueItem }
  | { status: "failed"; reason: OutboxPayloadFailure };
const knownOwners = new WeakMap<object, string>();

export function outboxPayloadError(reason: OutboxPayloadFailure): string {
  return t(
    `chat.sendErrors.outboxPayload${reason === "capacity" ? "Capacity" : reason === "missing" ? "Missing" : "Unavailable"}`,
  );
}

export function failOutboxPayload(item: ChatQueueItem, reason: OutboxPayloadFailure) {
  const attempted =
    (item.sendAttempts ?? 0) > 0 ||
    item.sendRequestStartedAtMs !== undefined ||
    item.sendState === "unconfirmed";
  return {
    ...item,
    attachmentStorageError: reason,
    sendState: attempted ? ("unconfirmed" as const) : ("failed" as const),
    sendError: outboxPayloadError(reason),
  };
}

export function observeOutboxRecoveryOwner(host: Host): string | undefined {
  const client = host.client;
  if (!client) {
    return undefined;
  }
  if (client.recoveryScopeReady && client.recoveryScope) {
    knownOwners.set(client, client.recoveryScope);
  }
  const remembered = knownOwners.get(client);
  return remembered === client.recoveryScope ? remembered : undefined;
}

export function captureOutboxPayloadOwner(host: Host): () => boolean {
  const client = host.client;
  const gateway = host.settings?.gatewayUrl;
  const recoveryScope = client?.recoveryScope;
  const incognito = host.selectedChatSessionIncognito;
  return () =>
    host.client === client &&
    host.settings?.gatewayUrl === gateway &&
    host.client?.recoveryScope === recoveryScope &&
    host.selectedChatSessionIncognito === incognito;
}

async function preparePayload(
  host: Host,
  item: ChatQueueItem,
  purpose: "send" | "handoff",
): Promise<PayloadResult> {
  if (!item.attachments?.length && !item.attachmentPayload && !item.attachmentStorageError) {
    return { status: "ready", item };
  }
  // Incognito keeps the existing tab-only inline outbox and its quota. It must
  // never acquire restart-persistent Blob ownership or hydrate a regular row.
  if (host.selectedChatSessionIncognito) {
    return item.attachmentPayload
      ? { status: "failed", reason: "unavailable" }
      : { status: "ready", item };
  }
  const recoveryScope = observeOutboxRecoveryOwner(host);
  if (!recoveryScope) {
    return { status: "failed", reason: "unavailable" };
  }
  const isCurrent = captureOutboxPayloadOwner(host);
  let tabId: string;
  try {
    tabId = await outboxPayloadTab();
  } catch {
    return { status: "failed", reason: "unavailable" };
  }
  if (!isCurrent()) {
    return { status: "failed", reason: "unavailable" };
  }
  const owner = {
    tabId,
    gatewayOwner: storageTargetForGateway(host.settings?.gatewayUrl).gatewayOwner,
    recoveryScope,
    queueId: item.id,
  };
  if (item.attachmentPayload) {
    const result = await readOutboxPayload(owner, item.attachmentPayload);
    if (result.status === "failed") {
      return result;
    }
    const metadata = item.attachments ?? [];
    if (
      result.value.length !== metadata.length ||
      result.value.some((attachment, index) => {
        const expected = metadata[index]!;
        return (
          attachment.mimeType !== expected.mimeType ||
          attachment.fileName !== expected.fileName ||
          attachment.sizeBytes !== expected.sizeBytes
        );
      })
    ) {
      return { status: "failed", reason: "missing" };
    }
    if (!isCurrent()) {
      return { status: "failed", reason: "unavailable" };
    }
    try {
      // Restore into isolated objects; no consumer sees a partially hydrated batch.
      const attachments = await Promise.all(
        result.value.map(async (attachment, index) => ({
          ...metadata[index]!,
          dataUrl: await readBlobAsDataUrl(attachment.blob),
        })),
      );
      if (!isCurrent()) {
        return { status: "failed", reason: "unavailable" };
      }
      if (purpose === "send" && item.attachmentPayload.tabId !== tabId) {
        const copy = await writeOutboxPayload(owner, result.value);
        if (copy.status === "failed") {
          return copy;
        }
        if (!isCurrent()) {
          await removeOutboxPayloads([copy.value]);
          return { status: "failed", reason: "unavailable" };
        }
        // A duplicate tab carries the same submission, never a fresh send. It
        // owns its copied bytes, but needs explicit review before retrying.
        return {
          status: "ready",
          item: {
            ...item,
            attachments,
            attachmentPayload: copy.value,
            sendState: "unconfirmed",
            sendError: t("chat.sendErrors.outboxPayloadCopied"),
            attachmentStorageError: undefined,
          },
        };
      }
      return { status: "ready", item: { ...item, attachments, attachmentStorageError: undefined } };
    } catch {
      return { status: "failed", reason: "missing" };
    }
  }
  // Delivery already happened: read existing bytes, never allocate a new bundle.
  if (purpose === "handoff" || item.attachmentStorageError === "missing") {
    return { status: "failed", reason: "missing" };
  }
  const attachments = captureDurableChatAttachments(item.attachments ?? []);
  if (!attachments) {
    return { status: "failed", reason: "missing" };
  }
  const result = await writeOutboxPayload(owner, attachments);
  if (result.status === "failed") {
    return result;
  }
  if (!isCurrent()) {
    await removeOutboxPayloads([result.value]);
    return { status: "failed", reason: "unavailable" };
  }
  return {
    status: "ready",
    item: { ...item, attachmentPayload: result.value, attachmentStorageError: undefined },
  };
}

// Preview and drain share reads/copies so a cloned tab cannot create competing refs.
// Check admission per caller; only equivalent bundle identities and metadata may join.
const pendingPayloads = new Map<string, Promise<PayloadResult>>();
export async function prepareOutboxPayload(
  host: Host,
  item: ChatQueueItem,
  purpose: "send" | "handoff" = "send",
): Promise<PayloadResult> {
  const reference = item.attachmentPayload;
  if (!reference || host.selectedChatSessionIncognito || !observeOutboxRecoveryOwner(host)) {
    return preparePayload(host, item, purpose);
  }
  const key = JSON.stringify([
    item.id,
    reference.key,
    reference.tabId,
    reference.recoveryScope,
    host.settings?.gatewayUrl,
    host.client?.recoveryScope,
    purpose,
    item.attachments?.map(({ mimeType, fileName, sizeBytes }) => [mimeType, fileName, sizeBytes]),
  ]);
  const isCurrent = captureOutboxPayloadOwner(host);
  let pending = pendingPayloads.get(key);
  if (!pending) {
    pending = preparePayload(host, item, purpose).finally(() => pendingPayloads.delete(key));
    pendingPayloads.set(key, pending);
  }
  const result = await pending;
  if (!isCurrent()) {
    return { status: "failed", reason: "unavailable" };
  }
  if (result.status === "failed") {
    return result;
  }
  const copied = result.item.attachmentPayload?.key !== reference.key;
  return {
    status: "ready",
    item: {
      ...item,
      attachments: result.item.attachments,
      attachmentPayload: result.item.attachmentPayload,
      attachmentStorageError: undefined,
      ...(copied ? { sendState: result.item.sendState, sendError: result.item.sendError } : {}),
    },
  };
}

export function retireOutboxPayload(item: ChatQueueItem): void {
  if (item.attachmentPayload) {
    void removeOutboxPayloads([item.attachmentPayload]);
  }
}
