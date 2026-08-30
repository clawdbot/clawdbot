import type { ChatAttachment, ChatGoalDraftMode } from "../../lib/chat/chat-types.ts";
import type {
  DurableComposerDraftAttachment,
  DurableComposerDraftScope,
} from "../../lib/chat/composer-draft-store.runtime.ts";
import {
  generateAttachmentId,
  getChatAttachmentBlob,
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";

export type DurableChatComposerSnapshot = {
  scope: DurableComposerDraftScope;
  expectedRevision: number;
  expectedWriteId?: string;
  expectedWriteIds?: readonly string[];
  revision: number;
  text: string;
  goalMode?: ChatGoalDraftMode;
  attachments: ChatAttachment[];
  storedAttachments: DurableComposerDraftAttachment[] | null;
  writeId: string;
};

type RestoreBaseline = {
  scope: DurableComposerDraftScope;
  committedRevision: number;
  latestRevision: number;
  signature: string;
};

type RestoredDraft = {
  revision: number;
  text: string;
  goalMode?: ChatGoalDraftMode;
  attachments: ChatAttachment[];
};

const reportedStorageOwners = new Set<string>();

const durableComposerStore = import("../../lib/chat/composer-draft-store.runtime.ts");
const loadDurableComposerStore = () => durableComposerStore;

function durableComposerOwnerKey(scope: DurableComposerDraftScope): string {
  return JSON.stringify([scope.gatewayOwner, scope.recoveryScope]);
}

export function durableComposerScopeIdentity(scope: DurableComposerDraftScope): string {
  return JSON.stringify([scope.gatewayOwner, scope.recoveryScope, scope.scopeKey]);
}

export function reportDurableComposerStorageError(
  scope: DurableComposerDraftScope,
  onStorageError: () => void,
) {
  const owner = durableComposerOwnerKey(scope);
  if (reportedStorageOwners.has(owner)) {
    return;
  }
  reportedStorageOwners.add(owner);
  onStorageError();
}

export function chatAttachmentDraftSignature(
  text: string,
  attachments: readonly ChatAttachment[],
  goalMode?: ChatGoalDraftMode | null,
): string {
  return JSON.stringify([
    text,
    goalMode ?? null,
    attachments.map((attachment) => [
      attachment.id,
      attachment.mimeType,
      attachment.fileName ?? "",
      attachment.sizeBytes ?? -1,
      attachment.browserAnnotation ?? null,
    ]),
  ]);
}

function blobFromDataUrl(dataUrl: string): Blob | null {
  const match = /^data:([^,]*),(.*)$/s.exec(dataUrl);
  if (!match) {
    return null;
  }
  const metadata = match[1] ?? "";
  const payload = match[2] ?? "";
  try {
    if (metadata.toLowerCase().includes(";base64")) {
      const binary = atob(payload.replace(/\s+/gu, ""));
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new Blob([bytes], { type: metadata.split(";", 1)[0] });
    }
    return new Blob([decodeURIComponent(payload.replace(/\+/gu, "%20"))], {
      type: metadata.split(";", 1)[0],
    });
  } catch {
    return null;
  }
}

export function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Blob read failed")), {
      once: true,
    });
    reader.addEventListener(
      "load",
      () =>
        typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error("Blob read returned no data")),
      { once: true },
    );
    reader.readAsDataURL(blob);
  });
}

async function restoreChatAttachmentPayload(params: {
  attachment: ChatAttachment;
  blob: Blob;
}): Promise<ChatAttachment> {
  const blob =
    params.blob.type === params.attachment.mimeType
      ? params.blob
      : params.blob.slice(0, params.blob.size, params.attachment.mimeType);
  const dataUrl = await readBlobAsDataUrl(blob);
  const file = new File([blob], params.attachment.fileName ?? "attachment", {
    type: params.attachment.mimeType,
  });
  return registerChatAttachmentPayload({ attachment: params.attachment, dataUrl, file });
}

