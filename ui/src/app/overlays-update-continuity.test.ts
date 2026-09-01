// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as buildInfo from "../build-info.ts";
import { showToast } from "../lib/toast.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import {
  client,
  createGatewayHarness,
  deferred,
  flushMicrotasks,
  type RequestFn,
} from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";
import type { UpdateRestartStatusResponse } from "./update-overlay-helpers.ts";

vi.mock("../lib/toast.ts", () => ({ showToast: vi.fn() }));

const HANDOFF_MS = 35 * 60_000;
const HANDOFF_ID = "handoff-current";
const HANDOFF_RESPONSE = {
  ok: true,
  handoff: { status: "started" },
  result: { status: "skipped", reason: "managed-service-handoff-started" },
  sentinel: {
    payload: {
      kind: "update",
      status: "skipped",
      ts: 2_000,
      stats: { handoffId: HANDOFF_ID, reason: "managed-service-handoff-started" },
    },
  },
};
const HANDOFF_PENDING = {
  sentinel: {
    kind: "update",
    status: "skipped",
    stats: { handoffId: HANDOFF_ID, reason: "managed-service-handoff-started" },
  },
};
const HANDOFF_SUCCESS = {
  sentinel: {
    kind: "update",
    status: "ok",
    stats: { handoffId: HANDOFF_ID, after: { version: "2.0.0" } },
  },
};

function createUpdateHarness(request: RequestFn) {
  const harness = createGatewayHarness(client(request));
  const hello = {
    auth: { role: "operator", scopes: ["operator.admin"] },
    server: { version: "1.0.0" },
    snapshot: {
      updateAvailable: { channel: "stable", currentVersion: "1.0.0", latestVersion: "2.0.0" },
    },
  };
  harness.update({ hello: hello as ApplicationGatewaySnapshot["hello"] });
  return { ...harness, hello };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.mocked(showToast).mockClear();
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
  vi.restoreAllMocks();
});

