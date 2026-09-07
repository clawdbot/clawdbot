import {
  postNativeBrowserMessage,
  type NativeBrowserTab,
} from "../../app/native-browser-bridge.ts";
import { subscribeNativeOverlayOcclusion } from "../../lib/native-overlay-occlusion.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type { BrowserPanelControllerHost } from "./browser-panel-operation-ownership.ts";

interface BrowserPanelNativePresentationHost {
  readonly host: Pick<
    BrowserPanelControllerHost,
    "isConnected" | "browserPanelIsOpen" | "renderRoot"
  >;
  readonly native: { readonly activeTab: NativeBrowserTab | undefined };
  readonly activeTargetId: string | null;
  readonly mode: "interact" | "annotate" | "inspect";
  reportError(error: unknown): void;
}

let presentationOrder = 0;

/** The web panel owns geometry and occlusion; native owns the actual views. */
export class BrowserPanelNativePresentation {
  // Every panel builds one of these, including on insecure HTTP origins where
  // crypto.randomUUID is undefined; the helper falls back to getRandomValues.
  readonly scope = generateUUID();
  presentedTabId: string | null = null;
  lastPresented = 0;
  private stage: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private unsubscribeOcclusion?: () => void;
  private intersecting = true;
  private occluded = false;
  private frame: number | null = null;
  private lastPayload = "";
  private connected = false;

  constructor(private readonly controller: BrowserPanelNativePresentationHost) {}

  connect(): void {
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.unsubscribeOcclusion = subscribeNativeOverlayOcclusion((occluded) => {
      this.occluded = occluded;
      if (occluded) {
        this.hide();
      }
      this.schedule();
    });
    document.addEventListener("scroll", this.schedule, true);
    window.addEventListener("resize", this.schedule);
    this.update();
  }

  disconnect(): void {
    this.hide();
    this.connected = false;
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.stage = null;
    this.unsubscribeOcclusion?.();
    this.unsubscribeOcclusion = undefined;
    document.removeEventListener("scroll", this.schedule, true);
    window.removeEventListener("resize", this.schedule);
    this.lastPayload = "";
    void postNativeBrowserMessage({ type: "release-scope", scope: this.scope });
  }

  update(): void {
    if (!this.connected) {
      return;
    }
    const stage = this.controller.host.renderRoot.querySelector<HTMLElement>(".bp-stage");
    if (stage !== this.stage) {
      this.resizeObserver?.disconnect();
      this.intersectionObserver?.disconnect();
      this.stage = stage;
      this.intersecting = true;
      if (stage) {
        if (typeof ResizeObserver === "function") {
          this.resizeObserver ??= new ResizeObserver(this.schedule);
          this.resizeObserver.observe(stage);
        }
        if (typeof IntersectionObserver === "function") {
          this.intersectionObserver ??= new IntersectionObserver((entries) => {
            const entry = entries.find((candidate) => candidate.target === this.stage);
            if (entry) {
              this.intersecting = entry.isIntersecting;
              this.schedule();
            }
          });
          this.intersectionObserver.observe(stage);
        }
      }
    }
    if (!this.canPresent()) {
      this.hide();
    }
    this.schedule();
  }

  readonly schedule = (): void => {
    if (!this.connected || this.frame !== null) {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.report();
    });
  };

  renew(): void {
    // Explicit selection reclaims a tab that another panel scope may now own.
    this.lastPayload = "";
    this.schedule();
  }

  hide(): void {
    if (this.connected) {
      this.send(null, null);
    }
  }

  private canPresent(): boolean {
    return Boolean(
      this.connected &&
      this.controller.host.isConnected &&
      this.controller.host.browserPanelIsOpen() &&
      this.controller.native.activeTab &&
      this.controller.mode === "interact" &&
      !this.occluded &&
      this.intersecting,
    );
  }

  private report(): void {
    const stage = this.stage;
    if (!stage || !this.canPresent()) {
      this.hide();
      return;
    }
    const rect = stage.getBoundingClientRect();
    const root = this.controller.host.renderRoot;
    const host = root instanceof ShadowRoot ? root.host : root;
    let hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    // document hit-testing stops at shadow hosts. Descend to distinguish this
    // panel from a dialog or another panel within the same application root.
    while (hit?.shadowRoot && typeof hit.shadowRoot.elementFromPoint === "function") {
      const inner = hit.shadowRoot.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      if (!inner || inner === hit) {
        break;
      }
      hit = inner;
    }
    let ancestor: Node | null = hit;
    while (ancestor && ancestor !== host) {
      ancestor = ancestor instanceof ShadowRoot ? ancestor.host : ancestor.parentNode;
    }
    if (!ancestor || rect.width <= 0 || rect.height <= 0) {
      this.hide();
      return;
    }
    this.send(this.controller.activeTargetId, {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }

  private send(
    tabId: string | null,
    rect: { x: number; y: number; width: number; height: number } | null,
  ): void {
    const payload = {
      type: "present" as const,
      scope: this.scope,
      tabId,
      rect,
      visible: Boolean(tabId),
    };
    const serialized = JSON.stringify(payload);
    if (serialized === this.lastPayload) {
      return;
    }
    this.lastPayload = serialized;
    this.presentedTabId = tabId;
    if (tabId) {
      // Native resolves duplicate presentations of one tab in favor of the
      // most recent scope; this order also selects a popup's web presenter.
      this.lastPresented = ++presentationOrder;
    }
    void postNativeBrowserMessage(payload).then((reply) => {
      if (reply && !reply.ok && this.connected) {
        this.controller.reportError(reply.error);
      }
    });
  }
}
