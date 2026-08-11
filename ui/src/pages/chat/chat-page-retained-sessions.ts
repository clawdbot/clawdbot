import { html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ApplicationContext } from "../../app/context.ts";
import { nativeGatewaysCapability } from "../../app/native-gateways.runtime.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import {
  SESSION_NAVIGATION_INTENT_EVENT,
  type SessionNavigationIntent,
} from "../../lib/sessions/navigation-handoff.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { persistSessionBoardFace } from "./chat-board-face-persistence.ts";
import { clearPaneSessionHandoff, clearPaneSessionHandoffs } from "./chat-pane-shared.ts";
import { RouteDraftComposerFocus, type ChatPaneElement } from "./route-draft-focus-handoff.ts";
import { routeDraft } from "./route-draft.ts";
import type { SessionChatRouteData } from "./route-loader.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import {
  findPane,
  setActivePane,
  type ChatSplitLayout,
  type ChatSplitPane,
} from "./split-layout.ts";

const RETAINED_SESSIONS_PER_PANE = 3;
const SESSION_NAVIGATION_PREVIEW_TIMEOUT_MS = 5_000;

type RetentionHost = HTMLElement & { requestUpdate(): unknown };
type RetentionBindings = {
  context: () => ApplicationContext | undefined;
  face: () => BoardFace;
  layout: () => ChatSplitLayout;
  splitLayout: () => ChatSplitLayout | undefined;
  persistLayout: (layout: ChatSplitLayout) => void;
  selectReplacement: (paneId: string, sourceSessionKey: string, sessionKey: string) => void;
  updateRoute: (sessionKey: string, replace: boolean, face: BoardFace) => void;
};

export class ChatPageRetainedSessions {
  private readonly sessionsByPane = new Map<string, string[]>();
  private preview: (SessionNavigationIntent & { href: string; paneId: string }) | null = null;
  private previewFrame: number | undefined;
  private previewTimer: number | undefined;

  constructor(
    private readonly host: RetentionHost,
    private readonly bindings: RetentionBindings,
  ) {}

  connect(): void {
    window.addEventListener("popstate", this.cancelPreview);
    window.addEventListener(SESSION_NAVIGATION_INTENT_EVENT, this.handleNavigationIntent);
  }

  disconnect(): void {
    // Pane disconnects stage their scoped composer packages for a later chat
    // remount. Only an explicit pane/session close is terminal.
    this.sessionsByPane.clear();
    window.removeEventListener("popstate", this.cancelPreview);
    window.removeEventListener(SESSION_NAVIGATION_INTENT_EVENT, this.handleNavigationIntent);
    this.cancelPreview();
  }

  settleRoute(sessionKey: string): void {
    if (!this.preview) {
      return;
    }
    if (areUiSessionKeysEquivalent(this.preview.sessionKey, sessionKey)) {
      this.preview = null;
      this.clearPreviewWork();
    } else {
      this.cancelPreview();
    }
  }

  retain(pane: ChatSplitPane): string[] {
    let retained = this.sessionsByPane.get(pane.id);
    if (!retained) {
      retained = [];
      this.sessionsByPane.set(pane.id, retained);
    }
    const equivalentIndex = retained.findIndex(
      (key) => key === pane.sessionKey || areUiSessionKeysEquivalent(key, pane.sessionKey),
    );
    const retainedKey =
      equivalentIndex < 0 ? pane.sessionKey : retained.splice(equivalentIndex, 1)[0]!;
    retained.push(retainedKey);
    if (retained.length > RETAINED_SESSIONS_PER_PANE) {
      this.findPane(pane.id, retained.shift()!)?.prepareForEviction?.();
    }
    return retained.toSorted((left, right) => left.localeCompare(right));
  }

  prune(validPaneIds: ReadonlySet<string>): void {
    for (const paneId of this.sessionsByPane.keys()) {
      if (!validPaneIds.has(paneId)) {
        this.sessionsByPane.delete(paneId);
      }
    }
  }

  discardPane(paneId: string): void {
    const context = this.bindings.context();
    if (context) {
      clearPaneSessionHandoffs(context, paneId);
      context.chatAttachmentHandoff.clearPane(paneId);
    }
    this.sessionsByPane.delete(paneId);
  }

