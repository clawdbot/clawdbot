import type { ApplicationContext } from "../../app/context.ts";
import {
  SESSION_NAVIGATION_INTENT_EVENT,
  type SessionNavigationIntent,
} from "../../lib/sessions/navigation-handoff.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { clearPaneSessionHandoff, clearPaneSessionHandoffs } from "./chat-pane-shared.ts";
import type { ChatPaneElement } from "./route-draft-focus-handoff.ts";
import type { ChatSplitLayout, ChatSplitPane } from "./split-layout-types.ts";
import { findPane } from "./split-layout.ts";

const RETAINED_SESSIONS_PER_PANE = 3;
const SESSION_NAVIGATION_PREVIEW_TIMEOUT_MS = 5_000;

type RetentionHost = HTMLElement & { requestUpdate(): unknown };
type RetentionBindings = {
  context: () => ApplicationContext | undefined;
  face: () => SessionNavigationIntent["face"];
  layout: () => ChatSplitLayout;
  selectReplacement: (paneId: string, sourceSessionKey: string, sessionKey: string) => void;
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

  retain(panes: readonly ChatSplitPane[]): ReadonlyMap<string, readonly string[]> {
    const paneIds = new Set(panes.map((pane) => pane.id));
    for (const paneId of this.sessionsByPane.keys()) {
      if (!paneIds.has(paneId)) {
        this.sessionsByPane.delete(paneId);
      }
    }
    return new Map(panes.map((pane) => [pane.id, this.retainPane(pane)]));
  }

  private retainPane(pane: ChatSplitPane): string[] {
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
    preserveDraft = false,
  ): void => {
    const deletedPane = this.findPane(paneId, sessionKey);
    if (!preserveDraft) {
      deletedPane?.discardStagedAttachments?.();
    }
    const retained = this.sessionsByPane.get(paneId);
    const retainedIndex = retained?.findIndex((key) => areUiSessionKeysEquivalent(key, sessionKey));
    if (retained && retainedIndex !== undefined && retainedIndex >= 0) {
      retained.splice(retainedIndex, 1);
    }
    const context = this.bindings.context();
    if (context && !preserveDraft) {
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
      pane.visuallyPresented = presented;
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
