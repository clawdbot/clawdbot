import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import type {
  DurableComposerDraftAttachment,
  DurableComposerDraftScope,
} from "../../lib/chat/composer-draft-store.runtime.ts";
import { nextDraftRevision } from "../../lib/chat/outbox-store-draft-state.ts";
import { storageTargetForGateway } from "../../lib/chat/outbox-store.ts";
import { releaseChatAttachmentPayloads } from "../chat/attachment-payload-store.ts";
import {
  captureDurableChatAttachments,
  chatAttachmentDraftSignature,
  durableComposerDraftMatches,
  durableComposerScopeIdentity,
  hydrateDurableComposerAttachments,
  reportDurableComposerStorageError,
  writeDurableComposerSnapshot,
} from "../chat/durable-composer-persistence.ts";

type NewSessionDraftState = {
  message: string;
  attachments: ChatAttachment[];
  incognito: boolean;
};

type DraftSnapshot = {
  scope: DurableComposerDraftScope;
  expectedRevision: number;
  expectedWriteId?: string;
  expectedWriteIds: string[];
  revision: number;
  text: string;
  attachments: DurableComposerDraftAttachment[] | null;
  writeId: string;
};

const durableComposerStore = import("../../lib/chat/composer-draft-store.runtime.ts");
const loadDurableComposerStore = () => durableComposerStore;
const NEW_SESSION_DRAFT_PERSIST_DELAY_MS = 200;

export class NewSessionDraftPersistence {
  private gatewayOwner = "";
  private recoveryScope = "";
  private routeKey = "";
  private revision = 0;
  private mutationGeneration = 0;
  private restoreGeneration = 0;
  private restoredIdentity = "";
  private pending: DraftSnapshot | null = null;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private incognitoRetirement: Promise<void> = Promise.resolve();
  private readonly committedByScope = new Map<string, number>();
  private readonly committedWriteIdByScope = new Map<string, string>();
  private readonly localWriteIdsByScope = new Map<string, Set<string>>();

  constructor(
    private readonly read: () => NewSessionDraftState,
    private readonly apply: (
      message: string,
      attachments: ChatAttachment[],
      resetVisibility?: boolean,
    ) => void,
    private readonly onStorageError: () => void,
  ) {}

  setOwner(gatewayUrl: string, recoveryScope: string, preserveCurrent = false) {
    const gatewayOwner = storageTargetForGateway(gatewayUrl).gatewayOwner;
    const nextOwner = JSON.stringify([gatewayOwner, recoveryScope]);
    const currentOwner = this.gatewayOwner
      ? JSON.stringify([this.gatewayOwner, this.recoveryScope])
      : "";
    if (currentOwner === nextOwner) {
      return;
    }
    const routeKey = this.routeKey;
    this.persistNow();
    this.restoreGeneration += 1;
    this.restoredIdentity = "";
    this.routeKey = "";
    this.gatewayOwner = gatewayOwner;
    this.recoveryScope = recoveryScope;
    if (currentOwner && !preserveCurrent) {
      this.apply("", [], true);
    }
    // The route may win the startup race; activate it as soon as its owner exists.
    if (!preserveCurrent) {
      this.activateRoute(routeKey);
    }
  }

  setIncognito(incognito: boolean): Promise<void> {
    if (incognito) {
      this.incognitoRetirement = this.retireActive();
      return this.incognitoRetirement;
    }
    return this.incognitoRetirement;
  }

  transitionIncognito(wasIncognito: boolean, incognito: boolean, publish: () => void) {
    const transition = this.setIncognito(incognito);
    if (wasIncognito && !incognito) {
      void transition.finally(publish);
      return;
    }
    publish();
  }

  selectRoute(routeKey: string) {
    if (!routeKey) {
      return;
    }
    if (this.routeKey !== routeKey) {
      this.persistNow();
      this.routeKey = routeKey;
      this.revision = 0;
    }
  }