  readonly removeSession = (
    paneId: string,
    sessionKey: string,
    replacementSessionKey: string,
  ): void => {
    const deletedPane = this.findPane(paneId, sessionKey);
    deletedPane?.discardStagedAttachments?.();
    const retained = this.sessionsByPane.get(paneId);
    const retainedIndex = retained?.findIndex((key) => areUiSessionKeysEquivalent(key, sessionKey));
    if (retained && retainedIndex !== undefined && retainedIndex >= 0) {
      retained.splice(retainedIndex, 1);
    }
    const context = this.bindings.context();
    if (context) {
      clearPaneSessionHandoff(context, paneId, sessionKey);
    }
    if (
      this.preview?.paneId === paneId &&
      areUiSessionKeysEquivalent(this.preview.sessionKey, sessionKey)
    ) {
      this.cancelPreview();
    }
    const selectedSessionKey = findPane(this.bindings.layout(), paneId)?.pane.sessionKey;
    if (selectedSessionKey && areUiSessionKeysEquivalent(selectedSessionKey, sessionKey)) {
      this.bindings.selectReplacement(paneId, sessionKey, replacementSessionKey);
    } else {
      this.host.requestUpdate();
    }
  };

  readonly changeFace = (paneId: string, sessionKey: string, face: BoardFace): void => {
    const selectedSessionKey = findPane(this.bindings.layout(), paneId)?.pane.sessionKey;
    if (!selectedSessionKey || !areUiSessionKeysEquivalent(selectedSessionKey, sessionKey)) {
      return;
    }
    const layout = this.bindings.splitLayout();
    if (layout && layout.activePaneId !== paneId) {
      this.bindings.persistLayout(setActivePane(layout, paneId));
    }
    const context = this.bindings.context();
    if (context) {
      persistSessionBoardFace(context, sessionKey, face);
      this.bindings.updateRoute(sessionKey, false, face);
    }
  };

  private findPane(paneId: string, sessionKey: string): ChatPaneElement | undefined {
    return [...this.host.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")].find(
      (pane) =>
        pane.paneId === paneId && areUiSessionKeysEquivalent(pane.sessionKey ?? "", sessionKey),
    );
  }

  private readonly handleNavigationIntent = (event: Event) => {
    if (!(event instanceof CustomEvent)) {
      return;
    }
    this.cancelPreview();
    const intent = event.detail as SessionNavigationIntent;
    if (intent.face !== this.bindings.face()) {
      return;
    }
    const layout = this.bindings.layout();
    const activePane = findPane(layout, layout.activePaneId)?.pane;
    const retainedKey = this.sessionsByPane
      .get(activePane?.id ?? "")
      ?.find((key) => areUiSessionKeysEquivalent(key, intent.sessionKey));
    if (
      !activePane ||
      !retainedKey ||
      areUiSessionKeysEquivalent(activePane.sessionKey, retainedKey)
    ) {
      return;
    }
    this.present(activePane.id, retainedKey, true);
    // The route remains authoritative for semantic/global ownership. Both
    // presentations stay inert until it settles; only visual ownership moves.
    const preview = {
      ...intent,
      href: window.location.href,
      paneId: activePane.id,
      sessionKey: retainedKey,
    };
    this.preview = preview;
    this.previewFrame = requestAnimationFrame(() => {
      if (this.preview !== preview) {
        return;
      }
      this.previewFrame = requestAnimationFrame(() => {
        this.previewFrame = undefined;
        if (
          this.preview === preview &&
          (window.location.href !== preview.href || !preview.commit())
        ) {
          this.cancelPreview();
        }
      });
    });
    this.previewTimer = window.setTimeout(
      this.cancelPreview,
      SESSION_NAVIGATION_PREVIEW_TIMEOUT_MS,
    );
    event.preventDefault();
  };

  private present(paneId: string, sessionKey: string, preview = false): void {
    for (const pane of this.host.querySelectorAll<ChatPaneElement>("openclaw-chat-pane")) {
      if (pane.paneId !== paneId) {
        continue;
      }
      const presented = areUiSessionKeysEquivalent(pane.sessionKey ?? "", sessionKey);
      pane.classList.toggle("chat-pane-cache__pane--visible", presented);
      if (preview) {
        pane.toggleAttribute("inert", true);
        continue;
      }
      pane.toggleAttribute("inert", !presented);
      pane.setAttribute("aria-hidden", presented ? "false" : "true");
      pane.presented = presented;
    }
  }

