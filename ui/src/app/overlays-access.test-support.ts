import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "./gateway.ts";
import { createApplicationOverlays } from "./overlays.ts";

export type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

export function deferred<T = unknown>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

export function approval(id: string, createdAtMs: number) {
  return {
    id,
    createdAtMs,
    expiresAtMs: Date.now() + 60_000,
    request: { command: `echo ${id}` },
  };
}

export function createGatewayHarness(
  initialClient: GatewayBrowserClient | null,
  initialConnected = initialClient !== null,
) {
  let snapshot: ApplicationGatewaySnapshot = {
    assistantAgentId: "main",
    client: initialClient,
    phase: initialConnected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: { auth: { role: "operator" } } as ApplicationGatewaySnapshot["hello"],
    lastError: null,
    lastErrorCode: null,
    sessionKey: "main",
  };
  const snapshotListeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  const connect = vi.fn();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "ws://gateway.test", password: "", token: "", bootstrapToken: "" },
    eventLog: [],
    connect,
    setSessionKey() {},
    start() {},
    stop() {},
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    subscribeEventLog() {
      return () => {};
    },
    subscribeEvents(listener: (event: GatewayEventFrame) => void) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } satisfies ApplicationGateway;
  return {
    emitApproval(id: string, createdAtMs: number) {
      const event: GatewayEventFrame = {
        event: "exec.approval.requested",
        payload: approval(id, createdAtMs),
        type: "event",
      };
      for (const listener of eventListeners) {
        listener(event);
      }
    },
    emitSystemApproval(id: string, createdAtMs: number) {
      const event: GatewayEventFrame = {
        event: "openclaw.approval.requested",
        payload: {
          id,
          createdAtMs,
          expiresAtMs: Date.now() + 60_000,
          request: {
            title: "OpenClaw change",
            description: "Set gateway.port to 19001",
            command: "Set gateway.port to 19001",
            proposalHash: "a".repeat(64),
            allowedDecisions: ["allow-once", "deny"],
          },
        },
        type: "event",
      };
      for (const listener of eventListeners) {
        listener(event);
      }
    },
    gateway,
    connect,
    update(next: Partial<ApplicationGatewaySnapshot>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of snapshotListeners) {
        listener(snapshot);
      }
    },
  };
}

export function client(request: RequestFn): GatewayBrowserClient {
  return { request } as unknown as GatewayBrowserClient;
}

export async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

export function registerOverlayPairingAccessTests() {
  describe("application pairing setup permissions", () => {
    it("discards an in-flight setup credential after admin access becomes pairing-only", async () => {
      const setup = deferred();
      const request = vi.fn<RequestFn>((method) => {
        if (method === "device.pair.setupCode") {
          return setup.promise;
        }
        if (method === "device.pair.list") {
          return Promise.resolve({ pending: [] });
        }
        return Promise.resolve([]);
      });
      const harness = createGatewayHarness(client(request));
      harness.update({
        hello: {
          auth: { role: "operator", scopes: ["operator.admin"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const overlays = createApplicationOverlays(harness.gateway);
      await overlays.openDevicePairSetup();
      const mintingSetup = overlays.refreshDevicePairSetup();
      expect(request).toHaveBeenCalledWith("device.pair.setupCode", {});

      harness.update({
        hello: {
          auth: { role: "operator", scopes: ["operator.pairing"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      expect(overlays.snapshot.devicePairSetupOpen).toBe(false);
      expect(overlays.snapshot.devicePairSetup).toBeNull();

      setup.resolve({
        setupCode: "retired-test-setup-code",
        gatewayUrl: "ws://gateway.test",
        access: "full",
      });
      await mintingSetup;

      expect(overlays.snapshot.devicePairSetupOpen).toBe(false);
      expect(overlays.snapshot.devicePairSetup).toBeNull();
      expect(overlays.snapshot.devicePairSetupLoading).toBe(false);
      expect(
        request.mock.calls.filter(([method]) => method === "device.pair.setupCode"),
      ).toHaveLength(1);
      overlays.dispose();
    });

    it("closes a pairing-only setup when the same client loses pairing authority", async () => {
      const request = vi.fn<RequestFn>((method) =>
        Promise.resolve(method === "device.pair.list" ? { pending: [{ id: "pending" }] } : []),
      );
      const harness = createGatewayHarness(client(request));
      harness.update({
        hello: {
          auth: { role: "operator", scopes: ["operator.pairing"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const overlays = createApplicationOverlays(harness.gateway);
      await overlays.openDevicePairSetup();
      await flushMicrotasks();
      expect(overlays.snapshot.devicePairSetupOpen).toBe(true);
      expect(overlays.snapshot.devicePairPendingCount).toBe(1);

      harness.update({
        hello: {
          auth: { role: "operator", scopes: ["operator.read"] },
        } as ApplicationGatewaySnapshot["hello"],
      });

      expect(overlays.snapshot.devicePairSetupOpen).toBe(false);
      expect(overlays.snapshot.devicePairSetup).toBeNull();
      expect(overlays.snapshot.devicePairPendingCount).toBe(0);
      expect(request).not.toHaveBeenCalledWith("device.pair.setupCode", {});
      overlays.dispose();
    });

    it.each([
      { name: "write-only", scopes: ["operator.write"] },
      { name: "approval-only", scopes: ["operator.approvals"] },
      { name: "explicitly ungranted", scopes: [] },
    ])("does not dispatch pairing or setup requests for a $name operator", async ({ scopes }) => {
      const request = vi.fn<RequestFn>(() => Promise.resolve({ pending: [] }));
      const harness = createGatewayHarness(client(request));
      harness.update({
        hello: { auth: { role: "operator", scopes } } as ApplicationGatewaySnapshot["hello"],
      });
      const overlays = createApplicationOverlays(harness.gateway);

      await overlays.openDevicePairSetup();
      await overlays.refreshDevicePairSetup();

      expect(request).not.toHaveBeenCalledWith("device.pair.list", {});
      expect(request).not.toHaveBeenCalledWith("device.pair.setupCode", {});
      expect(overlays.snapshot.devicePairSetupOpen).toBe(false);
      overlays.dispose();
    });

    it("allows pairing-only list access without minting an admin setup credential", async () => {
      const request = vi.fn<RequestFn>((method) =>
        Promise.resolve(method === "device.pair.list" ? { pending: [] } : []),
      );
      const harness = createGatewayHarness(client(request));
      harness.update({
        hello: {
          auth: { role: "operator", scopes: ["operator.pairing"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const overlays = createApplicationOverlays(harness.gateway);

      await overlays.openDevicePairSetup();
      await overlays.refreshDevicePairSetup();

      expect(request).toHaveBeenCalledWith("device.pair.list", {});
      expect(request).not.toHaveBeenCalledWith("device.pair.setupCode", {});
      overlays.dispose();
    });
  });
}
