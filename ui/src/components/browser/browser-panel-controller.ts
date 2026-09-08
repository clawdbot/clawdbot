import type { ReactiveController } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { hasNativeBrowserBridge } from "../../app/native-browser-bridge.ts";
import { postNativeExternalLink } from "../../app/native-link-routing.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { openExternalUrlSafe } from "../../lib/open-external-url.ts";
import type { AnnotationStroke } from "./browser-annotation.ts";
import type {
  BrowserRequestClient,
  BrowserInspectedNode,
  BrowserPanelTab,
} from "./browser-client.ts";
import {
  closeBrowserTab,
  focusBrowserTab,
  goBrowserHistory,
  isBrowserEvaluateDisabledError,
  isBrowserNavigationBlockedError,
  listBrowserTabs,
  navigateBrowser,
  openBrowserTab,
  startBrowser,
} from "./browser-client.ts";
import { BrowserPanelInputController } from "./browser-panel-controller-input.ts";
import { BrowserPanelNativeController } from "./browser-panel-native-controller.ts";
import {
  BrowserPanelOperationOwnership,
  type BrowserPanelControllerHost,
  type BrowserPanelSnapshotOutcome,
} from "./browser-panel-operation-ownership.ts";
import { BrowserPanelPendingInput } from "./browser-panel-pending-input.ts";
import { BrowserPanelSnapshotController } from "./browser-panel-snapshot-controller.ts";
import { BrowserPanelStream } from "./browser-panel-stream.ts";
import type { BrowserPanelView } from "./browser-panel-surface.ts";
import { BrowserPanelViewportController } from "./browser-panel-viewport-controller.ts";
import { browserRouteKey, type BrowserRoute } from "./browser-target.ts";
import { normalizeBrowserUrlDraft } from "./browser-url.ts";

const ACTION_REFRESH_DELAY_MS = 350;

type BrowserPanelMode = "interact" | "annotate" | "inspect";

export type { BrowserPanelControllerHost } from "./browser-panel-operation-ownership.ts";

/** Browser session, navigation, capture, and input lifecycle for the docked surface. */
export class BrowserPanelController implements ReactiveController {
  running: boolean | null = null;
  tabs: BrowserPanelTab[] = [];
  /** Stable tab handle (plugin alias when available), not a raw CDP target id. */
  activeTargetId: string | null = null;
  view: BrowserPanelView | null = null;
  loading = false;
  errorText: string | null = null;
  noticeText: string | null = null;
  mode: BrowserPanelMode = "interact";
  strokes: AnnotationStroke[] = [];
  inspected: BrowserInspectedNode | null = null;
  inspectPointer: { x: number; y: number } | null = null;
  evaluateUnavailable = false;
  urlDraft = "";
  pendingNewTab = false;

  readonly native: BrowserPanelNativeController;
  readonly operations: BrowserPanelOperationOwnership;
  readonly pendingInput = new BrowserPanelPendingInput();
  private readonly input: BrowserPanelInputController;
  readonly stream: BrowserPanelStream;
  private activeClient: GatewayBrowserClient | null = null;
  urlDraftEditing = false;
  private readonly viewport = new BrowserPanelViewportController(this);
  private readonly snapshot = new BrowserPanelSnapshotController(this, this.viewport);

  constructor(readonly host: BrowserPanelControllerHost) {
    this.operations = new BrowserPanelOperationOwnership(host);
    this.input = new BrowserPanelInputController(this);
    this.stream = new BrowserPanelStream(this);
    this.native = new BrowserPanelNativeController(this);
    host.addController(this);
  }

  hostConnected(): void {
    this.native.connect();
  }

  hostUpdated(): void {
    this.native.presentation.update();
  }

  hostDisconnected(): void {
    this.suspendView();
    this.native.disconnect();
  }

  suspendView(): void {
    this.native.cancelCapture();
    this.native.presentation.hide();
    this.input.cancelOverlayPointerGesture();
    this.invalidateViewOperations();
    if (this.view?.dataUrl.startsWith("blob:")) {
      this.setState("view", null);
    }
    this.setState("loading", false);
  }