  private clearPreviewWork(): void {
    if (this.previewFrame !== undefined) {
      cancelAnimationFrame(this.previewFrame);
      this.previewFrame = undefined;
    }
    if (this.previewTimer !== undefined) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = undefined;
    }
  }

  private readonly cancelPreview = () => {
    this.clearPreviewWork();
    this.preview = null;
    const layout = this.bindings.layout();
    const activePane = findPane(layout, layout.activePaneId)?.pane;
    if (activePane) {
      this.present(activePane.id, activePane.sessionKey);
    }
  };
}

export function renderRetainedChatPanes(params: {
  active: boolean;
  chatMessagesBySession: ChatMessageCache;
  consumedDraftData: SessionChatRouteData | null;
  data: SessionChatRouteData;
  draftFocus: RouteDraftComposerFocus;
  mergedChrome: boolean;
  narrow: boolean;
  navDrawerOpen: boolean;
  onboarding: boolean;
  onClosePane?: (paneId: string) => void;
  onFaceChange: (paneId: string, sessionKey: string, face: BoardFace) => void;
  onFocusPane: (paneId: string) => void;
  onOpenSplitView?: () => void;
  onPaneSessionChange: (
    paneId: string,
    sourceSessionKey: string,
    sessionKey: string,
    options?: { replace?: boolean },
  ) => boolean;
  onSessionDeleted: (paneId: string, sessionKey: string, replacementSessionKey: string) => void;
  onSplitDown?: (paneId: string) => void;
  onSplitRight?: (paneId: string) => void;
  ownerKey: string;
  pane: ChatSplitPane;
  sessionKeys: readonly string[];
  showGatewayPicker: boolean;
  splitMode: boolean;
  context?: ApplicationContext;
}) {
  const nativeGateways = nativeGatewaysCapability();
  const sessions = params.context?.sessions?.state.result?.sessions ?? [];
  return repeat(
    params.sessionKeys,
    (sessionKey) => sessionKey,
    (sessionKey) => {
      const visible =
        sessionKey === params.pane.sessionKey ||
        areUiSessionKeysEquivalent(sessionKey, params.pane.sessionKey);
      const presented = visible && (!params.narrow || params.active);
      const active = params.active && visible;
      const draft = active
        ? routeDraft(params.data, params.consumedDraftData, sessionKey)
        : undefined;
      const focus = params.draftFocus.shouldFocusPane(active, draft, sessionKey, params.data);
      const resolvedKey =
        resolveSessionKey(sessionKey, params.context?.gateway?.snapshot?.hello) || sessionKey;
      const title = resolveSessionDisplayName(
        resolvedKey,
        sessions.find((row) => areUiSessionKeysEquivalent(row.key, resolvedKey)),
      );
      return html`<openclaw-chat-pane
        class="chat-pane-cache__pane ${visible ? "chat-pane-cache__pane--visible" : ""} ${active
          ? "chat-pane-cache__pane--active"
          : ""} ${params.splitMode ? "chat-split-view__pane" : ""}"
        data-mcp-app-owner-key=${JSON.stringify([params.ownerKey, sessionKey])}
        aria-hidden=${presented ? "false" : "true"}
        ?inert=${!presented}
        .paneId=${params.pane.id}
        .presentationId=${JSON.stringify([params.pane.id, sessionKey])}
        .chatMessagesBySession=${params.chatMessagesBySession}
        .sessionKey=${sessionKey}
        .presented=${presented}
        .active=${active}
        .draft=${draft}
        .focusComposer=${focus}
        .routeFace=${params.data?.face ?? "chat"}
        .paneTitle=${title}
        .narrow=${params.narrow}
        .mergedChrome=${params.mergedChrome && active}
        .navDrawerOpen=${params.navDrawerOpen && active}
        .nativeGateways=${params.showGatewayPicker ? nativeGateways : null}
        .gatewaysSnapshot=${params.showGatewayPicker ? (nativeGateways?.snapshot ?? null) : null}
        .onboarding=${params.onboarding}
        .onOpenSplitView=${params.onOpenSplitView}
        .onSplitDown=${params.onSplitDown}
        .onSplitRight=${params.onSplitRight}
        .onClosePane=${params.onClosePane}
        .onFocusPane=${params.onFocusPane}
        .onPaneSessionChange=${(
          paneId: string,
          nextSessionKey: string,
          options?: { replace?: boolean },
        ) => params.onPaneSessionChange(paneId, sessionKey, nextSessionKey, options)}
        .onSessionDeleted=${params.onSessionDeleted}
        .onFaceChange=${params.onFaceChange}
      ></openclaw-chat-pane>`;
    },
  );
}
