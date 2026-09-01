/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventListener } from "../../api/gateway.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./desktop-panel.ts";

type DesktopPanelElement = HTMLElement & {
  available: boolean;
  documentMode: boolean;
  client: GatewayBrowserClient | null;
  desktopClientFactory: () => {
    connect(options: { onConnect: () => void }): Promise<{ disconnect(): void }>;
  };
  embedded: boolean;
  handleToggleRequest(event: Event): void;
  presented: boolean;
  requestedSource: string | null;
  sessionKey: string | null;
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

  it("follows the session desktop and retires its connection before resolving a new placement", async () => {
    const replacement = { ...desktopEnvironment, id: "worker-desktop-2" };
    let refresh: Promise<void> | undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "environments.list") {
        await refresh;
        return { environments: [desktopEnvironment, replacement] };
      }
      return {
        transport: "rfb",
        wsPath: "/desktop/observe?token=session",
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
    panel.sessionKey = "agent:main:cloud";
    panel.requestedSource = desktopEnvironment.id;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);

    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("desktop.observe", {
      source: { kind: "environment", environmentId: desktopEnvironment.id },
      control: false,
    });

    const nextInventory = createDeferred();
    refresh = nextInventory.promise;
    panel.requestedSource = replacement.id;
    await panel.updateComplete;
    expect(disconnect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    nextInventory.resolve();
    refresh = undefined;
    await waitForFast(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenLastCalledWith("desktop.observe", {
      source: { kind: "environment", environmentId: replacement.id },
      control: false,
    });

    panel.requestedSource = null;
    await panel.updateComplete;
    await settleTasks();
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.some(([method]) => method === "sessions.describe")).toBe(false);
  });

  it("keeps focused session updates current across control changes and overlapping lookups", async () => {
    const sessionKey = "agent:main:focused";
    const active = {
      key: sessionKey,
      kind: "direct",
      placement: { state: "active", environmentId: desktopEnvironment.id },
    };
    const reclaimed = { ...active, placement: { state: "reclaimed" } };
    let sessionRead: Promise<unknown> | undefined;
    let listener: GatewayEventListener = () => {
      throw new Error("expected a focused session listener");
    };
    const unsubscribe = vi.fn();
    const request = vi.fn(async (method: string, params?: { control?: boolean }) => {
      if (method === "environments.list") {
        return { environments: [desktopEnvironment] };
      }
      if (method === "sessions.describe") {
        return sessionRead ?? { session: active };
      }
      return {
        transport: "rfb",
        wsPath: "/desktop/observe?token=focused",
        expiresAtMs: 60_000,
        control: params?.control ?? false,
      };
    });
    const disconnect = vi.fn();
    const connect = vi.fn(async (options: { onConnect: () => void }) => {
      options.onConnect();
      return { disconnect };
    });
    const panel = createPanel();
    panel.client = {
      gatewayUrl: "ws://gateway.test",
      request,
      addEventListener: (next: GatewayEventListener) => {
        listener = next;
        return unsubscribe;
      },
    } as unknown as GatewayBrowserClient;
    panel.available = true;
    panel.documentMode = true;
    panel.sessionKey = sessionKey;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);
    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    const descriptions = () =>
      request.mock.calls.filter(([method]) => method === "sessions.describe");
    const changed = (key = sessionKey) =>
      listener({ type: "event", event: "sessions.changed", payload: { sessionKey: key } });

    changed("agent:main:unrelated");
    await settleTasks();
    expect(descriptions()).toHaveLength(1);
    changed();
    await waitForFast(() => expect(descriptions()).toHaveLength(2));
    await settleTasks();
    expect(disconnect).not.toHaveBeenCalled();

    const pending = createDeferred<unknown>();
    sessionRead = pending.promise;
    changed();
    await waitForFast(() => expect(descriptions()).toHaveLength(3));
    const control = panel.renderRoot.querySelector<HTMLButtonElement>(
      'button[aria-label="Take control"]',
    );
    if (!control) {
      throw new Error("expected focused Desktop control button");
    }
    control.click();
    await waitForFast(() => expect(connect).toHaveBeenCalledTimes(2));
    pending.resolve({ session: reclaimed });
    await waitForFast(() =>
      expect(panel.renderRoot.querySelector(".desktop-picker")).not.toBeNull(),
    );
    expect(disconnect).toHaveBeenCalledTimes(2);

    sessionRead = undefined;
    changed();
    await waitForFast(() => expect(connect).toHaveBeenCalledTimes(3));
    const stale = createDeferred<unknown>();
    sessionRead = stale.promise;
    changed();
    await waitForFast(() => expect(descriptions()).toHaveLength(5));
    sessionRead = Promise.resolve({ session: reclaimed });
    changed();
    await waitForFast(() =>
      expect(panel.renderRoot.querySelector(".desktop-picker")).not.toBeNull(),
    );
    stale.resolve({ session: active });
    await settleTasks();
    expect(connect).toHaveBeenCalledTimes(3);
    panel.remove();
    expect(unsubscribe).toHaveBeenCalledOnce();
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
