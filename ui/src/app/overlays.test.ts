// Control UI tests cover application-owned overlay races.
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "./gateway.ts";
import { createApplicationOverlays } from "./overlays.ts";

vi.mock("../build-info.ts", () => ({
  controlUiVersionDiffersFrom: (gatewayVersion: string | undefined) =>
    Boolean(gatewayVersion?.trim() && gatewayVersion.trim() !== "1.0.0"),
}));

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;
const VERIFICATION_POLL_MS = 250;

function deferred<T = unknown>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function approval(id: string, createdAtMs: number) {
  return {
    id,
    createdAtMs,
    expiresAtMs: Date.now() + 60_000,
    request: { command: `echo ${id}` },
  };
}

function createGatewayHarness(
  initialClient: GatewayBrowserClient | null,
  initialConnected = initialClient !== null,
) {
  let snapshot: ApplicationGatewaySnapshot = {
    assistantAgentId: "main",
    client: initialClient,
    connected: initialConnected,
    reconnecting: false,
    hello: null,
    lastError: null,
    lastErrorCode: null,
    sessionKey: "main",
  };
  const snapshotListeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "ws://gateway.test", password: "", token: "", bootstrapToken: "" },
    eventLog: [],
    connect() {},
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
    update(next: Partial<ApplicationGatewaySnapshot>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of snapshotListeners) {
        listener(snapshot);
      }
    },
  };
}

function client(request: RequestFn): GatewayBrowserClient {
  return { request } as unknown as GatewayBrowserClient;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Control UI refresh nudge", () => {
  it("waits for a reconnect before flagging a version mismatch", () => {
    const gatewayClient = client(async () => []);
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway);
    const mismatchedHello = {
      server: { version: "2.0.0" },
    } as ApplicationGatewaySnapshot["hello"];

    harness.update({ client: gatewayClient, connected: true, hello: mismatchedHello });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(false);

    harness.update({ sessionKey: "agent:main:same-connection" });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(false);

    harness.update({ connected: false, hello: null });
    harness.update({ connected: true, hello: mismatchedHello });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(true);

    harness.update({ sessionKey: "agent:main:after-reconnect" });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(true);

    overlays.dispose();
  });

  it("does not flag a matching reconnect and resets on a fresh client lifetime", () => {
    const gatewayClient = client(async () => []);
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway);
    const matchingHello = {
      server: { version: "1.0.0" },
    } as ApplicationGatewaySnapshot["hello"];
    const mismatchedHello = {
      server: { version: "2.0.0" },
    } as ApplicationGatewaySnapshot["hello"];

    harness.update({ client: gatewayClient, connected: true, hello: matchingHello });
    harness.update({ connected: false, hello: null });
    harness.update({ connected: true, hello: matchingHello });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(false);

    harness.update({ connected: false, hello: null });
    harness.update({ connected: true, hello: mismatchedHello });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(true);

    harness.update({ client: null, connected: false, hello: null });
    harness.update({ client: gatewayClient, connected: true, hello: mismatchedHello });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(false);

    overlays.dispose();
  });
});

