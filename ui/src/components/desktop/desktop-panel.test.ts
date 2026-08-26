/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./desktop-panel.ts";

type DesktopPanelElement = HTMLElement & {
  available: boolean;
  client: GatewayBrowserClient | null;
  desktopClientFactory: () => {
    connect(options: { onConnect: () => void }): Promise<{ disconnect(): void }>;
  };
  embedded: boolean;
  handleToggleRequest(event: Event): void;
  presented: boolean;
  renderRoot: DocumentFragment;
  updateComplete: Promise<unknown>;
};

const desktopEnvironment = {
  id: "worker-desktop-1",
  type: "worker",
  status: "available",
  desktop: true,
  worker: {
    providerId: "crabbox",
    state: "attached",
    ageMs: 1_000,
    attachedSessionIds: ["main"],
    tunnelStatus: "connected",
    desktopApps: [],
  },
} as const;

function createPanel() {
  return document.createElement("openclaw-desktop-panel") as unknown as DesktopPanelElement;
}

function clickConnect(panel: DesktopPanelElement): void {
  const button = panel.renderRoot.querySelector<HTMLButtonElement>(".desktop-environment button");
  if (!button) {
    throw new Error("expected Desktop picker connect button");
  }
  button.click();
}

async function settleTasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
  await Promise.resolve();
}

describe("embedded desktop panel presentation", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("keeps a hidden embedded mount dormant even when the standalone dock was open", async () => {
    localStorage.setItem(
      "openclaw.desktopPanel",
      JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
    );
    const request = vi.fn(async () => ({ environments: [desktopEnvironment] }));
    const panel = createPanel();
    panel.client = { gatewayUrl: "ws://gateway.test", request } as unknown as GatewayBrowserClient;
    panel.available = true;
    panel.embedded = true;
    panel.presented = false;
    document.body.append(panel);
    await panel.updateComplete;
    await settleTasks();

    panel.handleToggleRequest(
      new CustomEvent("openclaw:desktop-toggle", {
        detail: { environmentId: desktopEnvironment.id },
      }),
    );
    await settleTasks();

    expect(request).not.toHaveBeenCalled();
    expect(panel.isConnected).toBe(true);
  });

  it("disconnects a hidden retained connection and reactivates at the picker", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "environments.list") {
        return { environments: [desktopEnvironment] };
      }
      return {
        transport: "rfb",
        wsPath: "/desktop/observe?token=unit",
        expiresAtMs: 60_000,
        control: false,
      };
    });
    const disconnect = vi.fn();
    const connect = vi.fn(async (options: { onConnect: () => void }) => {
      options.onConnect();
      return { disconnect };
    });
    const panel = createPanel();
    panel.client = { gatewayUrl: "ws://gateway.test", request } as unknown as GatewayBrowserClient;
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);

    await waitForFast(() => {
      expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(
        1,
      );
    });
    clickConnect(panel);
    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());

    panel.presented = false;
    await panel.updateComplete;

    expect(disconnect).toHaveBeenCalledOnce();
    expect(panel.isConnected).toBe(true);

    panel.presented = true;
    await waitForFast(() => {
      expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(
        2,
      );
    });

    expect(request.mock.calls.filter(([method]) => method === "desktop.observe")).toHaveLength(1);
    expect(connect).toHaveBeenCalledOnce();
    expect(panel.renderRoot.querySelector(".desktop-picker")).not.toBeNull();
  });

  it("invalidates a pending observe before it can connect", async () => {
    let resolveObserve: (value: unknown) => void = (_value) => {
      throw new Error("observe request was not started");
    };
    const observe = new Promise<unknown>((resolve) => {
      resolveObserve = resolve;
    });
    const request = vi.fn((method: string) => {
      if (method === "environments.list") {
        return Promise.resolve({ environments: [desktopEnvironment] });
      }
      return observe;
    });
    const connect = vi.fn(async () => ({ disconnect: vi.fn() }));
    const panel = createPanel();
    panel.client = { gatewayUrl: "ws://gateway.test", request } as unknown as GatewayBrowserClient;
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);

    await waitForFast(() => {
      expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(
        1,
      );
    });
    clickConnect(panel);
    await waitForFast(() => {
      expect(request.mock.calls.filter(([method]) => method === "desktop.observe")).toHaveLength(1);
    });

    panel.presented = false;
    await panel.updateComplete;
    resolveObserve({
      transport: "rfb",
      wsPath: "/desktop/observe?token=stale",
      expiresAtMs: 60_000,
      control: false,
    });
    await settleTasks();

    expect(connect).not.toHaveBeenCalled();
    expect(panel.isConnected).toBe(true);
  });
});