  setState<Key extends keyof this>(key: Key, value: this[Key]): void {
    if (Object.is(this[key], value)) {
      return;
    }
    if ((key === "view" && value === null) || key === "activeTargetId") {
      this.stream.close();
    }
    Object.assign(this, { [key]: value });
    this.host.requestUpdate();
    if (key === "activeTargetId" || key === "mode") {
      this.native.presentation.update();
    }
  }

  synchronizeClient(): boolean {
    if (this.host.client !== this.activeClient) {
      this.activeClient = this.host.client;
      this.operations.resetRoute();
      this.resetBrowserState();
      return true;
    }
    return false;
  }

  get unavailableTabText(): string | null {
    const reason = this.tabs.find((tab) => tab.id === this.activeTargetId)?.urlUnavailableReason;
    return reason
      ? t(
          reason === "navigation_blocked"
            ? "browser.navigationBlocked"
            : "browser.navigationCheckFailed",
        )
      : null;
  }

  clearUnavailableView(): boolean {
    if (!this.unavailableTabText) {
      return false;
    }
    this.invalidateViewOperations();
    this.setState("view", null);
    this.setState("loading", false);
    this.setState("urlDraft", "");
    this.setState("errorText", null);
    this.exitCaptureModes();
    return true;
  }

  private invalidateViewOperations(): void {
    this.stream.close();
    this.operations.invalidate();
    this.pendingInput.clear();
    this.viewport.invalidate();
  }

  resetBrowserState(): void {
    this.invalidateViewOperations();
    this.setState("running", null);
    const nativeTab = this.native.activeTab ?? this.native.tabs[0];
    this.setState("tabs", this.native.tabs);
    this.setState("activeTargetId", nativeTab?.id ?? null);
    this.setState("view", null);
    this.setState("loading", false);
    this.setState("errorText", null);
    this.setState("noticeText", null);
    this.setState("mode", "interact");
    this.setState("strokes", []);
    this.input.resetCaptureState();
    this.setState("inspected", null);
    this.setState("inspectPointer", null);
    this.urlDraftEditing = false;
    this.setState("urlDraft", nativeTab?.url ?? "");
    this.setState("pendingNewTab", false);
    // Re-probe per connection: another gateway may have evaluate enabled.
    this.setState("evaluateUnavailable", false);
  }

  reportError(error: unknown): void {
    const detail = isBrowserNavigationBlockedError(error)
      ? t("browser.navigationBlocked")
      : formatUiError(error);
    this.setState("errorText", t("browser.errors.requestFailed", { error: detail }));
  }

  async refreshAll(): Promise<void> {
    this.native.presentation.update();
    const client = this.operations.captureClient();
    if (!client) {
      return;
    }
    const invocation = this.operations.beginSnapshot(client);
    this.setState("errorText", null);
    if (!this.native.activeTab && !this.stream.ownsView(this.activeTargetId)) {
      this.setState("loading", true);
    }
    try {
      const snapshot = await listBrowserTabs(client);
      // Tool results carry raw targets; preserve that selection when the list supplies its alias.
      const selected = snapshot.tabs.find(
        (tab) => tab.id === this.activeTargetId || tab.targetId === this.activeTargetId,
      );
      const active =
        selected ?? snapshot.tabs.find((tab) => !tab.urlUnavailableReason) ?? snapshot.tabs[0];
      if (!this.operations.acceptSnapshot(invocation, this.activeTargetId, active?.id ?? null)) {
        return;
      }
      this.setState("running", snapshot.running);
      this.setState(
        "tabs",
        this.native.mergeRemoteTabs(this.operations.retainTabSnapshot(client, snapshot.tabs)),
      );
      if (this.native.activeTab) {
        return;
      }
      // A mutation may adopt the same tab while this snapshot is pending.
      // Reconcile its tab strip, but never let it own document or loading state.
      if (!this.operations.canCaptureSnapshot(invocation)) {
        return;
      }
      if (!snapshot.running) {
        this.setState("view", null);
      }
      if (this.activeTargetId !== null && !selected) {
        this.invalidateViewOperations();
        invocation.epoch = this.operations.epoch;
        this.setState("view", null);
        this.exitCaptureModes();
      }
      this.setState("activeTargetId", active?.id ?? null);
      if (!this.urlDraftEditing) {
        this.setState("urlDraft", active?.url ?? "");
      }
      if (active) {
        await this.refreshView(active.id, invocation.epoch);
      } else {
        this.setState("view", null);
      }
    } catch (error) {
      if (invocation.isCurrent()) {
        this.reportError(error);
      }
    } finally {
      if (invocation.isCurrent() && !this.native.activeTab) {
        this.setState("loading", false);
      }
    }
  }

