import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "./gateway.ts";
import { createApplicationOverlays } from "./overlays.ts";

export type RequestFn = (
  method: string,
  params?: unknown,
  options?: { timeoutMs?: number | null },
) => Promise<unknown>;

const SYSTEM_APPROVAL_TITLE = "OpenClaw change";
const SYSTEM_APPROVAL_COMMAND = "Set gateway.port to 19001";

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
    emitEvent(event: string, payload: unknown) {
      const frame = { event, payload, type: "event" } as GatewayEventFrame;
      for (const listener of eventListeners) {
        listener(frame);
      }
    },
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
    emitDevicePairRequested() {
      const event: GatewayEventFrame = {
        event: "device.pair.requested",
        payload: {},
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
            title: SYSTEM_APPROVAL_TITLE,
            description: SYSTEM_APPROVAL_COMMAND,
            command: SYSTEM_APPROVAL_COMMAND,
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
    replaceSnapshotWithoutPublishing(next: Partial<ApplicationGatewaySnapshot>) {
      snapshot = { ...snapshot, ...next };
    },
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

function setupResult(setupId: string, expiresAtMs = Date.now() + 60_000) {
  return {
    setupId,
    expiresAtMs,
    setupCode: `setup-code-${setupId}`,
    gatewayUrl: "wss://gateway.test",
    auth: "token",
    urlSource: "test",
    access: "full",
  } as const;
}

export function registerOverlayPairingAccessTests() {
  describe("application pairing setup permissions", () => {
    it.each([
      {
        name: "pairing-only to legacy administrator",
        previousAuth: { role: "operator", scopes: ["operator.pairing"] },
        nextAuth: null,
      },
      {
        name: "legacy administrator to scoped administrator",
        previousAuth: null,
        nextAuth: { role: "operator", scopes: ["operator.admin"] },
      },
    ])("refreshes an open pairing dialog after $name", async ({ previousAuth, nextAuth }) => {
      const stalePending = deferred<{ pending: Array<{ id: string }> }>();
      const freshPending = [{ id: "current-first" }, { id: "current-second" }];
      let pairingRequests = 0;
      const request = vi.fn<RequestFn>((method) => {
        if (method !== "device.pair.list") {
          return Promise.resolve([]);
        }
        pairingRequests += 1;
        return pairingRequests === 1
          ? stalePending.promise
          : Promise.resolve({ pending: freshPending });
      });
      const harness = createGatewayHarness(client(request));
      harness.update({
        hello: previousAuth
          ? ({ auth: previousAuth } as ApplicationGatewaySnapshot["hello"])
          : null,
      });
      const overlays = createApplicationOverlays(harness.gateway);

      try {
        await overlays.openDevicePairSetup();
        expect(overlays.snapshot.devicePairSetupOpen).toBe(true);
        expect(pairingRequests).toBe(1);

        harness.update({
          hello: nextAuth ? ({ auth: nextAuth } as ApplicationGatewaySnapshot["hello"]) : null,
        });
        await flushMicrotasks();

        expect(overlays.snapshot.devicePairSetupOpen).toBe(true);
        expect(pairingRequests).toBe(2);
        expect(overlays.snapshot.devicePairPendingCount).toBe(2);

        stalePending.resolve({ pending: [{ id: "retired" }] });
        await flushMicrotasks();

        expect(overlays.snapshot.devicePairPendingCount).toBe(2);
        expect(request).not.toHaveBeenCalledWith("device.pair.setupCode", {});
      } finally {
        stalePending.resolve({ pending: [] });
        overlays.dispose();
      }
    });

    it("refreshes legacy admin pairing counts when device-pair events arrive", async () => {
      let pending = [{ id: "first-pending" }];
      const request = vi.fn<RequestFn>((method) =>
        Promise.resolve(method === "device.pair.list" ? { pending } : []),
      );
      const harness = createGatewayHarness(client(request));
      harness.update({ hello: null });
      const overlays = createApplicationOverlays(harness.gateway);

      await overlays.openDevicePairSetup();
      await flushMicrotasks();

      expect(overlays.snapshot.devicePairSetupOpen).toBe(true);
      expect(overlays.snapshot.devicePairPendingCount).toBe(1);
      expect(request).toHaveBeenCalledWith("device.pair.list", {});

      pending = [{ id: "first-pending" }, { id: "second-pending" }];
      harness.emitDevicePairRequested();
      await flushMicrotasks();

      expect(overlays.snapshot.devicePairPendingCount).toBe(2);
      expect(request.mock.calls.filter(([method]) => method === "device.pair.list")).toHaveLength(
        2,
      );

      harness.update({
        hello: {
          auth: { role: "operator", scopes: ["operator.read"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      expect(overlays.snapshot.devicePairSetupOpen).toBe(false);
      expect(overlays.snapshot.devicePairPendingCount).toBe(0);
      harness.emitDevicePairRequested();
      await flushMicrotasks();

      expect(request.mock.calls.filter(([method]) => method === "device.pair.list")).toHaveLength(
        2,
      );
      expect(request).not.toHaveBeenCalledWith("device.pair.setupCode", {});
      overlays.dispose();
    });

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
      expect(overlays.snapshot.devicePairSetupLifecycle).toEqual({
        phase: "selection",
        access: "full",
      });

      setup.resolve({
        setupId: "retired-setup",
        expiresAtMs: Date.now() + 60_000,
        setupCode: "retired-test-setup-code",
        gatewayUrl: "ws://gateway.test",
        auth: "token",
        urlSource: "test",
        access: "full",
      });
      await mintingSetup;

      expect(overlays.snapshot.devicePairSetupOpen).toBe(false);
      expect(overlays.snapshot.devicePairSetupLifecycle).toEqual({
        phase: "selection",
        access: "full",
      });
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
      expect(overlays.snapshot.devicePairSetupLifecycle).toEqual({
        phase: "selection",
        access: "full",
      });
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

    it("completes only the active setup from the dedicated event", async () => {
      let setupId = "setup-first";
      const request = vi.fn<RequestFn>((method) => {
        if (method === "device.pair.setupCode") {
          return Promise.resolve(setupResult(setupId));
        }
        return Promise.resolve(method === "device.pair.list" ? { pending: [] } : []);
      });
      const harness = createGatewayHarness(client(request));
      const overlays = createApplicationOverlays(harness.gateway);

      await overlays.openDevicePairSetup();
      await overlays.refreshDevicePairSetup();
      expect(overlays.snapshot.devicePairSetupLifecycle).toMatchObject({
        phase: "waiting",
        setup: { setupId: "setup-first" },
      });

      harness.emitEvent("device.pair.resolved", {
        setupId: "setup-first",
        deviceId: "phone-first",
      });
      harness.emitEvent("device.pair.setup.completed", {
        setupId: "setup-unrelated",
        deviceId: "phone-unrelated",
        deviceName: "Unrelated phone",
        access: "full",
        ts: 1,
      });
      expect(overlays.snapshot.devicePairSetupLifecycle.phase).toBe("waiting");

      setupId = "setup-second";
      await overlays.refreshDevicePairSetup();
      harness.emitEvent("device.pair.setup.completed", {
        setupId: "setup-first",
        deviceId: "phone-stale",
        deviceName: "Stale phone",
        access: "full",
        ts: 2,
      });
      expect(overlays.snapshot.devicePairSetupLifecycle).toMatchObject({
        phase: "waiting",
        setup: { setupId: "setup-second" },
      });

      harness.emitEvent("device.pair.setup.completed", {
        setupId: "setup-second",
        deviceId: "phone-current",
        deviceName: "  Operator's iPhone  ",
        access: "limited",
        ts: 3,
      });
      expect(overlays.snapshot.devicePairSetupLifecycle).toEqual({
        phase: "success",
        deviceName: "Operator's iPhone",
        access: "limited",
      });
      overlays.dispose();
    });

    it("surfaces delivery uncertainty only for the active setup", async () => {
      const request = vi.fn<RequestFn>((method) =>
        Promise.resolve(
          method === "device.pair.setupCode"
            ? setupResult("setup-current")
            : method === "device.pair.list"
              ? { pending: [] }
              : [],
        ),
      );
      const harness = createGatewayHarness(client(request));
      const overlays = createApplicationOverlays(harness.gateway);

      await overlays.openDevicePairSetup();
      await overlays.refreshDevicePairSetup();
      harness.emitEvent("device.pair.setup.deliveryUncertain", {
        setupId: "setup-stale",
        deviceId: "phone-stale",
        access: "full",
        ts: 1,
      });
      expect(overlays.snapshot.devicePairSetupLifecycle.phase).toBe("waiting");

      harness.emitEvent("device.pair.setup.deliveryUncertain", {
        setupId: "setup-current",
        deviceId: "phone-current",
        deviceName: "Phone",
        access: "full",
        ts: 2,
      });
      expect(overlays.snapshot.devicePairSetupLifecycle).toEqual({
        phase: "delivery-uncertain",
        access: "full",
      });
      overlays.dispose();
    });

    it.each(["reconnect", "access revocation", "dispose"] as const)(
      "retires the setup expiry timer on %s",
      async (boundary) => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const request = vi.fn<RequestFn>((method) =>
          Promise.resolve(
            method === "device.pair.setupCode"
              ? setupResult("setup-timer", 70_000)
              : { pending: [] },
          ),
        );
        const harness = createGatewayHarness(client(request));
        harness.update({
          hello: {
            auth: { role: "operator", scopes: ["operator.admin"] },
          } as ApplicationGatewaySnapshot["hello"],
        });
        const overlays = createApplicationOverlays(harness.gateway);

        try {
          await overlays.openDevicePairSetup();
          await overlays.refreshDevicePairSetup();
          expect(vi.getTimerCount()).toBe(1);

          if (boundary === "reconnect") {
            harness.update({ client: client(request) });
          } else if (boundary === "access revocation") {
            harness.update({
              hello: {
                auth: { role: "operator", scopes: ["operator.pairing"] },
              } as ApplicationGatewaySnapshot["hello"],
            });
          } else {
            overlays.dispose();
          }

          expect(vi.getTimerCount()).toBe(0);
          if (boundary !== "dispose") {
            expect(overlays.snapshot.devicePairSetupLifecycle).toEqual({
              phase: "selection",
              access: "full",
            });
          }
        } finally {
          overlays.dispose();
          vi.useRealTimers();
        }
      },
    );
  });
}
