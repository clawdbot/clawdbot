import {
  hasNativeBrowserBridge,
  postNativeBrowserMessage,
  readNativeBrowserState,
  subscribeNativeBrowserState,
  type NativeBrowserMessage,
  type NativeBrowserState,
  type NativeBrowserTab,
} from "../../app/native-browser-bridge.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  readBrowserInspectedNode,
  type BrowserInspectedNode,
  type BrowserPanelTab,
} from "./browser-client.ts";
import { BrowserPanelNativePresentation } from "./browser-panel-native-presentation.ts";
import type { BrowserPanelControllerHost } from "./browser-panel-operation-ownership.ts";
import type { BrowserPanelPendingInput } from "./browser-panel-pending-input.ts";
import {
  browserPanelNormalizedPoint,
  browserPanelRemotePoint,
  loadBrowserPanelImage,
  type BrowserPanelView,
} from "./browser-panel-surface.ts";

type BrowserPanelNativeState = {
  tabs: BrowserPanelTab[];
  activeTargetId: string | null;
  view: BrowserPanelView | null;
  mode: "interact" | "annotate" | "inspect";
  loading: boolean;
  errorText: string | null;
  pendingNewTab: boolean;
  urlDraft: string;
  inspected: BrowserInspectedNode | null;
  inspectPointer: { x: number; y: number } | null;
};

interface BrowserPanelNativeHost extends BrowserPanelNativeState {
  readonly host: Pick<
    BrowserPanelControllerHost,
    "isConnected" | "browserPanelIsOpen" | "renderRoot" | "updateComplete"
  >;
  readonly native: { readonly activeTab: NativeBrowserTab | undefined };
  readonly pendingInput: Pick<BrowserPanelPendingInput, "queueInspection">;
  setState<Key extends keyof BrowserPanelNativeState>(
    key: Key,
    value: BrowserPanelNativeState[Key],
  ): void;
  selectTab(targetId: string): Promise<void>;
  syncUrlDraft(url: string): void;
  reportError(error: unknown): void;
  exitCaptureModes(): void;
  paintOverlay(): void;
}

const presenters = new Set<BrowserPanelNativeController>();
const popupScopes = new Map<string, string>();

/** Window-owned native state is shared by every session's panel instance. */
export class BrowserPanelNativeController {
  readonly presentation: BrowserPanelNativePresentation;
  private nativeTabs: NativeBrowserTab[] = [];
  private unsubscribeState?: () => void;
  private revision = -1;
  private pendingActivation: string | null = null;
  /** New-tab request whose address field should be cleared and focused once it is selected. */
  private pendingAddressFocus: string | null = null;
  private captureGeneration = 0;
  private inspectionGeneration = 0;

  constructor(private readonly controller: BrowserPanelNativeHost) {
    this.presentation = new BrowserPanelNativePresentation(controller);
  }

  get activeTab(): NativeBrowserTab | undefined {
    return this.nativeTabs.find((tab) => tab.id === this.controller.activeTargetId);
  }

  get tabs(): BrowserPanelTab[] {
    return this.nativeTabs.map((tab) => ({ ...tab, targetId: tab.id, kind: "native" }));
  }

  connect(): void {
    if (!hasNativeBrowserBridge() || this.unsubscribeState) {
      return;
    }
    presenters.add(this);
    this.revision = -1;
    const initial = readNativeBrowserState();
    if (initial) {
      this.acceptState(initial, false);
    }
    this.unsubscribeState = subscribeNativeBrowserState((state) => this.acceptState(state, true));
    this.presentation.connect();
  }

  disconnect(): void {
    if (!this.unsubscribeState) {
      return;
    }
    this.unsubscribeState();
    this.unsubscribeState = undefined;
    presenters.delete(this);
    this.pendingActivation = null;
    this.cancelCapture();
    this.presentation.disconnect();
  }

  mergeRemoteTabs(tabs: BrowserPanelTab[]): BrowserPanelTab[] {
    return [...this.tabs, ...tabs.filter((tab) => tab.kind !== "native")];
  }