  async refreshView(targetId: string, epoch = this.operations.epoch): Promise<void> {
    await this.snapshot.capture(targetId, epoch);
  }

  async runAction(
    action: (client: BrowserRequestClient) => Promise<void>,
    refreshView = true,
  ): Promise<boolean> {
    const client = this.operations.captureClient();
    if (!client) {
      return false;
    }
    const epoch = this.operations.epoch;
    const current = () => this.operations.isLive(epoch, client);
    try {
      this.setState("errorText", null);
      await action(client);
      if (current() && refreshView) {
        this.pendingInput.scheduleRefresh(ACTION_REFRESH_DELAY_MS, () => {
          if (current() && this.activeTargetId) {
            void this.refreshView(this.activeTargetId, epoch);
          }
        });
      }
      return current();
    } catch (error) {
      if (!current()) {
        return false;
      }
      if (isBrowserEvaluateDisabledError(error)) {
        this.setState("evaluateUnavailable", true);
      }
      this.reportError(error);
      if (!this.operations.hasPendingCapture) {
        this.setState("loading", false);
      }
      return false;
    }
  }

  get observedViewportSize(): { width: number; height: number } | null {
    return this.viewport.observedViewportSize;
  }

  scheduleViewportSync(): void {
    this.viewport.schedule();
  }

  handleViewportResize(width: number, height: number): void {
    this.viewport.resize(width, height);
  }

  async startBrowserNow(): Promise<void> {
    if (!this.operations.captureClient()) {
      return;
    }
    const epoch = this.operations.epoch;
    this.setState("loading", true);
    await this.runAction(async (actionClient) => {
      await startBrowser(actionClient);
      if (this.operations.isLive(epoch, actionClient)) {
        await this.refreshAll();
      }
    }, false);
  }

  async openUrl(url: string, options: { newTab: boolean; native?: boolean }): Promise<void> {
    if (
      hasNativeBrowserBridge() &&
      (options.native || options.newTab || this.native.activeTab || !this.activeTargetId)
    ) {
      await this.native.open(url, options.newTab || !this.native.activeTab);
      return;
    }
    const client = this.operations.captureClient();
    if (!client) {
      return;
    }
    const invocation = this.operations.beginMutation(client);
    this.setState("loading", true);
    this.setState("errorText", null);
    this.setState("pendingNewTab", false);
    let previousNavigationQueued = false;
    try {
      if (options.newTab || !this.activeTargetId) {
        const tab = await openBrowserTab(client, url);
        if (!invocation.isCurrent()) {
          // An already-created stale tab still belongs in the surviving tab strip.
          await this.refreshTabsOnly(
            client,
            this.operations.survivingInvocation(invocation, client),
          );
          return;
        }
        const nextTargetId = tab?.id ?? this.activeTargetId;
        if (nextTargetId !== this.activeTargetId) {
          this.invalidateViewOperations();
          invocation.epoch = this.operations.epoch;
          this.setState("view", null);
          this.exitCaptureModes();
        }
        this.setState("activeTargetId", nextTargetId);
      } else {
        // Keep the stable alias as the active handle; navigate may swap the
        // raw target underneath and the alias migrates server-side.
        this.invalidateViewOperations();
        invocation.epoch = this.operations.epoch;
        this.exitCaptureModes();
        const targetId = this.activeTargetId;
        previousNavigationQueued =
          this.operations.hasQueuedNavigation(client, targetId) ||
          this.operations.hasUnreconciledNavigation(client, targetId);
        await this.operations.queueNavigation(client, targetId, async () => {
          if (invocation.isCurrent()) {
            await navigateBrowser(client, { url, targetId });
            this.operations.markNavigationCommitted(client, targetId);
          }
        });
        if (!invocation.isCurrent()) {
          return;
        }
        this.setState("view", null);
      }
      const refreshed = await this.refreshTabsOnly(client, () => invocation.isCurrent());
      if (refreshed !== "rejected" && invocation.isCurrent() && this.activeTargetId) {
        const targetId = this.activeTargetId;
        await this.refreshView(targetId, invocation.epoch);
        if (!options.newTab && invocation.isCurrent() && this.view?.targetId === targetId) {
          this.operations.markNavigationReconciled(client, targetId);
        }
      }
    } catch (error) {
      if (invocation.isCurrent()) {
        if (previousNavigationQueued && this.activeTargetId) {
          const targetId = this.activeTargetId;
          // An earlier queued navigation may already have committed remotely.
          // Recover its actual document without replacing an unchanged view.
          const refreshed = await this.refreshTabsOnly(client, () => invocation.isCurrent());
          const active = this.tabs.find((tab) => tab.id === targetId);
          if (refreshed === "accepted" && invocation.isCurrent() && active) {
            this.setState("view", null);
            await this.refreshView(targetId, invocation.epoch);
            if (invocation.isCurrent() && this.view?.targetId === targetId) {
              this.operations.markNavigationReconciled(client, targetId);
            }
          }
          if (
            invocation.isCurrent() &&
            this.operations.hasUnreconciledNavigation(client, targetId)
          ) {
            this.setState("activeTargetId", null);
            this.setState("view", null);
            if (!this.urlDraftEditing) {
              this.setState("urlDraft", "");
            }
          }
        }
        this.reportError(error);
      }
    } finally {
      if (invocation.isCurrent()) {
        this.setState("loading", false);
      }
    }
  }

