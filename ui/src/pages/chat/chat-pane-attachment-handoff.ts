import type { ChatInputRegion } from "../../app/chat-input-owner.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { storageTargetForGateway } from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import {
  releaseChatAttachmentPayloads,
  releaseDisplacedChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { storedChatOutboxScopeKey } from "./composer-persistence.ts";
import type { ChatSplitLayout } from "./split-layout-types.ts";
import { panesOf, visiblePanesOf } from "./split-layout.ts";

export type ChatAttachmentGatewayOwner = ApplicationContext["gateway"]["snapshot"]["client"];

type ComposerPresentation = {
  state: () => ChatPageHost | undefined;
  owner: () => ChatAttachmentGatewayOwner;
  region: () => ChatInputRegion;
  presented: () => boolean;
  pause: () => void;
  resume: (restore?: boolean) => void;
};
type ComposerOwnerScope = {
  owner: NonNullable<ChatAttachmentGatewayOwner>;
  gatewayOwner: string;
  recoveryScope: string;
  scopeKey: string;
};
const composerPresentations = new WeakMap<ApplicationContext, Set<ChatPaneComposerHandoff>>();

/** Transfers live composer ownership across regions, never between ordinary split panes.
 * The registry holds presentations only; existing persistence still owns stored drafts. */
export class ChatPaneComposerHandoff {
  private readonly presentations: Set<ChatPaneComposerHandoff>;
  private scope: ComposerOwnerScope | null;
  private ownsComposer = true;

  constructor(
    context: ApplicationContext,
    private readonly host: ComposerPresentation,
  ) {
    let presentations = composerPresentations.get(context);
    if (!presentations) {
      presentations = new Set();
      composerPresentations.set(context, presentations);
    }
    this.presentations = presentations;
    this.scope = this.currentScope();
    presentations.add(this);
  }

  claim(): void {
    if (!this.host.presented()) {
      return;
    }
    const scope = this.currentScope();
    const source = this.otherRegion(scope).find((candidate) => candidate.ownsComposer);
    source?.transferTo(this);
    if (!this.ownsComposer) {
      this.host.resume(true);
      this.ownsComposer = true;
    }
    this.scope = scope;
    // Most recently presented wins when the same Home appeared in multiple splits.
    this.presentations.delete(this);
    this.presentations.add(this);
  }

  dispose(): void {
    if (this.ownsComposer) {
      const candidates = this.otherRegion(this.currentScope());
      const target = candidates.find((candidate) => candidate.host.presented()) ?? candidates[0];
      if (target) {
        this.transferTo(target);
      }
    }
    this.presentations.delete(this);
  }

  private currentScope(): ComposerOwnerScope | null {
    const state = this.host.state();
    const owner = this.host.owner();
    const recoveryScope = owner?.recoveryScope;
    return state && owner && state.client === owner && recoveryScope
      ? {
          owner,
          gatewayOwner: storageTargetForGateway(state.settings.gatewayUrl).gatewayOwner,
          recoveryScope,
          scopeKey: storedChatOutboxScopeKey(
            resolveUiConversationIdentity(state, state.sessionKey),
          ),
        }
      : null;
  }

  private otherRegion(scope: ComposerOwnerScope | null): ChatPaneComposerHandoff[] {
    return [...this.presentations]
      .toReversed()
      .filter(
        (candidate) =>
          candidate.host.region() !== this.host.region() && candidate.matchesScope(scope),
      );
  }

  private matchesScope(scope: ComposerOwnerScope | null): boolean {
    const captured = this.scope;
    const current = this.currentScope();
    return Boolean(
      scope &&
      captured &&
      current &&
      current.owner === scope.owner &&
      captured.gatewayOwner === scope.gatewayOwner &&
      captured.recoveryScope === scope.recoveryScope &&
      captured.scopeKey === scope.scopeKey &&
      // A new transport must prove the same authenticated owner before taking
      // over a live draft. Ordinary reconnects retain their captured identity.
      (current.owner === captured.owner || current.owner.recoveryScopeReady) &&
      current.gatewayOwner === captured.gatewayOwner &&
      current.recoveryScope === captured.recoveryScope &&
      current.scopeKey === captured.scopeKey,
    );
  }

  private transferTo(target: ChatPaneComposerHandoff): void {
    const sourceState = this.host.state();
    const targetState = target.host.state();
    if (!sourceState || !targetState || !this.matchesScope(target.currentScope())) {
      return;
    }
    this.host.pause();
    target.host.pause();
    const attachments = sourceState.chatAttachments;
    const fallbacks = sourceState.chatComposerFallbackByScope;
    releaseDisplacedChatAttachmentPayloads(
      [
        targetState.chatAttachments,
        ...Object.values(targetState.chatComposerFallbackByScope).map(
          (fallback) => fallback.attachments,
        ),
      ].flat(),
      [attachments, ...Object.values(fallbacks).map((fallback) => fallback.attachments)],
    );
    targetState.chatMessage = sourceState.chatMessage;
    targetState.chatMentions = sourceState.chatMentions;
    targetState.chatGoalDraftMode = sourceState.chatGoalDraftMode;
    targetState.chatReplyTarget = sourceState.chatReplyTarget;
    targetState.chatQueuedEdit = sourceState.chatQueuedEdit;
    targetState.chatAttachments = attachments;
    targetState.chatComposerFallbackByScope = fallbacks;
    sourceState.chatMessage = "";
    sourceState.chatMentions = [];
    sourceState.chatGoalDraftMode = null;
    sourceState.chatReplyTarget = null;
    sourceState.chatQueuedEdit = null;
    sourceState.chatAttachments = [];
    sourceState.chatComposerFallbackByScope = {};
    this.ownsComposer = false;
    target.ownsComposer = true;
    target.scope = target.currentScope();
    target.host.resume();
    sourceState.requestUpdate?.();
    targetState.requestUpdate?.();
  }
}