  private acceptState(state: NativeBrowserState, activatePopups: boolean): void {
    if (state.revision <= this.revision) {
      return;
    }
    const previous = new Set(this.nativeTabs.map((tab) => tab.id));
    const activeBefore = this.activeTab;
    this.revision = state.revision;
    this.nativeTabs = state.tabs;
    this.controller.setState("tabs", this.mergeRemoteTabs(this.controller.tabs));
    const view = this.controller.view;
    if (
      view?.kind === "native" &&
      this.nativeTabs.find((tab) => tab.id === view.targetId)?.url !== view.url
    ) {
      this.controller.exitCaptureModes();
      this.controller.setState("view", null);
    }
    for (const id of popupScopes.keys()) {
      if (!state.tabs.some((tab) => tab.id === id)) {
        popupScopes.delete(id);
      }
    }
    for (const tab of state.tabs) {
      if (tab.id === this.pendingActivation) {
        this.pendingActivation = null;
        void this.controller.selectTab(tab.id).then(() => {
          if (this.pendingAddressFocus === tab.id) {
            this.focusAddress(tab.id);
          }
        });
      } else if (activatePopups && tab.openedBy === "native" && !previous.has(tab.id)) {
        if (!popupScopes.has(tab.id)) {
          const eligible = [...presenters];
          const owner =
            eligible
              .filter((presenter) => presenter.presentation.presentedTabId === tab.openerTabId)
              .toSorted((a, b) => b.presentation.lastPresented - a.presentation.lastPresented)[0] ??
            eligible
              .filter((presenter) => presenter.presentation.lastPresented > 0)
              .toSorted((a, b) => b.presentation.lastPresented - a.presentation.lastPresented)[0];
          if (owner) {
            popupScopes.set(tab.id, owner.presentation.scope);
          }
        }
        if (popupScopes.get(tab.id) === this.presentation.scope) {
          void this.controller.selectTab(tab.id);
        }
      }
    }
    if (activeBefore && !this.activeTab) {
      const next = this.controller.tabs[0];
      this.controller.setState("activeTargetId", null);
      this.controller.setState("view", null);
      this.controller.exitCaptureModes();
      // A pending open selects its own tab when its state lands; an automatic
      // fallback would cancel that activation and strand the newer request.
      if (next && !this.pendingActivation) {
        void this.controller.selectTab(next.id);
      } else if (!next) {
        // The closed tab's address must not linger in the empty panel.
        this.controller.syncUrlDraft("");
      }
    } else if (!this.controller.activeTargetId && !this.pendingActivation && this.nativeTabs[0]) {
      void this.controller.selectTab(this.nativeTabs[0].id);
    }
    if (this.activeTab) {
      this.controller.syncUrlDraft(this.activeTab.url);
      if (this.controller.mode === "interact") {
        this.controller.setState("loading", this.activeTab.loading);
      }
    }
    this.presentation.update();
  }

  async send(request: NativeBrowserMessage): Promise<boolean> {
    const reply = await postNativeBrowserMessage(request);
    if (reply && !reply.ok) {
      this.controller.reportError(reply.error);
    }
    return reply?.ok === true;
  }

  /**
   * A selection supersedes any in-flight open. Selecting a different tab also
   * drops a pending address focus; selecting the awaited tab keeps it.
   */
  cancelPendingActivation(selectedTabId?: string): void {
    this.pendingActivation = null;
    if (this.pendingAddressFocus !== selectedTabId) {
      this.pendingAddressFocus = null;
    }
  }

  /**
   * Resolves with the tab this request still owns once it is selected, or null
   * when the request was superseded, failed, or its activation already landed
   * through a state push (the push path finishes any pending address focus).
   */
  async open(url: string, newTab: boolean, focusAddress = false): Promise<string | null> {
    this.controller.setState("errorText", null);
    this.controller.setState("pendingNewTab", false);
    if (!newTab && this.activeTab) {
      const tabId = this.activeTab.id;
      this.controller.exitCaptureModes();
      return (await this.send({ type: "navigate", tabId, url })) ? tabId : null;
    }
    const tabId = `mac-${generateUUID()}`;
    this.pendingActivation = tabId;
    this.pendingAddressFocus = focusAddress ? tabId : null;
    const reply = await postNativeBrowserMessage({ type: "open", tabId, url, activate: true });
    if (this.pendingActivation !== tabId) {
      return null;
    }
    if (!reply?.ok || !reply.tabId) {
      this.cancelPendingActivation();
      if (reply && !reply.ok) {
        this.controller.reportError(reply.error);
      }
      return null;
    }
    this.pendingActivation = reply.tabId;
    if (focusAddress) {
      this.pendingAddressFocus = reply.tabId;
    }
    if (this.nativeTabs.some((tab) => tab.id === reply.tabId)) {
      this.pendingActivation = null;
      await this.controller.selectTab(reply.tabId);
      this.presentation.renew();
      return reply.tabId;
    }
    return null;
  }

