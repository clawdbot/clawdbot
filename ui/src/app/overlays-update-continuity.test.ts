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

vi.mock("../lib/toast.ts", () => ({ showToast: vi.fn() }));

const HANDOFF_MS = 35 * 60_000;
const HANDOFF_ID = "handoff-current";
const HANDOFF_RESPONSE = {
  ok: true,
  handoff: { status: "started" },
  result: { status: "skipped", reason: "managed-service-handoff-started" },
  sentinel: { payload: { stats: { handoffId: HANDOFF_ID } } },
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
  harness.update({
    hello: {
      auth: { role: "operator", scopes: ["operator.admin"] },
      server: { version: "1.0.0" },
      snapshot: {
        updateAvailable: { channel: "stable", currentVersion: "1.0.0", latestVersion: "2.0.0" },
      },
    } as ApplicationGatewaySnapshot["hello"],
  });
  return harness;
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
      expect(overlays.snapshot.updateStatusBanner?.text).toContain("openclaw update status");
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

  it.each(["ok", "error"])("ignores an earlier handoff's %s sentinel", async (status) => {
    let response = {
      sentinel: {
        kind: "update",
        status,
        stats: { handoffId: "handoff-earlier", after: { version: "2.0.0" } },
      },
    };
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.run" ? HANDOFF_RESPONSE : method === "update.status" ? response : {},
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

      response = HANDOFF_SUCCESS;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(overlays.snapshot.updateReconciliationPending).toBe(false);
      expect(showToast).toHaveBeenCalledOnce();
    } finally {
      overlays.dispose();
    }
  });
});