function handoffKey(paneId: string, state: ChatPageHost, owner: ChatAttachmentGatewayOwner) {
  return {
    owner,
    paneId,
    scopeKey: storedChatOutboxScopeKey(resolveUiConversationIdentity(state, state.sessionKey)),
  };
}

export function restorePaneStagedAttachments(
  context: ApplicationContext,
  paneId: string,
  state: ChatPageHost,
  owner: ChatAttachmentGatewayOwner,
): void {
  const restored = context.chatAttachmentHandoff.consume(handoffKey(paneId, state, owner));
  if (!restored) {
    return;
  }
  const currentIds = new Set(state.chatAttachments.map((attachment) => attachment.id));
  state.chatAttachments = [
    ...state.chatAttachments,
    ...restored.attachments.filter((attachment) => !currentIds.has(attachment.id)),
  ];
  const displaced = Object.entries(restored.fallbacks)
    .filter(([scopeKey]) => Object.hasOwn(state.chatComposerFallbackByScope, scopeKey))
    .flatMap(([, fallback]) => fallback.attachments);
  state.chatComposerFallbackByScope = {
    ...restored.fallbacks,
    ...state.chatComposerFallbackByScope,
  };
  releaseDisplacedChatAttachmentPayloads(displaced, [
    state.chatAttachments,
    ...Object.values(state.chatComposerFallbackByScope).map((fallback) => fallback.attachments),
  ]);
}

export function preparePaneStagedAttachments(
  context: ApplicationContext,
  paneId: string,
  state: ChatPageHost,
  owner: ChatAttachmentGatewayOwner,
): void {
  const attachments = [...state.chatAttachments];
  context.chatAttachmentHandoff.prepare({
    ...handoffKey(paneId, state, owner),
    attachments,
    fallbacks: state.chatComposerFallbackByScope,
  });
}

export function discardStateStagedAttachments(state: ChatPageHost | undefined): void {
  if (!state) {
    return;
  }
  releaseChatAttachmentPayloads(state.chatAttachments);
  for (const fallback of Object.values(state.chatComposerFallbackByScope)) {
    releaseChatAttachmentPayloads(fallback.attachments);
    fallback.attachments = [];
  }
  state.chatAttachments = [];
}

export function replacePaneStagedAttachmentGatewayOwner(
  context: ApplicationContext,
  paneId: string,
  state: ChatPageHost | undefined,
  previousOwner: ChatAttachmentGatewayOwner,
  nextOwner: ChatAttachmentGatewayOwner,
): ChatAttachmentGatewayOwner {
  if (!nextOwner || previousOwner === nextOwner) {
    return previousOwner;
  }
  // Rotating the client invalidates annotation Undo context owned by the old
  // client, but plain file/image payloads are client-local data URLs — a gap
  // reconnect or plugin-install rotation must not silently discard them.
  if (state) {
    const dropAnnotations = (attachments: readonly ChatAttachment[]) => {
      releaseChatAttachmentPayloads(
        attachments.filter((attachment) => attachment.browserAnnotation),
      );
      return attachments.filter((attachment) => !attachment.browserAnnotation);
    };
    state.chatAttachments = dropAnnotations(state.chatAttachments);
    for (const fallback of Object.values(state.chatComposerFallbackByScope)) {
      fallback.attachments = dropAnnotations(fallback.attachments);
    }
    state.requestUpdate?.();
  }
  context.chatAttachmentHandoff.clearPane(paneId);
  return nextOwner;
}

type StagedAttachmentPane = Element & {
  paneId: string;
  sessionKey: string;
  discardStagedAttachments?: () => void;
  resumeStagedAttachments?: () => void;
};

export function resumeStagedPanes(
  root: ParentNode,
  layout: ChatSplitLayout,
  narrow: boolean,
): void {
  const visiblePaneIds = new Set(visiblePanesOf(layout, narrow).map((pane) => pane.id));
  for (const pane of root.querySelectorAll<StagedAttachmentPane>("openclaw-chat-pane")) {
    if (visiblePaneIds.has(pane.paneId)) {
      pane.resumeStagedAttachments?.();
    }
  }
}

export function closeStagedPane(
  context: ApplicationContext,
  root: ParentNode,
  layout: ChatSplitLayout,
  paneId: string,
) {
  const survivingPane = panesOf(layout).find((candidate) => candidate.id !== paneId);
  const mounted = [...root.querySelectorAll<StagedAttachmentPane>("openclaw-chat-pane")].filter(
    (candidate) => candidate.paneId === paneId,
  );
  // Clear every retained presentation first so their disconnects cannot
  // restage a package under a later reused logical pane id.
  for (const pane of mounted) {
    pane.discardStagedAttachments?.();
  }
  context.chatAttachmentHandoff.clearPane(paneId);
  return survivingPane;
}