export function captureDurableChatAttachments(
  attachments: readonly ChatAttachment[],
): DurableComposerDraftAttachment[] | null {
  const stored: DurableComposerDraftAttachment[] = [];
  for (const attachment of attachments) {
    const dataUrl = getChatAttachmentDataUrl(attachment);
    const blob = getChatAttachmentBlob(attachment) ?? (dataUrl ? blobFromDataUrl(dataUrl) : null);
    if (!blob) {
      return null;
    }
    stored.push({
      blob,
      mimeType: attachment.mimeType,
      ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
      ...(typeof attachment.sizeBytes === "number" ? { sizeBytes: attachment.sizeBytes } : {}),
      ...(attachment.browserAnnotation
        ? { browserAnnotation: { ...attachment.browserAnnotation } }
        : {}),
    });
  }
  return stored;
}

export async function hydrateDurableComposerAttachments(
  stored: readonly DurableComposerDraftAttachment[],
): Promise<ChatAttachment[]> {
  const hydrated: ChatAttachment[] = [];
  try {
    for (const attachment of stored) {
      hydrated.push(
        await restoreChatAttachmentPayload({
          attachment: {
            id: generateAttachmentId(),
            mimeType: attachment.mimeType,
            ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
            ...(typeof attachment.sizeBytes === "number"
              ? { sizeBytes: attachment.sizeBytes }
              : {}),
            ...(attachment.browserAnnotation
              ? { browserAnnotation: { ...attachment.browserAnnotation } }
              : {}),
          },
          blob: attachment.blob,
        }),
      );
    }
    return hydrated;
  } catch (error) {
    releaseChatAttachmentPayloads(hydrated);
    throw error;
  }
}

export async function writeDurableComposerSnapshot(snapshot: {
  scope: DurableComposerDraftScope;
  expectedRevision: number;
  expectedWriteId?: string;
  expectedWriteIds?: readonly string[];
  revision: number;
  text: string;
  goalMode?: ChatGoalDraftMode;
  storedAttachments: DurableComposerDraftAttachment[] | null;
  writeId: string;
}) {
  const { writeDurableComposerDraft } = await loadDurableComposerStore();
  const payloadUnavailable = snapshot.storedAttachments === null;
  const result = await writeDurableComposerDraft(
    snapshot.scope,
    {
      revision: snapshot.revision,
      text: payloadUnavailable ? "" : snapshot.text,
      ...(snapshot.goalMode ? { goalMode: snapshot.goalMode } : {}),
      attachments: snapshot.storedAttachments ?? [],
    },
    {
      expectedRevision: snapshot.expectedRevision,
      ...(snapshot.expectedWriteId ? { expectedWriteId: snapshot.expectedWriteId } : {}),
      ...(snapshot.expectedWriteIds?.length ? { expectedWriteIds: snapshot.expectedWriteIds } : {}),
      writeId: snapshot.writeId,
    },
  );
  return { result, payloadUnavailable };
}

async function blobsEqual(left: Blob, right: Blob): Promise<boolean> {
  if (left.size !== right.size || left.type !== right.type) {
    return false;
  }
  const [leftBytes, rightBytes] = await Promise.all([left.arrayBuffer(), right.arrayBuffer()]);
  const leftView = new Uint8Array(leftBytes);
  const rightView = new Uint8Array(rightBytes);
  return leftView.every((byte, index) => byte === rightView[index]);
}

export async function durableComposerDraftMatches(
  draft: { text: string; attachments: DurableComposerDraftAttachment[] },
  text: string,
  attachments: DurableComposerDraftAttachment[] | null,
): Promise<boolean> {
  if (
    attachments === null ||
    draft.text !== text ||
    draft.attachments.length !== attachments.length
  ) {
    return false;
  }
  for (const [index, stored] of draft.attachments.entries()) {
    const current = attachments[index];
    if (
      !current ||
      stored.mimeType !== current.mimeType ||
      stored.fileName !== current.fileName ||
      stored.sizeBytes !== current.sizeBytes ||
      JSON.stringify(stored.browserAnnotation) !== JSON.stringify(current.browserAnnotation) ||
      !(await blobsEqual(stored.blob, current.blob))
    ) {
      return false;
    }
  }
  return true;
}