  async beginNewTab(): Promise<void> {
    const tabId = await this.open("about:blank", true, true);
    if (!tabId || this.pendingAddressFocus !== tabId) {
      return;
    }
    await this.controller.host.updateComplete;
    this.focusAddress(tabId);
  }

  private focusAddress(tabId: string): void {
    if (this.controller.activeTargetId !== tabId) {
      return;
    }
    this.pendingAddressFocus = null;
    if (this.controller.host.isConnected && this.controller.host.browserPanelIsOpen()) {
      this.controller.setState("urlDraft", "");
      this.controller.host.renderRoot.querySelector<HTMLInputElement>(".bp-url")?.focus();
    }
  }

  cancelCapture(): void {
    this.captureGeneration += 1;
    this.inspectionGeneration += 1;
  }

  async capture(mode: "annotate" | "inspect"): Promise<void> {
    const tab = this.activeTab;
    if (!tab) {
      return;
    }
    const generation = ++this.captureGeneration;
    this.controller.setState("loading", true);
    const current = () =>
      generation === this.captureGeneration &&
      this.controller.host.isConnected &&
      this.controller.host.browserPanelIsOpen() &&
      this.activeTab?.id === tab.id &&
      this.activeTab.url === tab.url;
    try {
      const reply = await postNativeBrowserMessage({ type: "snapshot", tabId: tab.id });
      if (!current()) {
        return;
      }
      if (
        !reply?.ok ||
        typeof reply.dataUrl !== "string" ||
        typeof reply.cssWidth !== "number" ||
        typeof reply.cssHeight !== "number"
      ) {
        if (reply && !reply.ok) {
          this.controller.reportError(reply.error);
        }
        return;
      }
      const image = await loadBrowserPanelImage(reply.dataUrl);
      if (!current()) {
        return;
      }
      this.controller.setState("view", {
        kind: "native",
        targetId: tab.id,
        dataUrl: reply.dataUrl,
        image,
        url: tab.url,
        metrics: {
          cssWidth: reply.cssWidth,
          cssHeight: reply.cssHeight,
          title: tab.title,
          url: tab.url,
        },
      });
      this.controller.setState("mode", mode);
      this.presentation.hide();
    } catch (error) {
      if (current()) {
        this.controller.reportError(error);
      }
    } finally {
      if (current()) {
        this.controller.setState("loading", false);
      }
    }
  }

  inspect(event: PointerEvent): void {
    const tab = this.activeTab;
    const view = this.controller.view;
    const stage = this.controller.host.renderRoot.querySelector<HTMLElement>(".bp-stage");
    const point = browserPanelRemotePoint(stage, event, view);
    const normalized = browserPanelNormalizedPoint(stage, event);
    if (
      !tab ||
      view?.kind !== "native" ||
      view.targetId !== tab.id ||
      view.url !== tab.url ||
      !point ||
      !normalized ||
      this.controller.mode !== "inspect"
    ) {
      return;
    }
    const generation = ++this.inspectionGeneration;
    const current = () =>
      generation === this.inspectionGeneration &&
      this.controller.host.isConnected &&
      this.controller.host.browserPanelIsOpen() &&
      this.activeTab?.id === tab.id &&
      this.activeTab.url === view.url &&
      this.controller.view === view &&
      this.controller.mode === "inspect";
    this.controller.setState("inspectPointer", normalized);
    this.controller.setState("inspected", null);
    this.controller.pendingInput.queueInspection(120, current, () => {
      void postNativeBrowserMessage({
        type: "inspect",
        tabId: tab.id,
        x: point.x,
        y: point.y,
      }).then((reply) => {
        if (!current()) {
          return;
        }
        if (reply && !reply.ok) {
          this.controller.reportError(reply.error);
        } else if (reply?.ok && "node" in reply) {
          this.controller.setState("inspected", readBrowserInspectedNode(reply.node));
          this.controller.paintOverlay();
        }
      });
    });
  }
}
