// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import {
  client,
  createGatewayHarness,
  deferred,
  flushMicrotasks,
  type RequestFn,
} from "./overlays-access.test-support.ts";
import type { ApplicationUpdateOverlayHooks } from "./overlays-updates.ts";
import { createApplicationOverlays } from "./overlays.ts";
import type { UpdateRestartStatusResponse } from "./update-overlay-helpers.ts";

const FAILURE = {
  kind: "update",
  status: "error",
  ts: 1_000,
  stats: {
    handoffId: "handoff-failed",
    reason: "build-failed",
    before: { version: "1.0.0" },
    after: { version: "2.0.0" },
    steps: [{ name: "build", log: { exitCode: 1, stderrTail: "Disk is full" } }],
  },
};
const STARTED = {
  ok: true,
  handoff: { status: "started" },
  result: { status: "skipped", reason: "managed-service-handoff-started" },
  sentinel: {
    payload: {
      kind: "update",
      status: "skipped",
      ts: 2_000,
      stats: { handoffId: "handoff-failed", reason: "managed-service-handoff-started" },
    },
  },
};
const CAMPAIGN = {
  channel: "stable",
  autoEnabled: true,
  campaign: {
    id: "automatic-attempt",
    state: "applying",
    announcedAtMs: 1_000,
    forceAtMs: 901_000,
    updatedAtMs: 61_000,
  },
};

function harnessFor(request: RequestFn) {
  const harness = createGatewayHarness(client(request));
  harness.update({
    hello: {
      auth: { role: "operator", scopes: ["operator.admin"] },
    } as ApplicationGatewaySnapshot["hello"],
  });
  return harness;
}