  private async refreshTabsOnly(
    client: BrowserRequestClient,
    current: () => boolean,
  ): Promise<BrowserPanelSnapshotOutcome> {
    const invocation = this.operations.beginSnapshot(client);
    try {
      const snapshot = await listBrowserTabs(client);
      if (
        current() &&
        this.operations.acceptSnapshot(invocation, this.activeTargetId, this.activeTargetId)
      ) {
        this.setState("running", snapshot.running);
        this.setState(
          "tabs",
          this.native.mergeRemoteTabs(this.operations.retainTabSnapshot(client, snapshot.tabs)),
        );
        this.clearUnavailableView();
        return "accepted";
      }
      return "rejected";
    } catch {
      // Best-effort tab reconciliation must not let an older failure settle
      // loading or advance a document owned by a newer operation.
      return current() && invocation.isCurrent() ? "failed" : "rejected";
    }
  }

  async selectTab(targetId: string, route?: BrowserRoute): Promise<void> {
    this.native.cancelPendingActivation(targetId);
    const nativeTab = this.native.tabs.find((tab) => tab.id === targetId);
    if (nativeTab) {
      this.invalidateViewOperations();
      this.exitCaptureModes();
      this.setState("activeTargetId", targetId);
      this.setState("view", null);
      this.setState("urlDraft", nativeTab.url);
      this.setState("loading", this.native.activeTab?.loading ?? false);
      this.setState("errorText", null);
      this.native.presentation.renew();
      return;
    }
    if (route && browserRouteKey(this.operations.route) !== browserRouteKey(route)) {
      this.operations.resetRoute(route);
      this.resetBrowserState();
    } else if (targetId === this.activeTargetId && !route) {
      return;
    }
    const client = this.operations.captureClient();
    const previous = { targetId: this.activeTargetId, view: this.view };
    this.invalidateViewOperations();
    const epoch = this.operations.epoch;
    this.setState("activeTargetId", route ? null : targetId);
    this.setState("view", null);
    this.exitCaptureModes();
    if (!route && this.clearUnavailableView()) {
      return;
    }
    const focused = await this.runAction(async (actionClient) => {
      if (route) {
        // Listing can observe stopped or blocked tabs; focus needs a running,
        // accessible tab. A historical target cannot survive a browser restart.
        await this.refreshTabsOnly(actionClient, () => this.operations.isLive(epoch, actionClient));
        if (!this.operations.isLive(epoch, actionClient)) {
          return;
        }
        const selected = this.tabs.find((tab) => tab.id === targetId || tab.targetId === targetId);
        this.setState("activeTargetId", this.running === false ? null : (selected?.id ?? targetId));
        if (this.clearUnavailableView()) {
          return;
        }
      }
      const selectedTargetId = this.activeTargetId;
      if (!selectedTargetId) {
        return;
      }
      await focusBrowserTab(actionClient, selectedTargetId);
      if (!this.operations.isLive(epoch, actionClient)) {
        return;
      }
      await this.refreshView(selectedTargetId, epoch);
      if (
        this.operations.isLive(epoch, actionClient) &&
        this.activeTargetId === selectedTargetId &&
        this.view?.targetId === selectedTargetId
      ) {
        this.operations.markNavigationReconciled(actionClient, selectedTargetId);
      }
    }, false);
    if (!focused && this.operations.isLive(epoch) && this.activeTargetId === targetId) {
      if (this.operations.hasPendingNavigation(client, previous.targetId)) {
        // The prior remote document changed while selection failed. Expose an
        // unavailable state instead of restoring a screenshot that no longer owns it.
        this.setState("activeTargetId", null);
        if (!this.urlDraftEditing) {
          this.setState("urlDraft", "");
        }
        return;
      }
      this.setState("activeTargetId", previous.targetId);
      this.setState("view", previous.view?.dataUrl.startsWith("blob:") ? null : previous.view);
      if (previous.targetId && previous.view?.dataUrl.startsWith("blob:")) {
        await this.refreshView(previous.targetId);
      }
    }
  }