  activateRoute(routeKey: string) {
    this.selectRoute(routeKey);
    const scope = this.scope();
    if (!scope) {
      return;
    }
    const identity = durableComposerScopeIdentity(scope);
    if (identity === this.restoredIdentity) {
      return;
    }
    this.restoredIdentity = identity;
    if (this.read().incognito) {
      void this.retireActive();
      return;
    }
    const generation = ++this.restoreGeneration;
    const mutationGeneration = this.mutationGeneration;
    const baseline = this.read();
    const signature = chatAttachmentDraftSignature(baseline.message, baseline.attachments);
    void this.restoreScope(scope, generation, mutationGeneration, signature);
  }

  noteUserMutation() {
    this.mutationGeneration += 1;
    this.revision = nextDraftRevision(this.revision);
    if (this.read().incognito) {
      return;
    }
    this.discardPending();
    const snapshot = this.snapshot();
    if (!snapshot) {
      return;
    }
    this.pending = snapshot;
    this.timer = globalThis.setTimeout(() => this.persistNow(), NEW_SESSION_DRAFT_PERSIST_DELAY_MS);
  }

  retireActive(): Promise<void> {
    this.mutationGeneration += 1;
    this.discardPending();
    const requestedRevision = nextDraftRevision(this.revision);
    this.revision = requestedRevision;
    const scope = this.scope();
    if (!scope) {
      return Promise.resolve();
    }
    return this.enqueueWrite(async () => {
      const { retireDurableComposerDraft } = await loadDurableComposerStore();
      const identity = durableComposerScopeIdentity(scope);
      const minimumRevision = Math.max(requestedRevision, this.committedByScope.get(identity) ?? 0);
      const result = await retireDurableComposerDraft(scope, minimumRevision);
      if (result.status === "storage-failed") {
        reportDurableComposerStorageError(scope, this.onStorageError);
      } else if (result.status === "persisted") {
        this.localWriteIdsByScope.delete(identity);
        this.adoptCommittedRevision(scope, result.revision ?? minimumRevision, result.writeId);
      }
    });
  }

