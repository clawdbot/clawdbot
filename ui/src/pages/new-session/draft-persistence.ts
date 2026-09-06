import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import type { DurableComposerDraftScope } from "../../lib/chat/composer-draft-store.runtime.ts";
import { nextDraftRevision } from "../../lib/chat/outbox-store-draft-state.ts";
import { storageTargetForGateway } from "../../lib/chat/outbox-store.ts";
import {
  captureDurableChatAttachments,
  chatAttachmentDraftSignature,
  durableComposerDraftMatches,
  durableComposerScopeIdentity,
  hydrateDurableComposerAttachments,
  reportDurableComposerStorageError,
  writeDurableComposerSnapshot,
  type DurableChatComposerSnapshot,
} from "../chat/durable-composer-persistence.ts";

type NewSessionDraftState = {
  message: string;
  mentions?: readonly HumanMention[];
  attachments: ChatAttachment[];
  incognito: boolean;
};

type DraftLineage = { revision: number; writeId?: string; localWriteIds: Set<string> };

const durableComposerStore = import("../../lib/chat/composer-draft-store.runtime.ts");
const NEW_SESSION_DRAFT_PERSIST_DELAY_MS = 200;

export class NewSessionDraftPersistence {
  private gatewayOwner = "";
  private recoveryScope = "";
  private routeKey = "";
  private revision = 0;
  private mutationGeneration = 0;
  // Mutation counter at the last programmatic content replacement (reset,
  // handoff, restore). A generation beyond it means the composer holds text
  // the user typed; a restore must never apply over that, and `revision`
  // cannot arbitrate because `selectRoute` zeroes it after late owner setup.
  private pristineMutationBaseline = 0;
  private restoreGeneration = 0;
  private restoredIdentity = "";
  private pending: DurableChatComposerSnapshot | null = null;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private incognitoRetirement: Promise<void> = Promise.resolve();
  private readonly lineageByScope = new Map<string, DraftLineage>();