describe("application update attempt continuity", () => {
  it.each(["status", "retained status", "event", "hello"] as const)(
    "retires a previous failure when an applying campaign arrives through %s",
    async (source) => {
      const failure = {
        kind: "update",
        status: "error",
        ts: 1_000,
        stats: { handoffId: "previous-attempt", reason: "build-failed" },
      };
      const schedule = {
        channel: "stable",
        autoEnabled: true,
        target: { kind: "package", version: "3.0.0" },
        campaign: {
          id: "next-campaign",
          state: "applying",
          announcedAtMs: 2_000,
          forceAtMs: 902_000,
          updatedAtMs: 62_000,
        },
      } as const;
      let response: UpdateRestartStatusResponse = { sentinel: null };
      let failStatus = false;
      const request = vi.fn<RequestFn>(async (method) => {
        if (method === "update.run") {
          return { ok: false, result: { status: "error" }, sentinel: { payload: failure } };
        }
        if (method === "update.status" && failStatus) {
          throw new Error("Status request unavailable");
        }
        return method === "update.status" ? response : {};
      });
      const harness = createUpdateHarness(request);
      const onUpdateFailure = vi.fn();
      const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        await flushMicrotasks();
        await overlays.runUpdate();
        expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("build-failed");
        expect(onUpdateFailure).toHaveBeenCalledOnce();
        const admission = onUpdateFailure.mock.calls[0]?.[1];

        // The RPC reports failures even when persistence fails; applying is
        // published before the next update writes a sentinel.
        response = { sentinel: source === "retained status" ? failure : null, schedule };
        if (source === "status" || source === "retained status") {
          await overlays.refreshUpdateStatus();
        } else if (source === "event") {
          harness.emitEvent("update.available", { schedule });
        } else {
          const hello = harness.hello;
          harness.update({ phase: "reconnecting" });
          harness.update({
            phase: "connected",
            hello: {
              ...hello,
              snapshot: { ...hello.snapshot, updateSchedule: schedule },
            } as ApplicationGatewaySnapshot["hello"],
          });
          await flushMicrotasks();
        }
        expect(overlays.snapshot.updateRunning).toBe(true);
        expect(overlays.snapshot.updateStatusBanner).toBeNull();
        expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();
        expect(admission.isCurrent()).toBe(false);
        expect(admission.admit()).toBe(false);
        expect(onUpdateFailure).toHaveBeenCalledOnce();

        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.updateStatusBanner).toBeNull();
        expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();
        expect(onUpdateFailure).toHaveBeenCalledOnce();

        failStatus = true;
        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.updateStatusBanner?.text).toContain("Status request unavailable");
        failStatus = false;
        response = {
          sentinel: {
            ...failure,
            ts: 63_000,
            stats: { handoffId: "next-attempt", reason: "deps-install-failed" },
          },
          schedule: { channel: "stable", autoEnabled: true },
        };
        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.updateRunning).toBe(false);
        expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("deps-install-failed");
        expect(onUpdateFailure).toHaveBeenCalledTimes(2);
        expect(admission.isCurrent()).toBe(false);
        expect(onUpdateFailure.mock.calls[1]?.[1].admit()).toBe(true);
        expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
      } finally {
        overlays.dispose();
      }
    },
  );

  it.each(["timeout", "failure"] as const)(
    "preserves a verifier %s while the observed campaign still applies",
    async (outcome) => {
      const schedule = {
        channel: "stable",
        autoEnabled: true,
        campaign: {
          id: "active-campaign",
          state: "applying",
          announcedAtMs: 1_000,
          forceAtMs: 2_000,
          updatedAtMs: 2_000,
        },
      } as const;
      let response: UpdateRestartStatusResponse = HANDOFF_PENDING;
      const request = vi.fn<RequestFn>(async (method) =>
        method === "update.run" ? HANDOFF_RESPONSE : response,
      );
      const harness = createUpdateHarness(request);
      const onUpdateFailure = vi.fn();
      const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        await overlays.runUpdate();
        harness.update({ phase: "reconnecting" });
        harness.update({ phase: "connected" });
        await flushMicrotasks();
        harness.emitEvent("update.available", { schedule });
        if (outcome === "failure") {
          response = {
            sentinel: {
              ...HANDOFF_RESPONSE.sentinel.payload,
              status: "error",
              stats: { handoffId: HANDOFF_ID, reason: "build-failed" },
            },
          };
        }
        await vi.advanceTimersByTimeAsync(outcome === "timeout" ? HANDOFF_MS : 1_000);

        expect(overlays.snapshot.updateReconciliationPending).toBe(false);
        expect(overlays.snapshot.updateStatusBanner?.tone).toBe("danger");
        expect(onUpdateFailure).not.toHaveBeenCalled();
        // An observed applying campaign still owns the install interlock.
        expect(overlays.snapshot.updateRunning).toBe(true);

        const banner = overlays.snapshot.updateStatusBanner;
        response = { ...response, schedule };
        harness.emitEvent("update.available", { schedule });
        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.updateStatusBanner).toEqual(banner);
        expect(onUpdateFailure).not.toHaveBeenCalled();

        response = { ...response, schedule: { channel: "stable", autoEnabled: true } };
        harness.emitEvent("update.available", { schedule: response.schedule });
        await flushMicrotasks();
        expect(overlays.snapshot.updateRunning).toBe(false);
        expect(onUpdateFailure).toHaveBeenCalledOnce();
        const [failure, admission] = onUpdateFailure.mock.calls[0]!;
        expect(failure.outcome).toBe(outcome === "timeout" ? "unknown" : "failed");
        expect(admission.isCurrent()).toBe(true);
        expect(admission.admit()).toBe(true);
        expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
      } finally {
        overlays.dispose();
      }
    },
  );

  it("ends the waiting state when a failed-closed Gateway never reconnects", async () => {
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.run" ? HANDOFF_RESPONSE : {},
    );
    const harness = createUpdateHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await overlays.runUpdate();
      harness.update({ phase: "reconnecting", hello: null });
      expect(overlays.snapshot.updateReconciliationPending).toBe(true);

      await vi.advanceTimersByTimeAsync(HANDOFF_MS);

      expect(overlays.snapshot.updateReconciliationPending).toBe(false);
      expect(overlays.snapshot.updateRunning).toBe(false);
      expect(overlays.snapshot.updateStatusBanner).toMatchObject({ tone: "danger" });
      expect(overlays.snapshot.updateStatusBanner?.text).toContain("openclaw triage");
      expect(showToast).not.toHaveBeenCalled();
    } finally {
      overlays.dispose();
    }
  });

  it("does not grant another handoff budget on a late reconnect", async () => {
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.run"
        ? HANDOFF_RESPONSE
        : method === "update.status"
          ? HANDOFF_PENDING
          : {},
    );
    const harness = createUpdateHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await overlays.runUpdate();
      harness.update({ phase: "reconnecting", hello: null });
      await vi.advanceTimersByTimeAsync(HANDOFF_MS - 1_000);
      harness.update({ phase: "connected" });
      await flushMicrotasks();
      expect(overlays.snapshot.updateReconciliationPending).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(overlays.snapshot.updateReconciliationPending).toBe(false);
      expect(overlays.snapshot.updateStatusBanner?.tone).toBe("danger");
    } finally {
      overlays.dispose();
    }
  });

  it.each([
    { outcome: "success", pendingFirst: false, handoffId: "next-handoff" },
    { outcome: "failure", pendingFirst: false, handoffId: "next-handoff" },
    { outcome: "success", pendingFirst: true, handoffId: "next-handoff" },
    { outcome: "failure", pendingFirst: true, handoffId: "next-handoff" },
    { outcome: "success", pendingFirst: false, handoffId: null },
  ])(
    "adopts a newer $outcome (pending first: $pendingFirst, handoff: $handoffId)",
    async ({ outcome, pendingFirst, handoffId }) => {
      const terminal: UpdateRestartStatusResponse = {
        sentinel: {
          kind: "update",
          status: outcome === "success" ? "ok" : "error",
          ts: 3_000,
          stats: {
            handoffId,
            reason: outcome === "failure" ? "build-failed" : null,
            after: { version: "3.0.0" },
          },
        },
      };
      let response: UpdateRestartStatusResponse = {};
      const request = vi.fn<RequestFn>(async (method) =>
        method === "update.run" ? HANDOFF_RESPONSE : response,
      );
      const harness = createUpdateHarness(request);
      const onUpdateFailure = vi.fn();
      let overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        await overlays.runUpdate();
        harness.update({ phase: "reconnecting" });
        response = pendingFirst
          ? {
              sentinel: {
                ...terminal.sentinel,
                status: "skipped",
                stats: { handoffId, reason: "managed-service-handoff-started" },
              },
            }
          : terminal;
        harness.update({ phase: "connected" });
        await flushMicrotasks();
        if (pendingFirst) {
          expect(overlays.snapshot.updateReconciliationPending).toBe(true);
          expect(onUpdateFailure).not.toHaveBeenCalled();
          // The successor identity and cleared target must survive a document reload.
          overlays.dispose();
          overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
          await flushMicrotasks();
          response = terminal;
          await vi.advanceTimersByTimeAsync(1_000);
        }

        expect(overlays.snapshot.updateReconciliationPending).toBe(false);
        if (outcome === "success") {
          expect(overlays.snapshot.updateStatusBanner).toBeNull();
          expect(showToast).toHaveBeenCalledOnce();
          expect(onUpdateFailure).not.toHaveBeenCalled();
        } else {
          expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("build-failed");
          expect(onUpdateFailure).toHaveBeenCalledOnce();
          expect(onUpdateFailure.mock.calls[0]?.[0]).toMatchObject({ id: handoffId });
          expect(onUpdateFailure.mock.calls[0]?.[1].admit()).toBe(true);
          await overlays.refreshUpdateStatus();
          expect(onUpdateFailure).toHaveBeenCalledOnce();
        }
        expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
      } finally {
        overlays.dispose();
      }
    },
  );

  it.each([
    { outcome: "mismatch", handoffId: HANDOFF_ID },
    { outcome: "mismatch", handoffId: undefined },
    { outcome: "timeout", handoffId: HANDOFF_ID },
    { outcome: "timeout", handoffId: undefined },
  ])(
    "consumes a $outcome diagnosis across late failure and reload (handoff: $handoffId)",
    async ({ outcome, handoffId }) => {
      const accepted = {
        kind: "update",
        status: "ok",
        ts: 2_000,
        stats: { handoffId, after: { version: "2.0.0" } },
      };
      let response: UpdateRestartStatusResponse = {};
      const request = vi.fn<RequestFn>(async (method) =>
        method === "update.run"
          ? {
              ok: true,
              result: { status: "ok", after: { version: "2.0.0" } },
              sentinel: { payload: accepted },
            }
          : response,
      );
      const harness = createUpdateHarness(request);
      const onUpdateFailure = vi.fn();
      let overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        await overlays.runUpdate();
        harness.update({ phase: "reconnecting" });
        response = {
          sentinel: {
            ...accepted,
            stats: {
              handoffId,
              ...(outcome === "mismatch" ? { after: { version: "1.0.0" } } : {}),
            },
          },
        };
        harness.update({ phase: "connected" });
        await vi.advanceTimersByTimeAsync(outcome === "timeout" ? 10_000 : 0);
        expect(overlays.snapshot.updateReconciliationPending).toBe(false);
        expect(onUpdateFailure).toHaveBeenCalledOnce();
        expect(onUpdateFailure.mock.calls[0]?.[0].outcome).toBe(
          outcome === "timeout" ? "unknown" : "failed",
        );
        expect(onUpdateFailure.mock.calls[0]?.[1].admit()).toBe(true);

        // Restart health can rewrite the same record after verification has ended.
        response = {
          sentinel: {
            ...accepted,
            status: "error",
            stats: { handoffId, reason: "restart-unhealthy" },
          },
        };
        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("restart-unhealthy");
        expect(onUpdateFailure).toHaveBeenCalledOnce();
        overlays.dispose();
        overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
        await flushMicrotasks();
        expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("restart-unhealthy");
        expect(onUpdateFailure).toHaveBeenCalledOnce();

        response = {
          sentinel: {
            ...response.sentinel,
            ts: 3_000,
            stats: { handoffId: handoffId ? "next-handoff" : undefined, reason: "build-failed" },
          },
        };
        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("build-failed");
        expect(onUpdateFailure).toHaveBeenCalledTimes(2);
        expect(onUpdateFailure.mock.calls[1]?.[1].admit()).toBe(true);
        expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
      } finally {
        overlays.dispose();
      }
    },
  );

  it("keeps a newer result without installed identity unknown within the original deadline", async () => {
    let response: UpdateRestartStatusResponse = {};
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.run" ? HANDOFF_RESPONSE : response,
    );
    const harness = createUpdateHarness(request);
    const onUpdateFailure = vi.fn();
    const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
      await overlays.runUpdate();
      harness.update({ phase: "reconnecting" });
      await vi.advanceTimersByTimeAsync(HANDOFF_MS - 1_000);
      response = {
        sentinel: { kind: "update", status: "ok", ts: 3_000, stats: { handoffId: "next-handoff" } },
      };
      harness.update({ phase: "connected" });
      await flushMicrotasks();
      expect(overlays.snapshot.updateReconciliationPending).toBe(true);
      expect(onUpdateFailure).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(overlays.snapshot.updateReconciliationPending).toBe(false);
      expect(onUpdateFailure).toHaveBeenCalledOnce();
      expect(onUpdateFailure.mock.calls[0]?.[0]).toMatchObject({
        id: "next-handoff",
        outcome: "unknown",
        verification: { handoffId: "next-handoff", expectedVersion: null, expectedSha: null },
      });
      expect(showToast).not.toHaveBeenCalled();
      expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
    } finally {
      overlays.dispose();
    }
  });

  it.each(["before verification", "after verification"])(
    "resumes after the stale document reloads %s and announces success once",
    async (reloadMoment) => {
      const firstRequest = vi.fn<RequestFn>(async (method) =>
        method === "update.run"
          ? HANDOFF_RESPONSE
          : method === "update.status"
            ? HANDOFF_SUCCESS
            : {},
      );
      const firstHarness = createUpdateHarness(firstRequest);
      const first = createApplicationOverlays(firstHarness.gateway);
      await first.runUpdate();
      if (reloadMoment === "after verification") {
        vi.spyOn(buildInfo, "reloadControlUiIfStale")
          .mockReturnValueOnce(true)
          .mockReturnValue(false);
        firstHarness.update({ phase: "reconnecting" });
        firstHarness.update({ phase: "connected" });
        await flushMicrotasks();
        expect(first.snapshot.updateReconciliationPending).toBe(false);
        expect(showToast).not.toHaveBeenCalled();
      }
      firstHarness.update({ phase: "reload-required", hello: null });
      first.dispose();

      const updateStatus = deferred();
      const nextRequest = vi.fn<RequestFn>((method) =>
        method === "update.status" ? updateStatus.promise : Promise.resolve({}),
      );
      const nextHarness = createUpdateHarness(nextRequest);
      const next = createApplicationOverlays(nextHarness.gateway);
      try {
        await flushMicrotasks();
        expect(next.snapshot.updateReconciliationPending).toBe(
          reloadMoment === "before verification",
        );
        expect(nextRequest.mock.calls.map(([method]) => method)).toContain("update.status");
        expect(nextRequest.mock.calls.map(([method]) => method)).not.toContain("update.run");

        if (reloadMoment === "after verification") {
          expect(showToast).toHaveBeenCalledOnce();
        }
        updateStatus.resolve(
          reloadMoment === "before verification" ? HANDOFF_SUCCESS : { sentinel: null },
        );
        await flushMicrotasks();
        expect(next.snapshot.updateReconciliationPending).toBe(false);
        expect(showToast).toHaveBeenCalledOnce();
        next.dispose();

        const reloaded = createApplicationOverlays(nextHarness.gateway);
        try {
          await flushMicrotasks();
          expect(reloaded.snapshot.updateReconciliationPending).toBe(false);
          expect(showToast).toHaveBeenCalledOnce();
        } finally {
          reloaded.dispose();
        }
      } finally {
        updateStatus.resolve({});
        next.dispose();
      }
    },
  );

  it.each(["different Gateway", "revoked administrator", "expired attempt"] as const)(
    "does not resume an update for a %s after reload",
    async (boundary) => {
      const request = vi.fn<RequestFn>(async (method) =>
        method === "update.run" ? HANDOFF_RESPONSE : HANDOFF_SUCCESS,
      );
      const harness = createUpdateHarness(request);
      const first = createApplicationOverlays(harness.gateway);
      await first.runUpdate();
      first.dispose();

      if (boundary === "different Gateway") {
        harness.gateway.connection.gatewayUrl = "ws://other-gateway.test";
      } else if (boundary === "revoked administrator") {
        harness.update({
          hello: {
            auth: { role: "operator", scopes: ["operator.read"] },
          } as ApplicationGatewaySnapshot["hello"],
        });
      } else {
        await vi.advanceTimersByTimeAsync(HANDOFF_MS + 1);
      }
      const reloaded = createApplicationOverlays(harness.gateway);
      try {
        await flushMicrotasks();
        expect(reloaded.snapshot.updateReconciliationPending).toBe(false);
        expect(showToast).not.toHaveBeenCalled();
        if (boundary === "revoked administrator") {
          harness.update({
            hello: {
              auth: { role: "operator", scopes: ["operator.admin"] },
            } as ApplicationGatewaySnapshot["hello"],
          });
          await flushMicrotasks();
          expect(reloaded.snapshot.updateReconciliationPending).toBe(false);
          expect(showToast).not.toHaveBeenCalled();
        }
      } finally {
        reloaded.dispose();
      }
    },
  );

  it("retires active reconciliation when the selected logical Gateway changes", async () => {
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.run" ? HANDOFF_RESPONSE : HANDOFF_SUCCESS,
    );
    const harness = createUpdateHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await overlays.runUpdate();
      harness.gateway.connection.gatewayUrl = "ws://other-gateway.test";
      harness.update({ phase: "connecting", client: client(request), hello: null });

      expect(overlays.snapshot.updateReconciliationPending).toBe(false);
      harness.update({ phase: "connected" });
      await flushMicrotasks();
      expect(showToast).not.toHaveBeenCalled();
    } finally {
      overlays.dispose();
    }
  });

  it.each([
    { kind: "handoff", status: "ok" },
    { kind: "handoff", status: "error" },
    { kind: "unmanaged", status: "ok" },
    { kind: "unmanaged", status: "error" },
  ])("ignores an earlier $status sentinel for a $kind update", async ({ kind, status }) => {
    let response = {
      sentinel: {
        kind: "update",
        status,
        ts: 1_000,
        stats: {
          handoffId: kind === "handoff" ? "handoff-earlier" : undefined,
          after: { version: "2.0.0" },
        },
      },
    };
    const success = {
      sentinel: {
        ...HANDOFF_SUCCESS.sentinel,
        ts: 2_000,
        stats: {
          ...HANDOFF_SUCCESS.sentinel.stats,
          handoffId: kind === "handoff" ? HANDOFF_ID : undefined,
        },
      },
    };
    const accepted =
      kind === "handoff"
        ? HANDOFF_RESPONSE
        : {
            ok: true,
            result: { status: "ok", after: { version: "2.0.0" } },
            sentinel: { payload: success.sentinel },
          };
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.run" ? accepted : method === "update.status" ? response : {},
    );
    const harness = createUpdateHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await overlays.runUpdate();
      harness.update({ phase: "reconnecting" });
      harness.update({ phase: "connected" });
      await flushMicrotasks();

      expect(overlays.snapshot.updateReconciliationPending).toBe(true);
      expect(overlays.snapshot.updateStatusBanner).toBeNull();
      expect(showToast).not.toHaveBeenCalled();

      response = success;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(overlays.snapshot.updateReconciliationPending).toBe(false);
      expect(showToast).toHaveBeenCalledOnce();
    } finally {
      overlays.dispose();
    }
  });
});