  clearSubmittedDraft(): Promise<void> {
    this.persistNow();
    this.mutationGeneration += 1;
    const scope = this.scope();
    if (!scope) {
      return Promise.resolve();
    }
    const submitted = this.read();
    const submittedAttachments = captureDurableChatAttachments(submitted.attachments);
    return this.enqueueWrite(async () => {
      const { readDurableComposerDraft } = await loadDurableComposerStore();
      const identity = durableComposerScopeIdentity(scope);
      let expectedRevision = this.committedByScope.get(identity) ?? 0;
      let expectedWriteId = this.committedWriteIdByScope.get(identity);
      // A closing source page can finish an identical write between read and CAS.
      // Re-read boundedly; differing newer content always wins immediately.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await readDurableComposerDraft(scope);
        if (current.status === "storage-failed") {
          reportDurableComposerStorageError(scope, this.onStorageError);
          return;
        }
        const currentRevision =
          (current.status === "found" ? current.draft.revision : current.revision) ?? 0;
        const currentWriteId = current.status === "found" ? current.draft.writeId : current.writeId;
        if (currentRevision !== expectedRevision || currentWriteId !== expectedWriteId) {
          if (
            current.status !== "found" ||
            !(await durableComposerDraftMatches(
              current.draft,
              submitted.message,
              submittedAttachments,
            ))
          ) {
            return;
          }
          expectedRevision = currentRevision;
          expectedWriteId = currentWriteId;
          this.adoptCommittedRevision(scope, currentRevision, currentWriteId);
        }
        const revision = nextDraftRevision(Math.max(this.revision, expectedRevision));
        const writeId = `clear:${revision}`;
        const { result } = await writeDurableComposerSnapshot({
          scope,
          expectedRevision,
          ...(expectedWriteId ? { expectedWriteId } : {}),
          revision,
          text: "",
          storedAttachments: [],
          writeId,
        });
        if (result.status === "persisted") {
          this.adoptCommittedRevision(
            scope,
            result.revision ?? revision,
            result.writeId ?? writeId,
          );
          return;
        }
        if (result.status === "storage-failed") {
          reportDurableComposerStorageError(scope, this.onStorageError);
          return;
        }
      }
    });
  }

  persistNow() {
    this.clearTimer();
    const snapshot = this.pending;
    if (!snapshot) {
      return;
    }
    if (this.read().incognito) {
      this.discardPending();
      return;
    }
    this.pending = null;
    void this.enqueueWrite(async () => {
      const identity = durableComposerScopeIdentity(snapshot.scope);
      try {
        const { result, payloadUnavailable } = await writeDurableComposerSnapshot({
          scope: snapshot.scope,
          expectedRevision: snapshot.expectedRevision,
          ...(snapshot.expectedWriteId ? { expectedWriteId: snapshot.expectedWriteId } : {}),
          expectedWriteIds: snapshot.expectedWriteIds,
          revision: snapshot.revision,
          text: snapshot.text,
          storedAttachments: snapshot.attachments,
          writeId: snapshot.writeId,
        });
        if (payloadUnavailable) {
          reportDurableComposerStorageError(snapshot.scope, this.onStorageError);
        }
        if (result.status === "persisted" || result.status === "payload-too-large") {
          const committedRevision = result.revision ?? snapshot.revision;
          this.adoptCommittedRevision(
            snapshot.scope,
            committedRevision,
            result.writeId ?? snapshot.writeId,
          );
          if (result.status === "payload-too-large") {
            reportDurableComposerStorageError(snapshot.scope, this.onStorageError);
          }
          return;
        }
        if (result.status === "storage-failed") {
          reportDurableComposerStorageError(snapshot.scope, this.onStorageError);
          return;
        }
        if (this.routeKey !== snapshot.scope.scopeKey || this.revision !== snapshot.revision) {
          return;
        }
        this.restoredIdentity = "";
        this.activateRoute(this.routeKey);
      } finally {
        const localWriteIds = this.localWriteIdsByScope.get(identity);
        localWriteIds?.delete(snapshot.writeId);
        if (localWriteIds?.size === 0) {
          this.localWriteIdsByScope.delete(identity);
        }
      }
    });
  }

  disconnect() {
    this.persistNow();
    this.restoreGeneration += 1;
  }

  private scope(): DurableComposerDraftScope | null {
    if (!this.gatewayOwner || !this.recoveryScope || !this.routeKey) {
      return null;
    }
    return {
      gatewayOwner: this.gatewayOwner,
      recoveryScope: this.recoveryScope,
      scopeKey: this.routeKey,
    };
  }

  private snapshot(): DraftSnapshot | null {
    const scope = this.scope();
    if (!scope || this.revision <= 0) {
      return null;
    }
    const state = this.read();
    const identity = durableComposerScopeIdentity(scope);
    const expectedWriteIds = [...(this.localWriteIdsByScope.get(identity) ?? [])];
    const writeId = `${this.revision}:${Math.random().toString(36).slice(2)}`;
    this.rememberLocalWriteId(identity, writeId);
    return {
      scope,
      expectedRevision: this.committedByScope.get(identity) ?? 0,
      ...(this.committedWriteIdByScope.get(identity)
        ? { expectedWriteId: this.committedWriteIdByScope.get(identity) }
        : {}),
      expectedWriteIds,
      revision: this.revision,
      text: state.message,
      attachments: captureDurableChatAttachments(state.attachments),
      writeId,
    };
  }

  private async restoreScope(
    scope: DurableComposerDraftScope,
    generation: number,
    mutationGeneration: number,
    signature: string,
  ) {
    const { readDurableComposerDraft } = await loadDurableComposerStore();
    const result = await readDurableComposerDraft(scope);
    if (result.status === "storage-failed") {
      reportDurableComposerStorageError(scope, this.onStorageError);
      return;
    }
    const storedRevision = result.status === "found" ? result.draft.revision : result.revision;
    const storedWriteId = result.status === "found" ? result.draft.writeId : result.writeId;
    const identity = durableComposerScopeIdentity(scope);
    if (storedRevision !== undefined) {
      this.committedByScope.set(identity, storedRevision);
      if (storedWriteId) {
        this.committedWriteIdByScope.set(identity, storedWriteId);
      }
    } else {
      this.committedByScope.delete(identity);
      this.committedWriteIdByScope.delete(identity);
    }
    const current = this.read();
    const currentScope = this.scope();
    if (
      generation !== this.restoreGeneration ||
      mutationGeneration !== this.mutationGeneration ||
      !currentScope ||
      durableComposerScopeIdentity(scope) !== durableComposerScopeIdentity(currentScope) ||
      signature !== chatAttachmentDraftSignature(current.message, current.attachments)
    ) {
      return;
    }
    if (
      storedRevision === undefined ||
      storedRevision < this.revision ||
      (mutationGeneration > 0 && storedRevision <= this.revision)
    ) {
      if (storedRevision !== undefined && storedRevision >= this.revision) {
        this.revision = nextDraftRevision(storedRevision);
      }
      this.pending = this.snapshot();
      this.persistNow();
      return;
    }
    let attachments: ChatAttachment[] = [];
    if (result.status === "found") {
      try {
        attachments = await hydrateDurableComposerAttachments(result.draft.attachments);
      } catch {
        reportDurableComposerStorageError(scope, this.onStorageError);
        return;
      }
    }
    const hydratedCurrent = this.read();
    const hydratedScope = this.scope();
    if (
      generation !== this.restoreGeneration ||
      mutationGeneration !== this.mutationGeneration ||
      !hydratedScope ||
      durableComposerScopeIdentity(scope) !== durableComposerScopeIdentity(hydratedScope) ||
      signature !==
        chatAttachmentDraftSignature(hydratedCurrent.message, hydratedCurrent.attachments)
    ) {
      releaseChatAttachmentPayloads(attachments);
      return;
    }
    this.revision = storedRevision;
    this.apply(result.status === "found" ? result.draft.text : "", attachments);
  }

  private enqueueWrite(run: () => Promise<void>): Promise<void> {
    // Flush timers before teardown, then start each IndexedDB transaction independently.
    // Store ordering and revision CAS serialize writes without promise-chain delays.
    return run();
  }

  private clearTimer() {
    if (this.timer === null) {
      return;
    }
    globalThis.clearTimeout(this.timer);
    this.timer = null;
  }

  private discardPending() {
    this.clearTimer();
    const snapshot = this.pending;
    this.pending = null;
    if (!snapshot) {
      return;
    }
    const identity = durableComposerScopeIdentity(snapshot.scope);
    const localWriteIds = this.localWriteIdsByScope.get(identity);
    localWriteIds?.delete(snapshot.writeId);
    if (localWriteIds?.size === 0) {
      this.localWriteIdsByScope.delete(identity);
    }
  }

  private rememberLocalWriteId(identity: string, writeId: string) {
    const writeIds = this.localWriteIdsByScope.get(identity) ?? new Set<string>();
    writeIds.add(writeId);
    this.localWriteIdsByScope.set(identity, writeIds);
  }

  private adoptCommittedRevision(
    scope: DurableComposerDraftScope,
    revision: number,
    writeId?: string,
  ) {
    const identity = durableComposerScopeIdentity(scope);
    this.committedByScope.set(identity, revision);
    if (writeId) {
      this.committedWriteIdByScope.set(identity, writeId);
    }
    const currentScope = this.scope();
    if (
      currentScope &&
      durableComposerScopeIdentity(currentScope) === identity &&
      revision > this.revision
    ) {
      this.revision = revision;
    }
  }
}