  async closeTab(targetId: string): Promise<void> {
    if (this.native.tabs.some((tab) => tab.id === targetId)) {
      await this.native.send({ type: "close", tabId: targetId });
      return;
    }
    await this.runAction(async (client) => {
      const epoch = this.operations.epoch;
      await closeBrowserTab(client, targetId);
      this.operations.forgetNavigation(client, targetId);
      if (!this.operations.isLive(epoch, client)) {
        if (this.operations.isLive(this.operations.epoch, client)) {
          await this.refreshAll();
        }
        return;
      }
      // DELETE already committed; a failed tab snapshot must not resurrect its
      // target or make the next screenshot address a tab that no longer exists.
      this.setState(
        "tabs",
        this.tabs.filter((tab) => tab.id !== targetId),
      );
      const snapshot = await this.refreshTabsOnly(client, () =>
        this.operations.isLive(epoch, client),
      );
      if (!this.operations.isLive(epoch, client)) {
        return;
      }
      if (this.activeTargetId !== targetId) {
        if (snapshot !== "rejected" && !this.operations.hasPendingCapture) {
          this.setState("loading", false);
        }
        return;
      }
      const next = this.tabs.find((tab) => !tab.urlUnavailableReason) ?? this.tabs[0] ?? null;
      if (next?.kind === "native") {
        await this.selectTab(next.id);
        return;
      }
      this.invalidateViewOperations();
      this.setState("activeTargetId", next?.id ?? null);
      this.setState("view", null);
      this.exitCaptureModes();
      if (next) {
        await this.refreshView(next.id);
      } else {
        this.setState("loading", false);
      }
    }, false);
    await this.host.updateComplete;
  }

  /** Real page reload: re-navigate to the current URL, then re-capture. A bare
   * screenshot refresh would leave the remote document untouched. */
  reloadPage(): void {
    if (this.native.activeTab) {
      this.exitCaptureModes();
      void this.native.send({
        type: this.native.activeTab.loading ? "stop" : "reload",
        tabId: this.native.activeTab.id,
      });
      return;
    }
    if (this.unavailableTabText) {
      void this.refreshAll();
      return;
    }
    const url = this.view?.metrics?.url || this.view?.url || this.urlDraft;
    const normalized = normalizeBrowserUrlDraft(url);
    if (!this.activeTargetId) {
      return;
    }
    if (!normalized) {
      void this.refreshView(this.activeTargetId);
      return;
    }
    void this.openUrl(normalized, { newTab: false });
  }