describe("application approval overlays", () => {
  it("resolves OpenClaw changes through unified human approval", async () => {
    const request = vi.fn<RequestFn>(async (method) =>
      method.endsWith(".list") ? [] : { ok: true },
    );
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);

    harness.emitSystemApproval("system-agent:1", 1_000);
    await overlays.decideApproval("allow-once");

    expect(request).toHaveBeenCalledWith("approval.resolve", {
      id: "system-agent:1",
      kind: "system-agent",
      decision: "allow-once",
    });
    overlays.dispose();
  });

  it("reloads pending approvals for each connected epoch", async () => {
    const firstList = deferred();
    const reconnectedList = deferred();
    let execListRequests = 0;
    const request = vi.fn<RequestFn>((method) => {
      if (method !== "exec.approval.list") {
        return Promise.resolve([]);
      }
      execListRequests += 1;
      return execListRequests === 1 ? firstList.promise : reconnectedList.promise;
    });
    const gatewayClient = client(request);
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway);

    harness.update({ client: gatewayClient, connected: false });
    await flushMicrotasks();
    expect(request).not.toHaveBeenCalled();

    harness.update({ connected: true });
    await flushMicrotasks();
    expect(execListRequests).toBe(1);
    expect(request).toHaveBeenCalledWith("exec.approval.list", {});
    expect(request).toHaveBeenCalledWith("plugin.approval.list", {});
    expect(request).toHaveBeenCalledWith("openclaw.approval.list", {});

    harness.update({ connected: false });
    expect(overlays.snapshot.approvalQueue).toEqual([]);
    harness.update({ connected: true });
    await flushMicrotasks();
    expect(execListRequests).toBe(2);

    reconnectedList.resolve([approval("approval-reconnected", 2_000)]);
    await vi.waitFor(() => {
      expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual([
        "approval-reconnected",
      ]);
    });

    firstList.resolve([approval("approval-stale", 1_000)]);
    await flushMicrotasks();
    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual([
      "approval-reconnected",
    ]);
    overlays.dispose();
  });

  it("keeps a resolve failure attached to its older request", async () => {
    const resolveAttempt = deferred();
    const request = vi.fn<RequestFn>((method) =>
      method.endsWith(".list") ? Promise.resolve([]) : resolveAttempt.promise,
    );
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);

    harness.emitApproval("approval-active", 1_000);
    const decision = overlays.decideApproval("allow-once");
    harness.emitApproval("approval-newer", 2_000);
    resolveAttempt.reject(new Error("gateway unavailable"));
    await decision;

    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual([
      "approval-active",
      "approval-newer",
    ]);
    expect(overlays.snapshot.approvalErrors.get("approval-active")).toBe(
      "Approval failed: gateway unavailable",
    );
    expect(overlays.snapshot.approvalBusy).toBe(false);
    overlays.dispose();
  });

  it("keeps A's failure visible after deciding B successfully", async () => {
    const firstResolve = deferred();
    const secondResolve = deferred();
    let resolveCalls = 0;
    const request = vi.fn<RequestFn>((method) => {
      if (method.endsWith(".list")) {
        return Promise.resolve([]);
      }
      resolveCalls += 1;
      return resolveCalls === 1 ? firstResolve.promise : secondResolve.promise;
    });
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);

    harness.emitApproval("approval-a", 1_000);
    harness.emitApproval("approval-b", 2_000);
    const firstDecision = overlays.decideApproval("allow-once", "approval-a");
    firstResolve.reject(new Error("gateway unavailable"));
    await firstDecision;
    expect(overlays.snapshot.approvalErrors.get("approval-a")).toBe(
      "Approval failed: gateway unavailable",
    );

    const secondDecision = overlays.decideApproval("deny", "approval-b");
    secondResolve.resolve({ ok: true });
    await secondDecision;

    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual(["approval-a"]);
    expect(overlays.snapshot.approvalErrors.get("approval-a")).toBe(
      "Approval failed: gateway unavailable",
    );
    overlays.dispose();
  });

  it("clears an approval's error when that approval is retried", async () => {
    const firstResolve = deferred();
    let resolveCalls = 0;
    const request = vi.fn<RequestFn>((method) => {
      if (method.endsWith(".list")) {
        return Promise.resolve([]);
      }
      resolveCalls += 1;
      return resolveCalls === 1 ? firstResolve.promise : Promise.resolve({ ok: true });
    });
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);

    harness.emitApproval("approval-a", 1_000);
    const failedDecision = overlays.decideApproval("allow-once");
    firstResolve.reject(new Error("gateway unavailable"));
    await failedDecision;
    expect(overlays.snapshot.approvalErrors.has("approval-a")).toBe(true);

    await overlays.decideApproval("allow-once");

    expect(overlays.snapshot.approvalQueue).toEqual([]);
    expect(overlays.snapshot.approvalErrors.has("approval-a")).toBe(false);
    overlays.dispose();
  });

  it("resolves a selected queued approval by id", async () => {
    const request = vi.fn<RequestFn>(async (method) =>
      method.endsWith(".list") ? [] : { ok: true },
    );
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);
    harness.emitApproval("approval-oldest", 1_000);
    harness.emitApproval("approval-newer", 2_000);

    await overlays.decideApproval("deny", "approval-newer");

    expect(request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-newer",
      decision: "deny",
    });
    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual(["approval-oldest"]);
    overlays.dispose();
  });

  it("does not release a new client's busy state when an old resolve settles", async () => {
    const oldResolve = deferred();
    const oldRequest = vi.fn<RequestFn>((method) =>
      method.endsWith(".list") ? Promise.resolve([]) : oldResolve.promise,
    );
    const harness = createGatewayHarness(client(oldRequest));
    const overlays = createApplicationOverlays(harness.gateway);

    harness.emitApproval("approval-old", 1_000);
    const oldDecision = overlays.decideApproval("allow-once");
    harness.update({ client: null, connected: false });

    const newResolve = deferred();
    const newClient = client((method) =>
      method.endsWith(".list") ? Promise.resolve([]) : newResolve.promise,
    );
    harness.update({ client: newClient, connected: true });
    await Promise.resolve();
    harness.emitApproval("approval-new", 2_000);
    const newDecision = overlays.decideApproval("deny");
    expect(overlays.snapshot.approvalBusy).toBe(true);

    oldResolve.reject(new Error("gateway client stopped"));
    await oldDecision;
    expect(overlays.snapshot.approvalBusy).toBe(true);
    expect(overlays.snapshot.approvalErrors).toEqual(new Map());

    newResolve.resolve({ ok: true });
    await newDecision;
    expect(overlays.snapshot.approvalBusy).toBe(false);
    expect(overlays.snapshot.approvalQueue).toEqual([]);
    overlays.dispose();
  });

  it("does not dismiss a new approval when an old same-client decision settles", async () => {
    const oldResolve = deferred();
    const request = vi.fn<RequestFn>((method) =>
      method.endsWith(".list") ? Promise.resolve([]) : oldResolve.promise,
    );
    const gatewayClient = client(request);
    const harness = createGatewayHarness(gatewayClient);
    const overlays = createApplicationOverlays(harness.gateway);

    harness.emitApproval("approval-old", 1_000);
    const oldDecision = overlays.decideApproval("allow-once");
    harness.update({ connected: false });
    harness.update({ connected: true });
    await flushMicrotasks();
    harness.emitApproval("approval-new", 2_000);

    oldResolve.resolve({ ok: true });
    await oldDecision;

    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual(["approval-new"]);
    expect(overlays.snapshot.approvalBusy).toBe(false);
    overlays.dispose();
  });

  it("ignores a decision that settles after disposal", async () => {
    const resolveAttempt = deferred();
    const request = vi.fn<RequestFn>((method) =>
      method.endsWith(".list") ? Promise.resolve([]) : resolveAttempt.promise,
    );
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);

    harness.emitApproval("approval-active", 1_000);
    const decision = overlays.decideApproval("allow-once");
    overlays.dispose();
    resolveAttempt.reject(new Error("disposed"));
    await decision;

    expect(overlays.snapshot.approvalErrors).toEqual(new Map());
  });
});

