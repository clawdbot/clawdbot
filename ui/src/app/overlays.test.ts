// @vitest-environment node
// Control UI tests cover application-owned overlay races.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import {
  approval,
  client,
  createGatewayHarness,
  deferred,
  flushMicrotasks,
  registerOverlayPairingAccessTests,
  type RequestFn,
} from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";

vi.mock("../build-info.ts", () => ({
  controlUiVersionDiffersFrom: (gatewayVersion: string | undefined) =>
    Boolean(gatewayVersion?.trim() && gatewayVersion.trim() !== "1.0.0"),
}));
const { peekStoredDeviceIdentityIdMock } = vi.hoisted(() => ({
  peekStoredDeviceIdentityIdMock: vi.fn((): string | null => "browser-1"),
}));
vi.mock("../lib/nodes/index.ts", () => ({
  peekStoredDeviceIdentityId: peekStoredDeviceIdentityIdMock,
}));

const VERIFICATION_POLL_MS = 250;

describe("device-auth upgrade migration", () => {
  beforeEach(() => {
    peekStoredDeviceIdentityIdMock.mockReturnValue("browser-1");
  });

  it("guides a device-less legacy browser to a secure context", async () => {
    peekStoredDeviceIdentityIdMock.mockReturnValue(null);
    const request = vi.fn<RequestFn>(() => Promise.resolve({}));
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway);
    harness.update({
      client: client(request),
      phase: "connected",
      hello: {
        server: { version: "1.0.0" },
        deviceAuthMigration: { pending: true },
      } as ApplicationGatewaySnapshot["hello"],
    });

    await vi.waitFor(() => {
      expect(overlays.snapshot.deviceAuthMigration.error).toContain("HTTPS or localhost");
    });
    expect(overlays.snapshot.deviceAuthMigration.requestId).toBeNull();
    expect(request).not.toHaveBeenCalledWith("device.pair.list", expect.anything());
    overlays.dispose();
  });

  it("approves only this browser and reconnects for its device token", async () => {
    const request = vi.fn<RequestFn>((method, params) => {
      if (method === "device.pair.list") {
        return Promise.resolve({
          pending: [
            { requestId: "other-request", deviceId: "browser-2" },
            { requestId: "self-request", deviceId: "browser-1" },
          ],
        });
      }
      if (method === "device.pair.approve") {
        expect(params).toEqual({ requestId: "self-request" });
        return Promise.resolve({ requestId: "self-request" });
      }
      if (method.endsWith(".list")) {
        return Promise.resolve([]);
      }
      return Promise.resolve({});
    });
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway);
    harness.update({
      client: client(request),
      phase: "connected",
      hello: {
        server: { version: "1.0.0" },
        deviceAuthMigration: { pending: true },
      } as ApplicationGatewaySnapshot["hello"],
    });

    await vi.waitFor(() => {
      expect(overlays.snapshot.deviceAuthMigration.requestId).toBe("self-request");
    });
    await overlays.secureThisBrowser();

    expect(request).toHaveBeenCalledWith("device.pair.approve", {
      requestId: "self-request",
    });
    expect(harness.connect).toHaveBeenCalledOnce();
    expect(overlays.snapshot.deviceAuthMigration.requestId).toBeNull();
    overlays.dispose();
  });

  it("does not reconnect when approval finishes after disposal", async () => {
    let resolveApproval: (() => void) | undefined;
    const approvalRequest = new Promise<void>((resolve) => {
      resolveApproval = resolve;
    });
    const request = vi.fn<RequestFn>((method) => {
      if (method === "device.pair.list") {
        return Promise.resolve({
          pending: [{ requestId: "self-request", deviceId: "browser-1" }],
        });
      }
      if (method === "device.pair.approve") {
        return approvalRequest;
      }
      return Promise.resolve([]);
    });
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway);
    harness.update({
      client: client(request),
      phase: "connected",
      hello: {
        server: { version: "1.0.0" },
        deviceAuthMigration: { pending: true },
      } as ApplicationGatewaySnapshot["hello"],
    });

    await vi.waitFor(() => {
      expect(overlays.snapshot.deviceAuthMigration.requestId).toBe("self-request");
    });
    const securing = overlays.secureThisBrowser();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("device.pair.approve", {
        requestId: "self-request",
      });
    });
    overlays.dispose();
    resolveApproval?.();
    await securing;

    expect(harness.connect).not.toHaveBeenCalled();
  });

  it("does not approve through a replacement gateway session", async () => {
    const firstRequest = vi.fn<RequestFn>((method) =>
      Promise.resolve(
        method === "device.pair.list"
          ? { pending: [{ requestId: "self-request", deviceId: "browser-1" }] }
          : {},
      ),
    );
    const replacementRequest = vi.fn<RequestFn>(() => Promise.resolve({ pending: [] }));
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway);
    harness.update({
      client: client(firstRequest),
      phase: "connected",
      hello: {
        server: { version: "1.0.0" },
        deviceAuthMigration: { pending: true },
      } as ApplicationGatewaySnapshot["hello"],
    });

    await vi.waitFor(() => {
      expect(overlays.snapshot.deviceAuthMigration.requestId).toBe("self-request");
    });
    const securing = overlays.secureThisBrowser();
    harness.update({ client: client(replacementRequest) });
    await securing;

    expect(firstRequest).not.toHaveBeenCalledWith("device.pair.approve", expect.anything());
    expect(replacementRequest).not.toHaveBeenCalledWith("device.pair.approve", expect.anything());
    expect(harness.connect).not.toHaveBeenCalled();
    overlays.dispose();
  });

  it("does not expose an action for another browser's request", async () => {
    const request = vi.fn<RequestFn>((method) =>
      Promise.resolve(
        method === "device.pair.list"
          ? { pending: [{ requestId: "other-request", deviceId: "browser-2" }] }
          : [],
      ),
    );
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway);
    harness.update({
      client: client(request),
      phase: "connected",
      hello: {
        server: { version: "1.0.0" },
        deviceAuthMigration: { pending: true },
      } as ApplicationGatewaySnapshot["hello"],
    });

    await vi.waitFor(() => {
      expect(overlays.snapshot.deviceAuthMigration.error).toContain(
        "pairing request is not available",
      );
    });
    expect(overlays.snapshot.deviceAuthMigration.requestId).toBeNull();
    await overlays.secureThisBrowser();
    expect(request).not.toHaveBeenCalledWith("device.pair.approve", expect.anything());
    expect(harness.connect).not.toHaveBeenCalled();
    overlays.dispose();
  });
});