  goHistory(delta: -1 | 1): void {
    if (this.native.activeTab) {
      this.exitCaptureModes();
      void this.native.send({
        type: delta === -1 ? "back" : "forward",
        tabId: this.native.activeTab.id,
      });
      return;
    }
    const targetId = this.activeTargetId;
    if (!targetId || !this.view) {
      return;
    }
    void this.runAction((client) => goBrowserHistory(client, { targetId, delta }));
  }

  commitUrlDraft(): void {
    const url = normalizeBrowserUrlDraft(this.urlDraft);
    if (!url) {
      return;
    }
    void this.openUrl(url, { newTab: this.pendingNewTab || this.tabs.length === 0 });
  }

  beginNewTab(): void {
    if (hasNativeBrowserBridge()) {
      void this.native.beginNewTab();
      return;
    }
    this.setState("pendingNewTab", true);
    this.setState("urlDraft", "");
    const epoch = this.operations.epoch;
    void this.host.updateComplete.then(() => {
      if (this.operations.isLive(epoch)) {
        this.host.renderRoot.querySelector<HTMLInputElement>(".bp-url")?.focus();
      }
    });
  }

  setUrlDraft(value: string): void {
    this.setState("urlDraft", value);
  }

  setUrlDraftEditing(editing: boolean): void {
    this.urlDraftEditing = editing;
  }

  resetUrlDraftFromView(): void {
    this.setState(
      "urlDraft",
      this.native.activeTab?.url || this.view?.metrics?.url || this.view?.url || "",
    );
  }

  syncUrlDraft(url: string): void {
    if (!this.urlDraftEditing) {
      this.setState("urlDraft", url);
    }
  }

  openExternal(): void {
    const url =
      this.native.activeTab?.url || this.view?.metrics?.url || this.view?.url || this.urlDraft;
    if (url && !(this.native.activeTab && postNativeExternalLink(url))) {
      openExternalUrlSafe(url);
    }
  }

  exitCaptureModes(): void {
    this.native.cancelCapture();
    if (this.native.activeTab) {
      this.setState("view", null);
    }
    this.operations.invalidateInspection();
    this.input.resetCaptureState();
    this.setState("mode", "interact");
    this.setState("strokes", []);
    this.setState("inspected", null);
    this.setState("inspectPointer", null);
    this.stream.flushPendingFrame();
  }

  setMode(mode: BrowserPanelMode): void {
    if (this.mode === mode) {
      this.exitCaptureModes();
      return;
    }
    this.exitCaptureModes();
    if (this.native.activeTab && mode !== "interact") {
      void this.native.capture(mode);
      return;
    }
    this.setState("mode", mode);
    this.setState("noticeText", null);
    if (mode === "inspect" && this.evaluateUnavailable) {
      this.setState("errorText", t("browser.inspectUnavailable"));
      this.setState("mode", "interact");
    }
  }

  inspectHighlightRegion() {
    return this.input.inspectHighlightRegion();
  }

  handleStageClick(event: MouseEvent): void {
    if (!this.native.activeTab) {
      this.input.handleStageClick(event);
    }
  }

  handleWheel(event: WheelEvent): void {
    if (!this.native.activeTab) {
      this.input.handleWheel(event);
    }
  }

  handleViewportKeydown(event: KeyboardEvent): void {
    if (!this.native.activeTab) {
      this.input.handleViewportKeydown(event);
    }
  }

  handleOverlayPointerDown(event: PointerEvent): void {
    this.input.handleOverlayPointerDown(event);
  }

  handleOverlayPointerMove(event: PointerEvent): void {
    if (this.native.activeTab && this.mode === "inspect") {
      this.native.inspect(event);
    } else {
      this.input.handleOverlayPointerMove(event);
    }
  }

  handleOverlayPointerUp(event: PointerEvent): void {
    this.input.handleOverlayPointerUp(event);
  }

  cancelOverlayPointerGesture(): void {
    this.input.cancelOverlayPointerGesture();
  }

  undoStroke(): void {
    this.input.undoStroke();
  }

  clearStrokes(): void {
    this.input.clearStrokes();
  }

  async sendAnnotation(params: { element?: BrowserInspectedNode | null }): Promise<void> {
    await this.input.sendAnnotation(params);
  }

  paintOverlay(): void {
    this.input.paintOverlay();
  }
}