export class DurableChatComposerPersistence {
  private restoreGeneration = 0;
  private restoredScopeKey = "";

  constructor(
    private readonly onStorageError: () => void,
    private readonly onConflict: () => void,
  ) {}

  resetRestoreScope() {
    this.restoreGeneration += 1;
    this.restoredScopeKey = "";
  }

  persist(snapshot: DurableChatComposerSnapshot) {
    const run = async () => {
      const { result, payloadUnavailable } = await writeDurableComposerSnapshot(snapshot);
      if (payloadUnavailable) {
        reportDurableComposerStorageError(snapshot.scope, this.onStorageError);
      }
      if (result.status === "storage-failed" || result.status === "payload-too-large") {
        reportDurableComposerStorageError(snapshot.scope, this.onStorageError);
      } else if (result.status === "conflict") {
        this.resetRestoreScope();
        this.onConflict();
      }
    };
    // Start every CAS write before page teardown. IndexedDB readwrite ordering and
    // draft revisions serialize snapshots without delaying attachment writes behind text.
    void run();
  }

  retire(scope: DurableComposerDraftScope, minimumRevision: number) {
    this.resetRestoreScope();
    const run = async () => {
      const { retireDurableComposerDraft } = await loadDurableComposerStore();
      const result = await retireDurableComposerDraft(scope, minimumRevision);
      if (result.status === "storage-failed") {
        reportDurableComposerStorageError(scope, this.onStorageError);
      }
    };
    void run();
  }

  restore(
    baseline: RestoreBaseline,
    current: () => { scope: DurableComposerDraftScope | null; signature: string; revision: number },
    apply: (draft: RestoredDraft) => void,
    onCurrentWins: (storedRevision: number) => void,
  ) {
    const scopeIdentity = durableComposerScopeIdentity(baseline.scope);
    if (this.restoredScopeKey === scopeIdentity) {
      return;
    }
    this.restoredScopeKey = scopeIdentity;
    const generation = ++this.restoreGeneration;
    void this.restoreScope(baseline, generation, current, apply, onCurrentWins);
  }

  private async restoreScope(
    baseline: RestoreBaseline,
    generation: number,
    current: () => { scope: DurableComposerDraftScope | null; signature: string; revision: number },
    apply: (draft: RestoredDraft) => void,
    onCurrentWins: (storedRevision: number) => void,
  ) {
    const { readDurableComposerDraft } = await loadDurableComposerStore();
    const result = await readDurableComposerDraft(baseline.scope);
    if (result.status === "storage-failed") {
      reportDurableComposerStorageError(baseline.scope, this.onStorageError);
      return;
    }
    const revision = result.status === "found" ? result.draft.revision : result.revision;
    if (revision === undefined || revision < baseline.latestRevision) {
      if (this.isBaselineCurrent(baseline, generation, current())) {
        onCurrentWins(revision ?? 0);
      }
      return;
    }
    let attachments: ChatAttachment[] = [];
    if (result.status === "found") {
      try {
        attachments = await hydrateDurableComposerAttachments(result.draft.attachments);
      } catch {
        releaseChatAttachmentPayloads(attachments);
        reportDurableComposerStorageError(baseline.scope, this.onStorageError);
        return;
      }
    }
    if (!this.isBaselineCurrent(baseline, generation, current())) {
      releaseChatAttachmentPayloads(attachments);
      return;
    }
    apply({
      revision,
      text: result.status === "found" ? result.draft.text : "",
      ...(result.status === "found" && result.draft.goalMode
        ? { goalMode: result.draft.goalMode }
        : {}),
      attachments,
    });
  }

  private isBaselineCurrent(
    baseline: RestoreBaseline,
    generation: number,
    active: { scope: DurableComposerDraftScope | null; signature: string; revision: number },
  ): boolean {
    return (
      generation === this.restoreGeneration &&
      active.scope?.gatewayOwner === baseline.scope.gatewayOwner &&
      active.scope.recoveryScope === baseline.scope.recoveryScope &&
      active.scope.scopeKey === baseline.scope.scopeKey &&
      active.signature === baseline.signature &&
      active.revision === baseline.latestRevision
    );
  }
}