beforeEach(() => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("update failure triage admission", () => {
  it("carries the recorded failure once across polling, access changes, and reload", async () => {
    let status: UpdateRestartStatusResponse = {};
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "update.run") {
        status = { sentinel: FAILURE };
        return { ok: false, result: { status: "error" }, sentinel: { payload: FAILURE } };
      }
      return method === "update.status" ? status : {};
    });
    const harness = harnessFor(request);
    const administrator = harness.gateway.snapshot.hello;
    const readOnly = {
      auth: { role: "operator", scopes: ["operator.read"] },
    } as ApplicationGatewaySnapshot["hello"];
    const onUpdateFailure = vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>();
    const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
      await overlays.runUpdate();
      expect(onUpdateFailure).toHaveBeenCalledOnce();
      const [failure, admission] = onUpdateFailure.mock.calls[0] ?? [];
      expect(failure).toMatchObject({
        id: "handoff-failed",
        outcome: "failed",
        attempt: {
          reason: "build-failed",
          beforeVersion: "1.0.0",
          afterVersion: "2.0.0",
          failure: { step: "build", detail: "Disk is full" },
        },
      });
      // update.run still returns its outcome when sentinel persistence fails.
      // A later status read can therefore contain the previous attempt.
      const currentStatus = status;
      const currentBanner = overlays.snapshot.updateStatusBanner;
      for (const retainedStatus of ["ok", "error"]) {
        status = {
          sentinel: {
            ...FAILURE,
            status: retainedStatus,
            ts: 500,
            stats: { ...FAILURE.stats, handoffId: "previous-attempt" },
          },
        };
        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.updateStatusBanner).toEqual(currentBanner);
        expect(overlays.snapshot.recordedUpdateAttempt).toEqual(failure?.attempt);
        expect(admission?.isCurrent()).toBe(true);
        expect(onUpdateFailure).toHaveBeenCalledOnce();
      }
      status = currentStatus;
      expect(admission?.admit()).toBe(true);
      expect(admission?.admit()).toBe(false);
      await overlays.refreshUpdateStatus();
      expect(onUpdateFailure).toHaveBeenCalledOnce();
      harness.update({ hello: readOnly });
      expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();
      expect(overlays.snapshot.updateStatusBanner).toBeNull();
      expect(admission?.isCurrent()).toBe(false);
      harness.update({ hello: administrator });
      await overlays.refreshUpdateStatus();
      expect(onUpdateFailure).toHaveBeenCalledOnce();
    } finally {
      overlays.dispose();
    }
    for (const canAdmin of [false, true]) {
      harness.update({ hello: canAdmin ? administrator : readOnly });
      const nextFailure = vi.fn();
      const reloaded = createApplicationOverlays(harness.gateway, { onUpdateFailure: nextFailure });
      try {
        await flushMicrotasks();
        if (canAdmin) {
          expect(reloaded.snapshot.recordedUpdateAttempt?.reason).toBe("build-failed");
        } else {
          expect(reloaded.snapshot.recordedUpdateAttempt).toBeNull();
        }
        expect(nextFailure).not.toHaveBeenCalled();
        expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
      } finally {
        reloaded.dispose();
      }
    }
  });

  it.each(["Gateway", "profile"])(
    "does not repeat a consumed diagnosis after switching %s away, back, and reloading",
    async (boundary) => {
      const request = vi.fn<RequestFn>(async (method) =>
        method === "update.status" ? { sentinel: FAILURE } : {},
      );
      const harness = harnessFor(request);
      const firstGateway = harness.gateway.connection.gatewayUrl;
      const administrator = harness.gateway.snapshot.hello;
      const onUpdateFailure = vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>(
        (_failure, admission) => {
          expect(admission.admit()).toBe(true);
        },
      );
      let overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      const switchScope = (other: boolean) => {
        harness.gateway.connection.gatewayUrl =
          boundary === "Gateway" && other ? "ws://other.test" : firstGateway;
        harness.update({ phase: "connecting", client: null, hello: null });
        harness.update({
          phase: "connected",
          client: client(request),
          hello: administrator,
          selfUser:
            boundary === "profile" && other
              ? ({ id: "other" } as NonNullable<ApplicationGatewaySnapshot["selfUser"]>)
              : undefined,
        });
      };
      try {
        await flushMicrotasks();
        expect(onUpdateFailure).toHaveBeenCalledOnce();
        const firstAdmission = onUpdateFailure.mock.calls[0]?.[1];
        switchScope(true);
        expect(firstAdmission?.isCurrent()).toBe(false);
        await flushMicrotasks();
        expect(onUpdateFailure).toHaveBeenCalledTimes(2);

        switchScope(false);
        await flushMicrotasks();
        expect(onUpdateFailure).toHaveBeenCalledTimes(2);
        overlays.dispose();
        overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
        await flushMicrotasks();
        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("build-failed");
        expect(onUpdateFailure).toHaveBeenCalledTimes(2);
        expect(request.mock.calls.some(([method]) => method === "update.run")).toBe(false);
      } finally {
        overlays.dispose();
      }
    },
  );

  it.each(["automatic completion", "reconnect"])(
    "enters triage after %s reads a final failure",
    async (source) => {
      let status: UpdateRestartStatusResponse = {};
      const request = vi.fn<RequestFn>(async (method) =>
        method === "update.run" ? STARTED : status,
      );
      const harness = harnessFor(request);
      const onUpdateFailure = vi.fn();
      const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        if (source === "reconnect") {
          await overlays.runUpdate();
          harness.update({ phase: "reconnecting" });
        } else {
          harness.emitEvent("update.available", { schedule: CAMPAIGN });
        }
        expect(onUpdateFailure).not.toHaveBeenCalled();
        status = { sentinel: FAILURE };
        if (source === "reconnect") {
          harness.update({ phase: "connected" });
        } else {
          harness.emitEvent("update.available", {
            schedule: { channel: "stable", autoEnabled: true },
          });
        }
        await flushMicrotasks();
        expect(onUpdateFailure).toHaveBeenCalledOnce();
        expect(onUpdateFailure.mock.calls[0]?.[0]).toMatchObject({
          outcome: "failed",
          id: "handoff-failed",
        });
      } finally {
        overlays.dispose();
      }
    },
  );

  it("triages a rejected request without claiming the installation failed or replaying it", async () => {
    let status: UpdateRestartStatusResponse = {};
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "update.run") {
        throw new Error("RPC connection failed");
      }
      return status;
    });
    const harness = harnessFor(request);
    const onUpdateFailure = vi.fn();
    const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
      await flushMicrotasks();
      harness.emitEvent("update.available", {
        updateAvailable: { channel: "stable", currentVersion: "1.0.0", latestVersion: "2.0.0" },
      });
      await overlays.runUpdate();
      expect(onUpdateFailure).toHaveBeenCalledOnce();
      expect(onUpdateFailure.mock.calls[0]?.[0]).toMatchObject({
        outcome: "unknown",
        attempt: null,
      });
      expect(overlays.snapshot.updateStatusBanner?.text).toContain("openclaw triage");
      const banner = overlays.snapshot.updateStatusBanner;
      const admission = onUpdateFailure.mock.calls[0]?.[1];
      status = {
        sentinel: {
          kind: "update",
          status: "ok",
          ts: 1_000,
          stats: { after: { version: "1.0.0" } },
        },
      };
      await overlays.refreshUpdateStatus();
      expect(overlays.snapshot.updateStatusBanner).toEqual(banner);
      expect(admission.isCurrent()).toBe(true);
      expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
      expect(onUpdateFailure).toHaveBeenCalledOnce();
    } finally {
      overlays.dispose();
    }
  });

  it("reports a preparation failure locally without dispatching or triaging an update", async () => {
    const request = vi.fn<RequestFn>(async () => ({}));
    const drainConfigWrites = vi.fn(async () => {
      throw new Error("Config preparation failed");
    });
    const harness = harnessFor(request);
    const onUpdateFailure = vi.fn();
    const overlays = createApplicationOverlays(harness.gateway, {
      drainConfigWrites,
      onUpdateFailure,
    });
    try {
      await overlays.runUpdate();

      expect(request.mock.calls.some(([method]) => method === "update.run")).toBe(false);
      expect(overlays.snapshot.updateRunning).toBe(false);
      expect(overlays.snapshot.updateReconciliationPending).toBe(false);
      expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();
      expect(overlays.snapshot.updateStatusBanner?.text).toContain("Config preparation failed");
      expect(overlays.snapshot.updateStatusBanner?.text).not.toContain("outcome is unknown");
      expect(onUpdateFailure).not.toHaveBeenCalled();
    } finally {
      overlays.dispose();
    }
  });

  it.each(["handoff", "timestamp"])(
    "retains a verified mismatch with %s identity until a newer recorded attempt",
    async (identity) => {
      let status: UpdateRestartStatusResponse = {};
      const started = {
        ...STARTED,
        ...(identity === "timestamp"
          ? { result: { status: "ok", after: { version: "2.0.0" } }, handoff: undefined }
          : {}),
        sentinel:
          identity === "handoff"
            ? STARTED.sentinel
            : identity === "timestamp"
              ? {
                  payload: {
                    kind: "update",
                    status: "ok",
                    ts: 2_000,
                    stats: { after: { version: "2.0.0" } },
                  },
                }
              : undefined,
      };
      const request = vi.fn<RequestFn>(async (method) =>
        method === "update.run" ? started : method === "update.status" ? status : {},
      );
      const harness = harnessFor(request);
      const onUpdateFailure =
        vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>();
      const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        await flushMicrotasks();
        harness.emitEvent("update.available", {
          updateAvailable: { channel: "stable", currentVersion: "1.0.0", latestVersion: "2.0.0" },
        });
        await overlays.runUpdate();
        harness.update({ phase: "reconnecting" });
        status = {
          sentinel: {
            kind: "update",
            status: "ok",
            ts: 2_000,
            stats: {
              handoffId: identity === "handoff" ? "handoff-failed" : undefined,
              after: { version: "1.0.0" },
            },
          },
        };
        harness.update({ phase: "connected" });
        await flushMicrotasks();
        expect(overlays.snapshot.updateReconciliationPending).toBe(false);
        expect(overlays.snapshot.updateStatusBanner?.text).toContain(
          "Expected v2.0.0, running v1.0.0",
        );
        const admission = onUpdateFailure.mock.calls[0]?.[1];

        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.updateStatusBanner?.text).toContain(
          "Expected v2.0.0, running v1.0.0",
        );
        expect(admission?.isCurrent()).toBe(true);
        expect(onUpdateFailure).toHaveBeenCalledOnce();

        status = {
          sentinel: {
            kind: "update",
            status: "ok",
            ts: 1_000,
            stats: { handoffId: "older-attempt", after: { version: "2.0.0" } },
          },
        };
        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.updateStatusBanner?.text).toContain(
          "Expected v2.0.0, running v1.0.0",
        );
        expect(admission?.isCurrent()).toBe(true);

        status = {
          sentinel: { kind: "update", status: "ok", stats: { after: { version: "1.0.0" } } },
        };
        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.updateStatusBanner?.text).toContain(
          "Expected v2.0.0, running v1.0.0",
        );
        expect(admission?.isCurrent()).toBe(true);

        expect(admission?.admit()).toBe(true);
        if (identity === "handoff") {
          status = { sentinel: { ...FAILURE, ts: 2_500 } };
          await overlays.refreshUpdateStatus();
          expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("build-failed");
          expect(overlays.snapshot.updateStatusBanner?.text).toContain("Disk is full");
          expect(admission?.isCurrent()).toBe(true);
          expect(onUpdateFailure).toHaveBeenCalledOnce();
        }
        if (identity === "timestamp") {
          // Restart health rewrites status/reason without changing this attempt's timestamp.
          status = {
            sentinel: {
              kind: "update",
              status: "error",
              ts: 2_000,
              stats: { reason: "restart-unhealthy", after: { version: "1.0.0" } },
            },
          };
          await overlays.refreshUpdateStatus();
          expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("restart-unhealthy");
          expect(overlays.snapshot.updateStatusBanner?.text).not.toContain("Expected v2.0.0");
          expect(onUpdateFailure).toHaveBeenCalledOnce();
        }

        status = {
          sentinel: {
            ...STARTED.sentinel.payload,
            ts: 3_000,
            stats: { ...STARTED.sentinel.payload.stats, handoffId: "newer-attempt" },
          },
        };
        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.updateStatusBanner).toBeNull();
        expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();
        expect(admission?.isCurrent()).toBe(false);
        expect(onUpdateFailure).toHaveBeenCalledOnce();

        status = {
          sentinel: {
            kind: "update",
            status: "ok",
            ts: 3_000,
            stats: { handoffId: "newer-attempt", after: { version: "2.0.0" } },
          },
        };
        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.updateStatusBanner).toBeNull();
        expect(admission?.isCurrent()).toBe(false);
        expect(onUpdateFailure).toHaveBeenCalledOnce();
        expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
      } finally {
        overlays.dispose();
      }
    },
  );

  it.each([
    { retainedStatus: "error", expectedVersion: "2.0.0" },
    { retainedStatus: "skipped", expectedVersion: "2.0.0" },
    { retainedStatus: "ok", expectedVersion: "2.0.0" },
    { retainedStatus: "ok", expectedVersion: null },
  ])(
    "does not correlate a retained $retainedStatus result (target=$expectedVersion) with a reloaded request that lost its response",
    async ({ retainedStatus, expectedVersion }) => {
      const response = deferred();
      let status: UpdateRestartStatusResponse = {};
      const request = vi.fn<RequestFn>((method) =>
        method === "update.run" ? response.promise : Promise.resolve(status),
      );
      const harness = harnessFor(request);
      const onUpdateFailure =
        vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>();
      let overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        if (expectedVersion) {
          harness.emitEvent("update.available", {
            updateAvailable: { channel: "stable", currentVersion: "1.0.0", latestVersion: "2.0.0" },
          });
        }
        const running = overlays.runUpdate();
        await flushMicrotasks();
        overlays.dispose();
        response.resolve(STARTED);
        await running;
        status = {
          sentinel: {
            kind: "update",
            status: retainedStatus,
            ts: 1_000,
            stats: {
              reason:
                retainedStatus === "error"
                  ? "build-failed"
                  : retainedStatus === "skipped"
                    ? "already-current"
                    : undefined,
              after: { version: "1.0.0" },
            },
          },
        };
        overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
        await flushMicrotasks();
        expect(overlays.snapshot.updateReconciliationPending).toBe(true);
        expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();
        expect(onUpdateFailure).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(10_000);
        expect(onUpdateFailure).toHaveBeenCalledOnce();
        const [failure, admission] = onUpdateFailure.mock.calls[0]!;
        expect(failure.outcome).toBe("unknown");
        expect(admission.admit()).toBe(true);
        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();
        expect(overlays.snapshot.updateStatusBanner?.text).toContain("outcome is unknown");
        expect(admission.isCurrent()).toBe(true);
        expect(onUpdateFailure).toHaveBeenCalledOnce();

        status = {
          sentinel: {
            kind: "update",
            status: "ok",
            ts: 2_000,
            stats: { after: { version: "2.0.0" } },
          },
        };
        await overlays.refreshUpdateStatus();
        if (expectedVersion) {
          expect(overlays.snapshot.updateStatusBanner).toBeNull();
          expect(admission.isCurrent()).toBe(false);
        } else {
          expect(overlays.snapshot.updateStatusBanner?.text).toContain("outcome is unknown");
          expect(admission.isCurrent()).toBe(true);
        }
        expect(onUpdateFailure).toHaveBeenCalledOnce();
        expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
      } finally {
        response.resolve({});
        overlays.dispose();
      }
    },
  );

  it.each([
    { observed: false, terminal: "failed" },
    { observed: true, terminal: "failed" },
    { observed: false, terminal: "cancelled" },
    { observed: true, terminal: "cancelled" },
    { observed: false, terminal: "newer failure" },
    { observed: true, terminal: "newer failure" },
    { observed: false, terminal: "newer success" },
    { observed: true, terminal: "newer success" },
  ])(
    "settles an offline timeout with $terminal (observed=$observed)",
    async ({ observed, terminal }) => {
      let status: UpdateRestartStatusResponse = {};
      const request = vi.fn(async (method) => (method === "update.run" ? STARTED : status));
      const harness = harnessFor(request);
      const administrator = harness.gateway.snapshot.hello;
      const onUpdateFailure = vi.fn();
      let overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        await overlays.runUpdate();
        if (!observed) {
          overlays.dispose();
          overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
        }
        if (observed) {
          status = {
            sentinel: {
              kind: "update",
              status: "skipped",
              ts: 2_000,
              stats: {
                handoffId: "handoff-failed",
                reason: "managed-service-handoff-started",
              },
            },
          };
          harness.update({ phase: "reconnecting" });
          harness.update({ phase: "connected" });
          await flushMicrotasks();
        }
        harness.update({ phase: "reconnecting", hello: null });
        await vi.advanceTimersByTimeAsync(35 * 60_000);
        expect(onUpdateFailure).toHaveBeenCalledOnce();
        const [failure, admission] = onUpdateFailure.mock.calls[0] ?? [];
        expect(failure.outcome).toBe("unknown");
        expect(admission.admit()).toBe(false);
        expect(overlays.snapshot.updateStatusBanner?.text).toContain("outcome is unknown");
        expect(overlays.snapshot.updateStatusBanner?.text).toContain("openclaw triage");
        status = {
          sentinel: { ...FAILURE, stats: { ...FAILURE.stats, handoffId: "older-handoff" } },
        };
        harness.update({ phase: "connected", hello: administrator });
        await flushMicrotasks();
        expect(onUpdateFailure).toHaveBeenCalledTimes(2);
        expect(overlays.snapshot.updateStatusBanner?.text).toContain("outcome is unknown");
        expect(onUpdateFailure.mock.calls[1]?.[1].admit()).toBe(true);
        const newer = terminal.startsWith("newer");
        status = {
          sentinel: {
            ...FAILURE,
            ts: newer ? 3_000 : 2_000,
            status:
              terminal === "cancelled" ? "skipped" : terminal === "newer success" ? "ok" : "error",
            stats: {
              ...FAILURE.stats,
              handoffId: newer ? "newer-handoff" : "handoff-failed",
              reason:
                terminal === "cancelled" ? "managed-service-handoff-cancelled" : "build-failed",
            },
          },
        };
        await overlays.refreshUpdateStatus();
        if (terminal === "newer success") {
          expect(overlays.snapshot.updateStatusBanner).toBeNull();
        } else {
          expect(overlays.snapshot.updateStatusBanner?.text).not.toContain("outcome is unknown");
        }
        if (terminal === "failed" || terminal === "newer failure") {
          expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("build-failed");
          expect(overlays.snapshot.updateStatusBanner?.text).toContain("Disk is full");
        } else {
          expect(admission.isCurrent()).toBe(false);
        }
        expect(onUpdateFailure).toHaveBeenCalledTimes(terminal === "newer failure" ? 3 : 2);
        if (terminal === "newer failure") {
          expect(onUpdateFailure.mock.calls[2]?.[1].admit()).toBe(true);
        }
        expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
      } finally {
        overlays.dispose();
      }
    },
  );

  it.each(["restart", "handoff"])(
    "retains an unknown %s outcome across stale status reads until identity is verified",
    async (kind) => {
      let status: UpdateRestartStatusResponse = {};
      const request = vi.fn<RequestFn>(async (method) =>
        method === "update.run"
          ? kind === "handoff"
            ? STARTED
            : {
                ok: true,
                result: { status: "ok", after: { version: "2.0.0" } },
                sentinel: {
                  payload: {
                    kind: "update",
                    status: "ok",
                    ts: 2_000,
                    stats: { after: { version: "2.0.0" } },
                  },
                },
              }
          : status,
      );
      const harness = harnessFor(request);
      const onUpdateFailure =
        vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>();
      const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        await flushMicrotasks();
        harness.emitEvent("update.available", {
          updateAvailable: { channel: "stable", currentVersion: "1.0.0", latestVersion: "2.0.0" },
        });
        await overlays.runUpdate();
        harness.update({ phase: "reconnecting" });
        status = {
          sentinel: {
            kind: "update",
            status: "ok",
            ts: 2_000,
            stats: { handoffId: kind === "handoff" ? "handoff-failed" : undefined },
          },
        };
        harness.update({ phase: "connected" });
        await vi.advanceTimersByTimeAsync(kind === "handoff" ? 35 * 60_000 : 10_000);
        expect(overlays.snapshot.updateReconciliationPending).toBe(false);
        expect(onUpdateFailure).toHaveBeenCalledOnce();
        expect(onUpdateFailure.mock.calls[0]?.[0].outcome).toBe("unknown");
        const admission = onUpdateFailure.mock.calls[0]?.[1];
        const banner = overlays.snapshot.updateStatusBanner;

        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.updateStatusBanner).toEqual(banner);
        expect(admission?.isCurrent()).toBe(true);
        expect(onUpdateFailure).toHaveBeenCalledOnce();

        status = {
          sentinel: { ...status.sentinel, ts: 3_000 },
        };
        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.updateStatusBanner).toEqual(banner);
        expect(admission?.isCurrent()).toBe(true);

        status = {
          sentinel: {
            ...status.sentinel,
            ts: 4_000,
            stats: { ...status.sentinel?.stats, after: { version: "2.0.0" } },
          },
        };
        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.updateStatusBanner).toBeNull();
        expect(admission?.isCurrent()).toBe(false);
        expect(onUpdateFailure).toHaveBeenCalledOnce();
        expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
      } finally {
        overlays.dispose();
      }
    },
  );

  it("keeps a learned handoff identity when the update response is lost", async () => {
    const response = deferred();
    let status: UpdateRestartStatusResponse = {};
    const request = vi.fn<RequestFn>((method) =>
      method === "update.run" ? response.promise : Promise.resolve(status),
    );
    const harness = harnessFor(request);
    const onUpdateFailure = vi.fn();
    const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
      const running = overlays.runUpdate();
      await flushMicrotasks();
      harness.update({ phase: "reconnecting" });
      response.resolve(STARTED);
      await running;
      status = { sentinel: STARTED.sentinel.payload };
      harness.update({ phase: "connected" });
      await vi.advanceTimersByTimeAsync(35 * 60_000);
      expect(onUpdateFailure).toHaveBeenCalledOnce();
      expect(onUpdateFailure.mock.calls[0]?.[0]).toMatchObject({
        id: "handoff-failed",
        outcome: "unknown",
      });
      expect(onUpdateFailure.mock.calls[0]?.[1].admit()).toBe(true);

      status = { sentinel: { ...FAILURE, ts: 2_000 } };
      await overlays.refreshUpdateStatus();
      expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("build-failed");
      expect(onUpdateFailure).toHaveBeenCalledOnce();
      expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
    } finally {
      response.resolve({});
      overlays.dispose();
    }
  });

  it("retains a learned server record when reloading the previous bundle's flat notice", async () => {
    sessionStorage.setItem(
      "openclaw:control-ui:update:v1",
      JSON.stringify({
        gateway: "ws://gateway.test",
        profileId: null,
        kind: "handoff",
        expectedVersion: "2.0.0",
        expectedSha: null,
        handoffId: "handoff-failed",
        deadlineAtMs: Date.now() + 1_000,
      }),
    );
    let status: UpdateRestartStatusResponse = { sentinel: STARTED.sentinel.payload };
    const request = vi.fn<RequestFn>(async () => status);
    const harness = harnessFor(request);
    const administrator = harness.gateway.snapshot.hello;
    const onUpdateFailure = vi.fn();
    let overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
      await flushMicrotasks();
      overlays.dispose();
      harness.update({ phase: "offline", hello: null, selfUser: null });
      overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      await vi.advanceTimersByTimeAsync(1_000);
      status = {
        sentinel: {
          ...FAILURE,
          ts: 3_000,
          stats: { ...FAILURE.stats, handoffId: "newer-handoff" },
        },
      };
      harness.update({ phase: "connected", hello: administrator });
      await flushMicrotasks();
      expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("build-failed");
      expect(overlays.snapshot.updateStatusBanner?.text).toContain("Disk is full");
      expect(onUpdateFailure.mock.calls.at(-1)?.[0].id).toBe("newer-handoff");
      expect(request.mock.calls.some(([method]) => method === "update.run")).toBe(false);
    } finally {
      overlays.dispose();
    }
  });

  it.each(["operator", "other"])(
    "keeps an offline restored timeout bound to its saved profile when %s reconnects",
    async (profileId) => {
      sessionStorage.setItem(
        "openclaw:control-ui:update:v1",
        JSON.stringify({
          gateway: "ws://gateway.test",
          profileId: "operator",
          kind: "handoff",
          expectedVersion: "2.0.0",
          expectedSha: null,
          handoffId: "handoff-failed",
          deadlineAtMs: Date.now(),
        }),
      );
      const request = vi.fn<RequestFn>(async () => ({ sentinel: STARTED.sentinel.payload }));
      const harness = harnessFor(request);
      const administrator = harness.gateway.snapshot.hello;
      harness.update({ phase: "offline", hello: null, selfUser: null });
      const diagnosed: string[] = [];
      const overlays = createApplicationOverlays(harness.gateway, {
        onUpdateFailure: (failure, admission) => {
          if (admission.admit()) {
            diagnosed.push(failure.id);
          }
        },
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(overlays.snapshot.updateStatusBanner?.text).toContain("outcome is unknown");
        expect(diagnosed).toEqual([]);
        harness.update({
          phase: "connected",
          hello: administrator,
          selfUser: { id: profileId } as NonNullable<ApplicationGatewaySnapshot["selfUser"]>,
        });
        await flushMicrotasks();
        expect(diagnosed).toEqual(profileId === "operator" ? ["handoff-failed"] : []);
        expect(request.mock.calls.some(([method]) => method === "update.run")).toBe(false);
      } finally {
        overlays.dispose();
      }
    },
  );

  it.each(["failed", "cancelled", "newer success"])(
    "orders %s records after an unidentified restart times out",
    async (terminal) => {
      let status: UpdateRestartStatusResponse = {};
      const request = vi.fn<RequestFn>(async (method) =>
        method === "update.run"
          ? {
              ok: true,
              result: { status: "ok", after: { version: "2.0.0" } },
              sentinel: {
                payload: {
                  kind: "update",
                  status: "ok",
                  ts: 2_000,
                  stats: { after: { version: "2.0.0" } },
                },
              },
            }
          : status,
      );
      const harness = harnessFor(request);
      const onUpdateFailure = vi.fn();
      const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        harness.emitEvent("update.available", {
          updateAvailable: { channel: "stable", currentVersion: "1.0.0", latestVersion: "2.0.0" },
        });
        await overlays.runUpdate();
        harness.update({ phase: "reconnecting" });
        status = { sentinel: { kind: "update", status: "ok", ts: 2_000 } };
        harness.update({ phase: "connected" });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(onUpdateFailure).toHaveBeenCalledOnce();
        const admission = onUpdateFailure.mock.calls[0]?.[1];
        status = {
          sentinel: {
            kind: "update",
            ts: terminal === "newer success" ? 3_000 : 1_000,
            status: terminal === "failed" ? "error" : terminal === "cancelled" ? "skipped" : "ok",
            stats: {
              reason:
                terminal === "cancelled" ? "managed-service-handoff-cancelled" : "build-failed",
              after: { version: "3.0.0" },
            },
          },
        };
        await overlays.refreshUpdateStatus();
        if (terminal === "newer success") {
          expect(overlays.snapshot.updateStatusBanner).toBeNull();
          expect(admission.isCurrent()).toBe(false);
        } else {
          expect(overlays.snapshot.updateStatusBanner?.text).toContain("outcome is unknown");
          expect(admission.isCurrent()).toBe(true);
        }
        expect(onUpdateFailure).toHaveBeenCalledOnce();
        expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
      } finally {
        overlays.dispose();
      }
    },
  );

  it.each([
    { status: "ok", reason: undefined },
    { status: "skipped", reason: "managed-service-handoff-started" },
    { status: "skipped", reason: "restart-health-pending" },
    { status: "skipped", reason: "already-current" },
    { status: "skipped", reason: "managed-service-handoff-already-running" },
    { status: "skipped", reason: "managed-service-handoff-cancelled" },
  ])("never triages $status / $reason", async (result) => {
    const harness = harnessFor(
      vi.fn(async (method) =>
        method === "update.run"
          ? { ok: result.status === "ok", result }
          : { sentinel: { ...FAILURE, status: result.status, stats: { reason: result.reason } } },
      ),
    );
    const onUpdateFailure = vi.fn();
    const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
      await flushMicrotasks();
      await overlays.runUpdate();
      expect(onUpdateFailure).not.toHaveBeenCalled();
    } finally {
      overlays.dispose();
    }
  });

  it("does not treat failed status or hold requests as a failed update", async () => {
    let failStatus = false;
    const harness = harnessFor(
      vi.fn(async (method) => {
        if (method === "update.hold" || (method === "update.status" && failStatus)) {
          throw new Error("Unavailable");
        }
        return {};
      }),
    );
    const onUpdateFailure = vi.fn();
    const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
      await flushMicrotasks();
      failStatus = true;
      await overlays.refreshUpdateStatus();
      harness.emitEvent("update.available", {
        schedule: {
          ...CAMPAIGN,
          campaign: { ...CAMPAIGN.campaign, state: "countdown", applyAtMs: Date.now() + 60_000 },
        },
      });
      await overlays.holdUpdate();
      expect(onUpdateFailure).not.toHaveBeenCalled();
    } finally {
      overlays.dispose();
    }
  });

  it.each(["Gateway", "profile", "administrator", "new attempt", "dispose"])(
    "retires a pending triage handoff after changing %s",
    async (boundary) => {
      const harness = harnessFor(vi.fn(async () => ({ sentinel: FAILURE })));
      const onUpdateFailure = vi.fn();
      const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        await flushMicrotasks();
        const admission = onUpdateFailure.mock.calls[0]?.[1];
        if (boundary === "Gateway") {
          harness.gateway.connection.gatewayUrl = "ws://other.test";
        } else if (boundary === "profile") {
          harness.update({
            selfUser: { id: "other" } as NonNullable<ApplicationGatewaySnapshot["selfUser"]>,
          });
        } else if (boundary === "administrator") {
          harness.update({
            hello: {
              auth: { role: "operator", scopes: ["operator.read"] },
            } as ApplicationGatewaySnapshot["hello"],
          });
        } else if (boundary === "new attempt") {
          await overlays.runUpdate();
        } else {
          overlays.dispose();
        }
        expect(admission.isCurrent()).toBe(false);
        expect(admission.admit()).toBe(false);
      } finally {
        overlays.dispose();
      }
    },
  );
});