  constructor(
    private readonly read: () => NewSessionDraftState,
    private readonly apply: (
      message: string,
      attachments: ChatAttachment[],
      resetVisibility?: boolean,
      mentions?: readonly HumanMention[],
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
    const signature = chatAttachmentDraftSignature(
      baseline.message,
      baseline.attachments,
      undefined,
      baseline.mentions,
    );
    void this.restoreScope(scope, generation, mutationGeneration, signature);
  }

  noteDraftReplaced() {
    this.pristineMutationBaseline = this.mutationGeneration;
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

  async retireActive(): Promise<void> {
    this.mutationGeneration += 1;
    this.discardPending();
    const requestedRevision = nextDraftRevision(this.revision);
    this.revision = requestedRevision;
    const scope = this.scope();
    if (!scope) {
      return;
    }
    const { retireDurableComposerDraft } = await durableComposerStore;
    const lineage = this.lineage(scope);
    const minimumRevision = Math.max(requestedRevision, lineage.revision);
    const result = await retireDurableComposerDraft(scope, minimumRevision);
    if (result.status === "storage-failed") {
      reportDurableComposerStorageError(scope, this.onStorageError);
    } else if (result.status === "persisted") {
      lineage.localWriteIds.clear();
      this.adoptCommittedRevision(scope, result.revision ?? minimumRevision, result.writeId);
    }
  }

  async clearSubmittedDraft(): Promise<void> {
    this.persistNow();
    this.mutationGeneration += 1;
    const scope = this.scope();
    if (!scope) {
      return;
    }
    const submitted = this.read();
    const submittedAttachments = captureDurableChatAttachments(submitted.attachments);
    const { readDurableComposerDraft } = await durableComposerStore;
    const lineage = this.lineage(scope);
    let expectedRevision = lineage.revision;
    let expectedWriteId = lineage.writeId;
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
            submitted.mentions,
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
        this.adoptCommittedRevision(scope, result.revision ?? revision, result.writeId ?? writeId);
        return;
      }
      if (result.status === "storage-failed") {
        reportDurableComposerStorageError(scope, this.onStorageError);
        return;
      }
    }
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
    // Start each captured write before teardown; native transactions and CAS
    // order writes without delaying attachments behind a promise chain.
    void (async () => {
      try {
        const { result, payloadUnavailable } = await writeDurableComposerSnapshot(snapshot);
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
        this.forgetLocalWrite(snapshot);
      }
    })();
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

  private snapshot(): DurableChatComposerSnapshot | null {
    const scope = this.scope();
    if (!scope || this.revision <= 0) {
      return null;
    }
    const state = this.read();
    const lineage = this.lineage(scope);
    const expectedWriteIds = [...lineage.localWriteIds];
    const writeId = `${this.revision}:${Math.random().toString(36).slice(2)}`;
    lineage.localWriteIds.add(writeId);
    return {
      scope,
      expectedRevision: lineage.revision,
      ...(lineage.writeId ? { expectedWriteId: lineage.writeId } : {}),
      expectedWriteIds,
      revision: this.revision,
      text: state.message,
      ...(state.mentions?.length
        ? { mentions: state.mentions.map((mention) => ({ ...mention })) }
        : {}),
      storedAttachments: captureDurableChatAttachments(state.attachments),
      writeId,
    };
  }

  private async restoreScope(
    scope: DurableComposerDraftScope,
    generation: number,
    mutationGeneration: number,
    signature: string,
  ) {
    const { readDurableComposerDraft } = await durableComposerStore;
    const result = await readDurableComposerDraft(scope);
    if (result.status === "storage-failed") {
      reportDurableComposerStorageError(scope, this.onStorageError);
      return;
    }
    const storedRevision = result.status === "found" ? result.draft.revision : result.revision;
    const storedWriteId = result.status === "found" ? result.draft.writeId : result.writeId;
    const lineage = this.lineage(scope);
    // An absent authoritative row clears committed facts, never in-flight IDs.
    lineage.revision = storedRevision ?? 0;
    lineage.writeId = storedWriteId;
    const current = this.read();
    const currentScope = this.scope();
    if (
      generation !== this.restoreGeneration ||
      mutationGeneration !== this.mutationGeneration ||
      !currentScope ||
      durableComposerScopeIdentity(scope) !== durableComposerScopeIdentity(currentScope) ||
      signature !==
        chatAttachmentDraftSignature(
          current.message,
          current.attachments,
          undefined,
          current.mentions,
        )
    ) {
      return;
    }
    // Restore only into a pristine composer: anything the user typed on this
    // route wins over the stored draft, even when the stored revision is
    // higher (after a reload `revision` restarts at 0, so revision order
    // cannot arbitrate against live input).
    if (
      storedRevision === undefined ||
      storedRevision < this.revision ||
      mutationGeneration > this.pristineMutationBaseline
    ) {
      if (storedRevision !== undefined && storedRevision >= this.revision) {
        this.revision = nextDraftRevision(storedRevision);
      } else if (this.revision <= 0 && mutationGeneration > this.pristineMutationBaseline) {
        // Text typed before route activation: selectRoute zeroed its revision,
        // so mint one or the snapshot below is empty and the draft never lands.
        this.revision = nextDraftRevision(0);
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
        chatAttachmentDraftSignature(
          hydratedCurrent.message,
          hydratedCurrent.attachments,
          undefined,
          hydratedCurrent.mentions,
        )
    ) {
      return;
    }
    this.revision = storedRevision;
    if (result.status === "found" && result.draft.mentions) {
      this.apply(result.draft.text, attachments, undefined, result.draft.mentions);
    } else {
      this.apply(result.status === "found" ? result.draft.text : "", attachments);
    }
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
    this.forgetLocalWrite(snapshot);
  }

  private forgetLocalWrite(snapshot: DurableChatComposerSnapshot) {
    const identity = durableComposerScopeIdentity(snapshot.scope);
    const lineage = this.lineageByScope.get(identity);
    if (!lineage) {
      return;
    }
    lineage.localWriteIds.delete(snapshot.writeId);
    if (!lineage.revision && !lineage.writeId && !lineage.localWriteIds.size) {
      this.lineageByScope.delete(identity);
    }
  }

  private lineage(scope: DurableComposerDraftScope): DraftLineage {
    const identity = durableComposerScopeIdentity(scope);
    let lineage = this.lineageByScope.get(identity);
    if (!lineage) {
      lineage = { revision: 0, localWriteIds: new Set() };
      this.lineageByScope.set(identity, lineage);
    }
    return lineage;
  }

  private adoptCommittedRevision(
    scope: DurableComposerDraftScope,
    revision: number,
    writeId?: string,
  ) {
    const identity = durableComposerScopeIdentity(scope);
    const lineage = this.lineage(scope);
    lineage.revision = revision;
    if (writeId) {
      lineage.writeId = writeId;
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