describe("application update overlays", () => {
  it("drains config writes after suspending and before issuing update.run", async () => {
    const order: string[] = [];
    const request = vi.fn<RequestFn>().mockImplementation(async (method) => {
      order.push(method);
      return { ok: true, result: { status: "ok", after: { version: "2.0.0" } } };
    });
    const harness = createGatewayHarness(client(request));
    let updateRunningWhenDrained = false;
    const overlays = createApplicationOverlays(harness.gateway, {
      drainConfigWrites: async () => {
        order.push("drain");
        updateRunningWhenDrained = overlays.snapshot.updateRunning;
        await Promise.resolve();
      },
    });

    await overlays.runUpdate();

    expect(order.filter((entry) => entry === "drain" || entry === "update.run")).toEqual([
      "drain",
      "update.run",
    ]);
    // Suspension publishes first so no NEW write can start while draining.
    expect(updateRunningWhenDrained).toBe(true);
  });

  it("surfaces a coalesced restart while reconnect verification remains active", async () => {
    const request = vi.fn<RequestFn>().mockResolvedValue({
      ok: true,
      restart: { coalesced: true },
      result: { status: "ok", after: { version: "2.0.0" } },
    });
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);

    await overlays.runUpdate();

    expect(request).toHaveBeenCalledWith("update.run", {});
    expect(overlays.snapshot.updateStatusBanner).toEqual({
      tone: "info",
      text: "Update installed. A gateway restart is already in progress; status will refresh after it reconnects.",
    });
    expect(overlays.snapshot.updateRunning).toBe(false);
    expect(overlays.snapshot.updateReconciliationPending).toBe(true);
    overlays.dispose();
  });

  it("keeps reconciliation pending after a managed-service handoff starts", async () => {
    const request = vi.fn<RequestFn>().mockResolvedValue({
      ok: true,
      handoff: { status: "started" },
      result: {
        status: "skipped",
        reason: "managed-service-handoff-started",
        after: { version: "2.0.0" },
      },
    });
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);

    await overlays.runUpdate();

    expect(overlays.snapshot.updateRunning).toBe(false);
    expect(overlays.snapshot.updateReconciliationPending).toBe(true);
    overlays.dispose();
  });

  it("reports a concurrent managed update as rejected", async () => {
    const request = vi.fn<RequestFn>().mockResolvedValue({
      ok: false,
      handoff: { status: "already-running" },
      result: {
        status: "skipped",
        reason: "managed-service-handoff-already-running",
      },
    });
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);

    await overlays.runUpdate();

    expect(overlays.snapshot.updateReconciliationPending).toBe(false);
    expect(overlays.snapshot.updateStatusBanner).toEqual({
      tone: "warn",
      text: "Update skipped: managed-service-handoff-already-running. Another managed update is already running. Wait for it to complete, then refresh update status.",
    });
    overlays.dispose();
  });

  it("verifies on reconnect and survives updates within the connected epoch", async () => {
    vi.useFakeTimers();
    let statusRequests = 0;
    const request = vi.fn<RequestFn>((method) => {
      if (method.endsWith(".list")) {
        return Promise.resolve([]);
      }
      if (method === "update.run") {
        return Promise.resolve({
          ok: true,
          result: { status: "ok", after: { version: "2.0.0" } },
        });
      }
      if (method === "update.status") {
        statusRequests += 1;
        return Promise.resolve(
          statusRequests === 1
            ? {
                sentinel: {
                  kind: "update",
                  status: "skipped",
                  stats: { reason: "restart-health-pending" },
                },
              }
            : {
                sentinel: {
                  kind: "update",
                  status: "ok",
                  stats: { after: { version: "2.0.0" } },
                },
              },
        );
      }
      return Promise.resolve({});
    });
    const gatewayClient = client(request);
    const harness = createGatewayHarness(gatewayClient);
    const overlays = createApplicationOverlays(harness.gateway);

    try {
      await overlays.runUpdate();
      harness.update({ connected: false });
      harness.update({ connected: true });
      await flushMicrotasks();
      expect(statusRequests).toBe(1);

      harness.update({ sessionKey: "agent:main:next" });
      await vi.advanceTimersByTimeAsync(VERIFICATION_POLL_MS);
      await flushMicrotasks();

      expect(statusRequests).toBe(2);
      expect(overlays.snapshot.updateStatusBanner).toBeNull();
      expect(overlays.snapshot.updateReconciliationPending).toBe(false);
    } finally {
      overlays.dispose();
      vi.useRealTimers();
    }
  });
});