describe("Control UI refresh nudge", () => {
  it("waits for a reconnect before flagging a version mismatch", () => {
    const gatewayClient = client(async () => []);
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway);
    const mismatchedHello = {
      server: { version: "2.0.0" },
    } as ApplicationGatewaySnapshot["hello"];

    harness.update({ client: gatewayClient, phase: "connected", hello: mismatchedHello });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(false);

    harness.update({ sessionKey: "agent:main:same-connection" });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(false);

    harness.update({ phase: "stopped", hello: null });
    harness.update({ phase: "connected", hello: mismatchedHello });
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

    harness.update({ client: gatewayClient, phase: "connected", hello: matchingHello });
    harness.update({ phase: "stopped", hello: null });
    harness.update({ phase: "connected", hello: matchingHello });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(false);

    harness.update({ phase: "stopped", hello: null });
    harness.update({ phase: "connected", hello: mismatchedHello });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(true);

    harness.update({ client: null, phase: "stopped", hello: null });
    harness.update({ client: gatewayClient, phase: "connected", hello: mismatchedHello });
    expect(overlays.snapshot.controlUiRefreshRequired).toBe(false);

    overlays.dispose();
  });
});

describe("application approval overlays", () => {
  it("keeps no-auth approvals readable without granting resolution authority", async () => {
    const request = vi.fn<RequestFn>((method) =>
      Promise.resolve(method.endsWith(".list") ? [] : { ok: true }),
    );
    const harness = createGatewayHarness(client(request));
    harness.update({ hello: null });
    const overlays = createApplicationOverlays(harness.gateway);
    await flushMicrotasks();

    harness.emitApproval("approval-review-only", 1_000);
    await overlays.decideApproval("allow-once", "approval-review-only");

    expect(request).toHaveBeenCalledWith("exec.approval.list", {});
    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual([
      "approval-review-only",
    ]);
    expect(overlays.snapshot.approvalBusy).toBe(false);
    expect(
      request.mock.calls.some(
        ([method]) => method === "exec.approval.resolve" || method === "approval.resolve",
      ),
    ).toBe(false);
    overlays.dispose();
  });

  it.each([
    { name: "reviewer", scopes: ["operator.approvals"] },
    { name: "administrator", scopes: ["operator.admin"] },
  ])("resolves a queued approval with an authenticated $name grant", async ({ scopes }) => {
    const request = vi.fn<RequestFn>((method) =>
      Promise.resolve(method.endsWith(".list") ? [] : { ok: true }),
    );
    const harness = createGatewayHarness(client(request));
    harness.update({
      hello: { auth: { role: "operator", scopes } } as ApplicationGatewaySnapshot["hello"],
    });
    const overlays = createApplicationOverlays(harness.gateway);
    await flushMicrotasks();
    harness.emitApproval("approval-authorized", 1_000);

    await overlays.decideApproval("allow-once", "approval-authorized");

    expect(request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-authorized",
      decision: "allow-once",
    });
    overlays.dispose();
  });

  it.each([
    { name: "read-only", scopes: ["operator.read"] },
    { name: "write-only", scopes: ["operator.write"] },
  ])("does not request or expose approvals for a $name operator", async ({ scopes }) => {
    const request = vi.fn<RequestFn>(() => Promise.resolve([]));
    const gatewayClient = client(request);
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway);

    harness.update({
      client: gatewayClient,
      phase: "connected",
      hello: {
        server: { version: "1.0.0" },
        auth: { role: "operator", scopes },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await flushMicrotasks();

    expect(request).not.toHaveBeenCalledWith("exec.approval.list", {});
    expect(request).not.toHaveBeenCalledWith("plugin.approval.list", {});
    expect(request).not.toHaveBeenCalledWith("openclaw.approval.list", {});

    harness.emitApproval("hidden-approval", 1_000);
    expect(overlays.snapshot.approvalQueue).toEqual([]);
    overlays.dispose();
  });

  it.each([
    { name: "reviewer", auth: { role: "operator", scopes: ["operator.approvals"] } },
    { name: "admin", auth: { role: "operator", scopes: ["operator.admin"] } },
    { name: "legacy operator", auth: { role: "operator" } },
  ])("loads pending approvals for a $name", async ({ auth }) => {
    const request = vi.fn<RequestFn>(() => Promise.resolve([]));
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway);

    harness.update({
      client: client(request),
      phase: "connected",
      hello: {
        server: { version: "1.0.0" },
        auth,
      } as ApplicationGatewaySnapshot["hello"],
    });
    await flushMicrotasks();

    expect(request).toHaveBeenCalledWith("exec.approval.list", {});
    expect(request).toHaveBeenCalledWith("plugin.approval.list", {});
    expect(request).toHaveBeenCalledWith("openclaw.approval.list", {});
    overlays.dispose();
  });

  it("discards pending approvals when access changes on the same client", async () => {
    const firstList = deferred();
    const secondList = deferred();
    let execListRequests = 0;
    const request = vi.fn<RequestFn>((method) => {
      if (method !== "exec.approval.list") {
        return Promise.resolve([]);
      }
      execListRequests += 1;
      return execListRequests === 1 ? firstList.promise : secondList.promise;
    });
    const gatewayClient = client(request);
    const harness = createGatewayHarness(null, false);
    const overlays = createApplicationOverlays(harness.gateway);

    harness.update({
      client: gatewayClient,
      phase: "connected",
      hello: {
        server: { version: "1.0.0" },
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    expect(execListRequests).toBe(1);

    harness.update({
      hello: {
        server: { version: "1.0.0" },
        auth: { role: "operator", scopes: ["operator.read"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    expect(overlays.snapshot.approvalQueue).toEqual([]);
    expect(execListRequests).toBe(1);

    harness.update({
      hello: {
        server: { version: "1.0.0" },
        auth: { role: "operator", scopes: ["operator.admin"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    expect(execListRequests).toBe(2);

    secondList.resolve([approval("approval-current", 2_000)]);
    await vi.waitFor(() => {
      expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual([
        "approval-current",
      ]);
    });

    firstList.resolve([approval("approval-stale", 1_000)]);
    await flushMicrotasks();
    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual(["approval-current"]);
    overlays.dispose();
  });

  it("rejects a retained approval action after same-client approval access is revoked", async () => {
    const request = vi.fn<RequestFn>((method) =>
      Promise.resolve(method.endsWith(".list") ? [] : { ok: true }),
    );
    const harness = createGatewayHarness(client(request));
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const overlays = createApplicationOverlays(harness.gateway);
    await flushMicrotasks();
    harness.emitApproval("approval-retired", 1_000);

    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await overlays.decideApproval("allow-once", "approval-retired");

    expect(overlays.snapshot.approvalQueue).toEqual([]);
    expect(request.mock.calls.some(([method]) => method === "exec.approval.resolve")).toBe(false);
    overlays.dispose();
  });

  it("does not let a revoked approval decision release a restored decision", async () => {
    const staleResolution = deferred();
    const currentResolution = deferred();
    let resolutionCount = 0;
    const request = vi.fn<RequestFn>((method) => {
      if (method.endsWith(".list")) {
        return Promise.resolve([]);
      }
      resolutionCount += 1;
      return resolutionCount === 1 ? staleResolution.promise : currentResolution.promise;
    });
    const harness = createGatewayHarness(client(request));
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const overlays = createApplicationOverlays(harness.gateway);
    await flushMicrotasks();
    harness.emitApproval("approval-stale", 1_000);
    const staleDecision = overlays.decideApproval("allow-once");

    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await flushMicrotasks();
    harness.emitApproval("approval-current", 2_000);
    const currentDecision = overlays.decideApproval("deny");

    staleResolution.resolve({ ok: true });
    await staleDecision;
    expect(overlays.snapshot.approvalBusy).toBe(true);
    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual(["approval-current"]);

    currentResolution.resolve({ ok: true });
    await currentDecision;
    expect(overlays.snapshot.approvalBusy).toBe(false);
    expect(overlays.snapshot.approvalQueue).toEqual([]);
    overlays.dispose();
  });

  it("retires a grant-only downgrade without clearing the readable approval queue", async () => {
    const staleResolution = deferred();
    const currentResolution = deferred();
    let resolutionCount = 0;
    const request = vi.fn<RequestFn>((method) => {
      if (method.endsWith(".list")) {
        return Promise.resolve([]);
      }
      resolutionCount += 1;
      return resolutionCount === 1 ? staleResolution.promise : currentResolution.promise;
    });
    const harness = createGatewayHarness(client(request));
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const overlays = createApplicationOverlays(harness.gateway);
    await flushMicrotasks();
    harness.emitApproval("approval-stale-grant", 1_000);
    const staleDecision = overlays.decideApproval("allow-once", "approval-stale-grant");

    harness.update({ hello: null });
    expect(overlays.snapshot.approvalBusy).toBe(false);
    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual([
      "approval-stale-grant",
    ]);
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.approvals"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    harness.emitApproval("approval-current-grant", 2_000);
    const currentDecision = overlays.decideApproval("deny", "approval-current-grant");

    staleResolution.resolve({ ok: true });
    await staleDecision;
    expect(overlays.snapshot.approvalBusy).toBe(true);
    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual([
      "approval-stale-grant",
      "approval-current-grant",
    ]);

    currentResolution.resolve({ ok: true });
    await currentDecision;
    expect(overlays.snapshot.approvalBusy).toBe(false);
    expect(overlays.snapshot.approvalQueue.map((entry) => entry.id)).toEqual([
      "approval-stale-grant",
    ]);
    overlays.dispose();
  });

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

    harness.update({ client: gatewayClient, phase: "stopped" });
    await flushMicrotasks();
    expect(request).not.toHaveBeenCalled();

    harness.update({ phase: "connected" });
    await flushMicrotasks();
    expect(execListRequests).toBe(1);
    expect(request).toHaveBeenCalledWith("exec.approval.list", {});
    expect(request).toHaveBeenCalledWith("plugin.approval.list", {});
    expect(request).toHaveBeenCalledWith("openclaw.approval.list", {});

    harness.update({ phase: "stopped" });
    expect(overlays.snapshot.approvalQueue).toEqual([]);
    harness.update({ phase: "connected" });
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
    harness.update({ client: null, phase: "stopped" });

    const newResolve = deferred();
    const newClient = client((method) =>
      method.endsWith(".list") ? Promise.resolve([]) : newResolve.promise,
    );
    harness.update({ client: newClient, phase: "connected" });
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
    harness.update({ phase: "stopped" });
    harness.update({ phase: "connected" });
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

registerOverlayPairingAccessTests();

describe("application update overlays", () => {
  it.each([
    { name: "read-only", scopes: ["operator.read"] },
    { name: "write-only", scopes: ["operator.write"] },
    { name: "approval-only", scopes: ["operator.approvals"] },
    { name: "explicitly ungranted", scopes: [] },
  ])("rejects an update request from a $name operator", async ({ scopes }) => {
    const request = vi.fn<RequestFn>(() => Promise.resolve({ ok: true }));
    const drainConfigWrites = vi.fn(async () => undefined);
    const harness = createGatewayHarness(client(request));
    harness.update({
      hello: { auth: { role: "operator", scopes } } as ApplicationGatewaySnapshot["hello"],
    });
    const overlays = createApplicationOverlays(harness.gateway, { drainConfigWrites });

    await overlays.runUpdate();

    expect(request).not.toHaveBeenCalledWith("update.run", {});
    expect(drainConfigWrites).not.toHaveBeenCalled();
    expect(overlays.snapshot.updateRunning).toBe(false);
    overlays.dispose();
  });

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
      harness.update({ phase: "stopped" });
      harness.update({ phase: "connected" });
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
