/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { PresenceEntry } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import {
  createInitialDevicesState,
  loadNodes,
  type InventoryRemovalRequest,
} from "../../lib/nodes/index.ts";
import {
  installDialogPolyfill,
  waitForRenderedModalDialog,
} from "../../test-helpers/modal-dialog.ts";
import type { DevicesRouteData } from "./devices-page.ts";
import "./devices-page.ts";

type TestDevicesPage = HTMLElement & {
  context: ApplicationContext;
  pageState: ReturnType<typeof createInitialDevicesState>;
  requestGeneration: number;
  presence: PresenceEntry[];
  routeData?: DevicesRouteData;
  subscriptions: {
    hostConnected: () => void;
    hostUpdate: () => void;
    hostDisconnected: () => void;
  };
  disconnectedCallback: () => void;
  willUpdate: (changed: Map<PropertyKey, unknown>) => void;
  gateway: {
    applySnapshot: (
      snapshot: ApplicationGatewaySnapshot,
      binding: { initial: boolean; sourceChanged: boolean },
    ) => void;
  };
  ensureInitialData: () => void;
  confirmInventoryRemoval: (prompt: {
    kind: "entry";
    entry: InventoryRemovalRequest;
  }) => Promise<void>;
  confirmPairingReject: (target: "device" | "node", requestId: string) => Promise<void>;
  confirmTokenRevoke: (deviceId: string, role: string) => Promise<void>;
  reportRotationOutcome: (
    device: { id: string; name: string },
    role: string,
    scopes?: string[],
  ) => Promise<void>;
};

const ROTATED_TOKEN = "rotated-operator-token";

/** Keep the identity fingerprint off jsdom's absent SubtleCrypto. */
function stubLocalDeviceIdentity() {
  localStorage.setItem(
    "openclaw-device-identity-v1",
    JSON.stringify({ version: 1, deviceId: "00", publicKey: "AA", privateKey: "AA" }),
  );
  vi.stubGlobal("crypto", {
    subtle: { digest: async () => new Uint8Array([0]).buffer },
  });
}

function rotatingClient(token: string | null): GatewayBrowserClient {
  // Answer for the grant that was actually requested, the way the Gateway does: the page now
  // refuses a result naming a different device or role, so a hardcoded id would report a
  // rotation of some other device as this one's.
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method !== "device.token.rotate") {
      return { paired: [], pending: [] };
    }
    const { deviceId, role } = params as { deviceId: string; role: string };
    return {
      deviceId,
      role,
      scopes: [],
      rotatedAtMs: 1_700_000_000_000,
      ...(token ? { token } : {}),
      tokenDelivery: token ? "in-band" : "withheld-cross-device",
    };
  });
  return { request } as unknown as GatewayBrowserClient;
}

function secretDialogText(): string {
  return document.body.querySelector(".secret-reveal__code")?.textContent?.trim() ?? "";
}

function findDialogButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${label} button`);
  }
  return button;
}

function clickDialogButton(label: string) {
  findDialogButton(label).click();
}

function createConnectedPage(client: GatewayBrowserClient) {
  const page = document.createElement("openclaw-devices-page") as TestDevicesPage;
  page.context = {
    gateway: { connection: { gatewayUrl: "http://gateway.test" } },
    runtimeConfig: { state: { configSnapshot: null, configLoading: false } },
  } as unknown as ApplicationContext;
  applyGatewaySnapshot(page, gatewaySnapshot(client, true));
  return page;
}

function applyGatewaySnapshot(
  page: TestDevicesPage,
  snapshot: ApplicationGatewaySnapshot,
  sourceChanged = false,
) {
  page.gateway.applySnapshot(snapshot, { initial: false, sourceChanged });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function gatewaySnapshot(
  client: GatewayBrowserClient | null,
  connected: boolean,
): ApplicationGatewaySnapshot {
  return {
    client,
    phase: connected ? "connected" : "reconnecting",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
}

function gateway(client: GatewayBrowserClient | null): ApplicationContext["gateway"] {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  return {
    snapshot,
    subscribe: vi.fn(() => () => undefined),
    subscribeEvents: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["gateway"];
}

describe("DevicesPage gateway lifecycle", () => {
  let restoreDialogPolyfill: () => void;

  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("preserves matching initial route data, then resets it on provider replacement", () => {
    const client = null;
    const currentGateway = gateway(client);
    const preloadedNodes = [{ id: "preloaded" }];
    const page = document.createElement("openclaw-devices-page") as TestDevicesPage;
    page.routeData = {
      gateway: currentGateway,
      gatewaySnapshot: currentGateway.snapshot,
      devices: {
        ...createInitialDevicesState({
          client: currentGateway.snapshot.client,
          connected: currentGateway.snapshot.phase === "connected",
        }),
        nodes: preloadedNodes,
      },
    };
    page.context = { gateway: currentGateway } as unknown as ApplicationContext;
    page.willUpdate(new Map([["routeData", undefined]]));

    page.subscriptions.hostConnected();
    expect(page.pageState.client).toBeNull();
    expect(page.pageState.nodes).toBe(preloadedNodes);

    page.context = { gateway: gateway(client) } as unknown as ApplicationContext;
    page.presence = [{ instanceId: "stale", ts: 1_000 }];
    applyGatewaySnapshot(page, page.context.gateway.snapshot, true);
    expect(page.pageState.nodes).toEqual([]);
    expect(page.presence).toEqual([]);
    expect(page.requestGeneration).toBeGreaterThan(0);

    page.subscriptions.hostDisconnected();
  });

  it("rejects preloaded data after a same-client gateway epoch change", () => {
    const client = {} as GatewayBrowserClient;
    const currentGateway = gateway(client);
    const preloadedNodes = [{ id: "stale" }];
    const page = document.createElement("openclaw-devices-page") as TestDevicesPage;
    page.ensureInitialData = vi.fn();
    page.routeData = {
      gateway: currentGateway,
      gatewaySnapshot: gatewaySnapshot(client, false),
      devices: {
        ...createInitialDevicesState({ client, connected: true }),
        nodes: preloadedNodes,
      },
    };
    page.context = { gateway: currentGateway } as unknown as ApplicationContext;

    page.willUpdate(new Map([["routeData", undefined]]));

    expect(page.pageState.nodes).toEqual([]);
    expect(page.ensureInitialData).toHaveBeenCalledOnce();
  });

  it("reloads node status when runner inventory changes", async () => {
    const request = vi.fn(async (method: string) =>
      method === "node.list" ? { nodes: [] } : { paired: [], pending: [] },
    );
    const client = { request } as unknown as GatewayBrowserClient;
    let onEvent: ((event: { event: string; payload?: unknown }) => void) | undefined;
    const currentGateway = gateway(client);
    currentGateway.snapshot = gatewaySnapshot(client, true);
    currentGateway.subscribeEvents = vi.fn((listener) => {
      onEvent = listener as typeof onEvent;
      return () => undefined;
    });
    const page = document.createElement("openclaw-devices-page") as TestDevicesPage;
    page.context = {
      gateway: currentGateway,
      runtimeConfig: {
        state: { configSnapshot: {}, configLoading: false },
        subscribe: vi.fn(() => () => undefined),
      },
    } as unknown as ApplicationContext;
    document.body.append(page);
    await vi.waitFor(() => expect(onEvent).toBeDefined());

    onEvent?.({ event: "node.runnerInventory.changed", payload: { nodeId: "node-1" } });

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("node.list", {}));
    page.remove();
  });

  it("retries a node load after a same-client disconnect", async () => {
    const first = deferred<{ nodes: Array<Record<string, unknown>> }>();
    const second = deferred<{ nodes: Array<Record<string, unknown>> }>();
    const request = vi
      .fn<(method: string, params?: unknown) => Promise<unknown>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-devices-page") as TestDevicesPage;
    page.pageState = createInitialDevicesState({ client, connected: true });
    page.context = {
      runtimeConfig: { state: { configSnapshot: null, configLoading: false } },
    } as unknown as ApplicationContext;

    const staleLoad = loadNodes(page.pageState);
    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
    applyGatewaySnapshot(page, gatewaySnapshot(client, true));
    const currentLoad = loadNodes(page.pageState);

    first.resolve({ nodes: [{ id: "old" }] });
    await staleLoad;
    expect(page.pageState.nodes).toEqual([]);
    expect(page.pageState.nodesLoading).toBe(true);

    second.resolve({ nodes: [{ id: "new" }] });
    await currentLoad;
    expect(page.pageState.nodes).toEqual([{ id: "new" }]);
    expect(page.pageState.nodesLoading).toBe(false);

    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
  });

  it("retires an in-flight load when its gateway provider changes without a client change", async () => {
    const first = deferred<{ nodes: Array<Record<string, unknown>> }>();
    const second = deferred<{ nodes: Array<Record<string, unknown>> }>();
    const request = vi
      .fn<(method: string, params?: unknown) => Promise<unknown>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const snapshot = gatewaySnapshot(client, true);
    const page = document.createElement("openclaw-devices-page") as TestDevicesPage;
    page.context = {
      runtimeConfig: { state: { configSnapshot: null, configLoading: false } },
    } as unknown as ApplicationContext;
    applyGatewaySnapshot(page, snapshot);

    const staleLoad = loadNodes(page.pageState);
    const previousGeneration = page.requestGeneration;
    applyGatewaySnapshot(page, snapshot, true);
    const currentLoad = loadNodes(page.pageState);

    expect(page.requestGeneration).toBeGreaterThan(previousGeneration);
    first.resolve({ nodes: [{ id: "old" }] });
    await staleLoad;
    expect(page.pageState.nodes).toEqual([]);
    expect(page.pageState.nodesLoading).toBe(true);

    second.resolve({ nodes: [{ id: "new" }] });
    await currentLoad;
    expect(page.pageState.nodes).toEqual([{ id: "new" }]);
    expect(page.pageState.nodesLoading).toBe(false);

    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
  });

  it("restores request ownership when a disconnected page reconnects", async () => {
    const first = deferred<{ nodes: Array<Record<string, unknown>> }>();
    const second = deferred<{ nodes: Array<Record<string, unknown>> }>();
    const request = vi
      .fn<(method: string, params?: unknown) => Promise<unknown>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const snapshot = gatewaySnapshot(client, true);
    const page = document.createElement("openclaw-devices-page") as TestDevicesPage;
    page.context = {
      runtimeConfig: { state: { configSnapshot: null, configLoading: false } },
    } as unknown as ApplicationContext;
    applyGatewaySnapshot(page, snapshot);

    const staleLoad = loadNodes(page.pageState);
    page.disconnectedCallback();
    applyGatewaySnapshot(page, snapshot, true);
    const currentLoad = loadNodes(page.pageState);

    first.resolve({ nodes: [{ id: "old" }] });
    await staleLoad;
    expect(page.pageState.nodes).toEqual([]);
    expect(page.pageState.nodesLoading).toBe(true);

    second.resolve({ nodes: [{ id: "new" }] });
    await currentLoad;
    expect(page.pageState.nodes).toEqual([{ id: "new" }]);

    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
  });

  it("cancels a pending removal confirmation when the connection resets", async () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const page = createConnectedPage(client);

    const pending = page.confirmInventoryRemoval({
      kind: "entry",
      entry: { id: "device-1", name: "Browser", removeNode: false, removeDevice: true },
    });
    await waitForRenderedModalDialog(document.body);

    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
    await pending;

    expect(request).not.toHaveBeenCalled();
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("rejects a device pairing request after the in-app dialog is confirmed", async () => {
    const request = vi.fn().mockResolvedValue({});
    const client = { request } as unknown as GatewayBrowserClient;
    const page = createConnectedPage(client);

    const pending = page.confirmPairingReject("device", "request-1");
    const { dialog } = await waitForRenderedModalDialog(document.body);
    expect(dialog.getAttribute("aria-label")).toBe(t("devices.inventory.rejectDevicePromptTitle"));

    clickDialogButton(t("devices.inventory.reject"));
    await pending;

    expect(request).toHaveBeenCalledWith("device.pair.reject", { requestId: "request-1" });
    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
  });

  it("issues no node pairing request when the dialog is cancelled", async () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const page = createConnectedPage(client);

    const pending = page.confirmPairingReject("node", "request-2");
    await waitForRenderedModalDialog(document.body);

    clickDialogButton(t("common.cancel"));
    await pending;

    expect(request).not.toHaveBeenCalled();
    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
  });

  it("drops a confirmed token revoke when the request generation moved on", async () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const page = createConnectedPage(client);

    const pending = page.confirmTokenRevoke("device-1", "operator");
    const { dialog } = await waitForRenderedModalDialog(document.body);
    expect(dialog.getAttribute("aria-label")).toBe(
      t("devices.inventory.revokePromptTitle", { role: "operator" }),
    );
    // The awaited dialog is a real suspension point: a generation bump during it means the
    // captured scope no longer owns the connection, so the revoke must not reach the server.
    page.pageState.requestGeneration += 1;

    clickDialogButton(t("devices.inventory.revoke"));
    await pending;

    expect(request).not.toHaveBeenCalled();
    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
  });

  it("reveals a rotated token with a copy control until it is acknowledged", async () => {
    stubLocalDeviceIdentity();
    const client = rotatingClient(ROTATED_TOKEN);
    const page = createConnectedPage(client);

    let acknowledged = false;
    const pending = page
      .reportRotationOutcome({ id: "device-1", name: "MacBook Pro" }, "operator")
      .then(() => {
        acknowledged = true;
      });
    const { dialog } = await waitForRenderedModalDialog(document.body);

    expect(dialog.getAttribute("aria-label")).toBe(
      t("devices.inventory.rotatePromptTitle", { role: "operator" }),
    );
    expect(secretDialogText()).toBe(ROTATED_TOKEN);
    expect(document.body.querySelector(".chat-copy-btn")).toBeInstanceOf(HTMLButtonElement);
    expect(acknowledged).toBe(false);

    clickDialogButton(t("devices.inventory.rotateAcknowledge"));
    await pending;

    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
  });

  it("refuses dismissal gestures while the rotated token is still on screen", async () => {
    stubLocalDeviceIdentity();
    const client = rotatingClient(ROTATED_TOKEN);
    const page = createConnectedPage(client);

    let acknowledged = false;
    const pending = page
      .reportRotationOutcome({ id: "device-1", name: "MacBook Pro" }, "operator")
      .then(() => {
        acknowledged = true;
      });
    const { modal, webAwesomeDialog } = await waitForRenderedModalDialog(document.body);

    // Escape and backdrop clicks both reach the dialog as a cancelable wa-hide, which
    // Web Awesome abandons when the listener cancels it; the secret stays on screen.
    const dismissal = new Event("wa-hide", { bubbles: true, cancelable: true, composed: true });
    webAwesomeDialog.dispatchEvent(dismissal);
    await modal.updateComplete;

    expect(dismissal.defaultPrevented).toBe(true);
    expect(acknowledged).toBe(false);
    expect(secretDialogText()).toBe(ROTATED_TOKEN);
    expect(document.body.textContent).toContain(t("devices.inventory.rotateDismissHint"));

    clickDialogButton(t("devices.inventory.rotateAcknowledge"));
    await pending;
    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
  });

  it("reveals a rotated token that lands after the request generation moved on", async () => {
    stubLocalDeviceIdentity();
    const rotated = deferred<Record<string, unknown>>();
    const request = vi.fn(async (method: string) =>
      method === "device.token.rotate" ? rotated.promise : { paired: [], pending: [] },
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const page = createConnectedPage(client);

    const pending = page.reportRotationOutcome({ id: "device-1", name: "MacBook Pro" }, "operator");
    page.pageState.requestGeneration += 1;
    rotated.resolve({
      deviceId: "device-1",
      role: "operator",
      scopes: [],
      rotatedAtMs: 1_700_000_000_000,
      token: ROTATED_TOKEN,
      tokenDelivery: "in-band",
    });
    await waitForRenderedModalDialog(document.body);

    // The rotate already killed the previous credential, so a mid-flight reconnect must
    // not swallow its replacement; the epoch guard still blocks the follow-up state writes.
    expect(secretDialogText()).toBe(ROTATED_TOKEN);
    expect(request).toHaveBeenCalledTimes(1);

    clickDialogButton(t("devices.inventory.rotateAcknowledge"));
    await pending;
    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
  });

  it("explains a cross-device rotation the Gateway withheld the token for", async () => {
    stubLocalDeviceIdentity();
    const client = rotatingClient(null);
    const page = createConnectedPage(client);

    const pending = page.reportRotationOutcome({ id: "device-2", name: "Mac Studio" }, "operator");
    const { dialog } = await waitForRenderedModalDialog(document.body);

    // The title carries the announcement and names the device the operator clicked.
    expect(dialog.getAttribute("aria-label")).toBe(
      t("devices.inventory.rotateWithheldTitle", { device: "Mac Studio" }),
    );
    expect(document.body.textContent).toContain("Mac Studio");
    expect(document.body.textContent).toContain(t("devices.inventory.rotateWithheldNext"));
    // The one actionable branch is a callout, keyed to a symptom the operator can see
    // rather than to which credential the device happens to hold.
    expect(document.body.querySelector(".secret-reveal__callout")?.textContent).toContain(
      t("devices.inventory.rotateWithheldException"),
    );
    expect(document.body.querySelector(".secret-reveal__status")).not.toBeNull();
    // Closing a report of work already done commits nothing, so it is not the accent button.
    const close = findDialogButton(t("common.close"));
    expect(close.className).toBe("btn secret-reveal__dismiss");
    expect(document.body.querySelector(".secret-reveal__note")?.textContent).toContain(
      t("devices.inventory.rotateWithheldNote"),
    );
    // No secret reached this operator, so there is no value block and nothing to copy.
    expect(document.body.querySelector(".secret-reveal__code")).toBeNull();
    expect(document.body.querySelector(".chat-copy-btn")).toBeNull();

    clickDialogButton(t("common.close"));
    await pending;

    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
  });

  it("lets a dismissal gesture close the withheld-rotation outcome", async () => {
    stubLocalDeviceIdentity();
    const client = rotatingClient(null);
    const page = createConnectedPage(client);

    const pending = page.reportRotationOutcome({ id: "device-2", name: "Mac Studio" }, "operator");
    const { webAwesomeDialog } = await waitForRenderedModalDialog(document.body);

    // Nothing here is unrecoverable, so Escape and backdrop settle it like any dialog
    // instead of being refused the way the show-once reveal refuses them.
    const dismissal = new Event("wa-hide", { bubbles: true, cancelable: true, composed: true });
    webAwesomeDialog.dispatchEvent(dismissal);
    await pending;

    expect(dismissal.defaultPrevented).toBe(false);
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
  });

  it("shows no reveal when the rotate request fails", async () => {
    stubLocalDeviceIdentity();
    const request = vi.fn().mockRejectedValue(new Error("rotate refused"));
    const client = { request } as unknown as GatewayBrowserClient;
    const page = createConnectedPage(client);

    await page.reportRotationOutcome({ id: "device-1", name: "MacBook Pro" }, "operator");

    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(page.pageState.devicesError).toContain("rotate refused");
    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
  });
});
