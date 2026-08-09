import type { ReactiveController } from "lit";
import { afterEach, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { BrowserInspectedNode } from "./browser-client.ts";
import {
  BrowserPanelController,
  type BrowserPanelControllerHost,
} from "./browser-panel-controller.ts";
import type { BrowserPanelView } from "./browser-panel-surface.ts";

const BROWSER_PANEL_TEST_PAGE_TITLE = "Page";

export type BrowserRequestEnvelope = {
  method: string;
  path: string;
  body?: Record<string, unknown>;
};

export function setupBrowserPanelTestCleanup(): void {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}

export function createBrowserClient(
  handleRequest: (envelope: BrowserRequestEnvelope) => Promise<unknown>,
) {
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method !== "browser.request") {
      throw new Error(`Unexpected Gateway method: ${method}`);
    }
    return await handleRequest(params as BrowserRequestEnvelope);
  });
  return { client: { request } as unknown as GatewayBrowserClient, request };
}

export function createBrowserPanelTestTab(id: string, url: string, title: string) {
  return {
    tabId: id,
    targetId: `raw-${id.replace(/-tab$/, "")}`,
    title,
    url,
  };
}

export function createBrowserPanelTestMetrics(url: string, title = BROWSER_PANEL_TEST_PAGE_TITLE) {
  return { result: { cssWidth: 100, cssHeight: 100, title, url } };
}

export class TestBrowserPanelHost implements BrowserPanelControllerHost {
  readonly controllers: ReactiveController[] = [];
  readonly requestUpdate = vi.fn();
  readonly updateComplete = Promise.resolve(true);
  readonly renderRoot = document.createElement("div");
  readonly basePath = "";
  readonly authToken = null;
  available = true;
  isConnected = true;
  open = true;

  constructor(public client: GatewayBrowserClient | null) {
    const stage = document.createElement("div");
    stage.className = "bp-stage";
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      toJSON: () => ({}),
    });
    this.renderRoot.append(stage);
  }

  addController(controller: ReactiveController): void {
    this.controllers.push(controller);
  }

  removeController(controller: ReactiveController): void {
    const index = this.controllers.indexOf(controller);
    if (index >= 0) {
      this.controllers.splice(index, 1);
    }
  }

  browserPanelIsOpen(): boolean {
    return this.open;
  }
}

export function createView(targetId: string, url = "https://example.test/page"): BrowserPanelView {
  return {
    targetId,
    dataUrl: "data:image/png;base64,c2NyZWVuc2hvdA==",
    image: { naturalWidth: 100, naturalHeight: 100 } as HTMLImageElement,
    url,
    metrics: { cssWidth: 100, cssHeight: 100, title: BROWSER_PANEL_TEST_PAGE_TITLE, url },
  };
}

export function createBrowserPanelTestController(
  client: GatewayBrowserClient,
  targetId: string,
  url?: string,
): BrowserPanelController {
  const controller = new BrowserPanelController(new TestBrowserPanelHost(client));
  controller.activeTargetId = targetId;
  controller.view = createView(targetId, url);
  return controller;
}

export function createInspectedNode(name: string): BrowserInspectedNode {
  return {
    tag: "button",
    id: name,
    classes: [],
    role: "button",
    name,
    rect: { x: 10, y: 20, width: 30, height: 40 },
    focusable: true,
  };
}

export function createPointer(x: number, y: number): PointerEvent {
  return new MouseEvent("pointermove", { clientX: x, clientY: y }) as PointerEvent;
}

export async function flushBrowserResponses(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

class TestBrowserImage extends EventTarget {
  naturalWidth = 100;
  naturalHeight = 100;
  private imageSource = "";

  set src(value: string) {
    this.imageSource = value;
    queueMicrotask(() => this.dispatchEvent(new Event("load")));
  }

  get src(): string {
    return this.imageSource;
  }
}

export function stubScreenshotMedia(): void {
  vi.stubGlobal("Image", TestBrowserImage);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const text = url.includes("fresh") ? "fresh screenshot" : "old screenshot";
      return {
        ok: true,
        blob: async () => new Blob([text], { type: "image/png" }),
      } as Response;
    }),
  );
}
