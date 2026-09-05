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
import { createApplicationOverlays } from "./overlays.ts";

const reportUpdateFailure = vi.hoisted(() => vi.fn());

vi.mock("./update-failure-report.ts", () => ({ reportUpdateFailure }));

const FAILURE = {
  kind: "update",
  status: "error",
  ts: 1_000,
  stats: {
    handoffId: "handoff-failed",
    reason: "build-failed",
    before: { version: "1.0.0" },
    steps: [{ name: "build", log: { exitCode: 1, stderrTail: "Disk is full" } }],
  },
};

function harnessFor(request: RequestFn) {
  const harness = createGatewayHarness(client(request));
  harness.update({
    selfUser: { id: "gateway-owner" },
    hello: {
      auth: { role: "operator", scopes: ["operator.admin"] },
    } as ApplicationGatewaySnapshot["hello"],
  });
  return harness;
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  reportUpdateFailure.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("update failure report continuity", () => {
  it.each(["other-operator", null])(
    "refuses report admission for administrator profile %s",
    async (profileId) => {
      const request = vi.fn<RequestFn>(async (method) =>
        method === "update.status" ? { sentinel: FAILURE } : {},
      );
      const harness = harnessFor(request);
      harness.update({ selfUser: profileId ? { id: profileId } : null });
      const overlays = createApplicationOverlays(harness.gateway);
      try {
        await flushMicrotasks();
        expect(overlays.snapshot.reportableUpdateFailureId).toBe("handoff-failed");
        await overlays.reportUpdateFailure("handoff-failed");
        expect(reportUpdateFailure).not.toHaveBeenCalled();
        expect(overlays.snapshot.updateFailureReportBusy).toBe(false);
        expect(overlays.snapshot.updateFailureReportNotice).toBeNull();
      } finally {
        overlays.dispose();
      }
    },
  );

  it("never reports during status hydration and suppresses duplicate clicks", async () => {
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.status" ? { sentinel: FAILURE } : {},
    );
    const harness = harnessFor(request);
    const pending = deferred<{
      status: "created";
      url: string;
    }>();
    reportUpdateFailure.mockReturnValue(pending.promise);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      expect(overlays.snapshot.reportableUpdateFailureId).toBe("handoff-failed");
      expect(reportUpdateFailure).not.toHaveBeenCalled();

      const first = overlays.reportUpdateFailure("handoff-failed");
      const duplicate = overlays.reportUpdateFailure("handoff-failed");
      expect(overlays.snapshot.updateFailureReportBusy).toBe(true);
      await vi.waitFor(() => expect(reportUpdateFailure).toHaveBeenCalledOnce());
      pending.resolve({
        status: "created",
        url: "https://github.com/openclaw/openclaw/issues/123",
      });
      await Promise.all([first, duplicate]);

      expect(reportUpdateFailure).toHaveBeenCalledOnce();
      expect(overlays.snapshot.updateFailureReportNotice).toMatchObject({
        attemptId: "handoff-failed",
        result: { status: "created" },
      });
    } finally {
      overlays.dispose();
    }
  });

  it("invalidates an open confirmation on disconnect and restores only the current action", async () => {
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.status" ? { sentinel: FAILURE } : {},
    );
    const harness = harnessFor(request);
    const administrator = harness.gateway.snapshot.hello;
    const first = deferred<null>();
    reportUpdateFailure.mockReturnValueOnce(first.promise).mockResolvedValueOnce(null);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      const interrupted = overlays.reportUpdateFailure("handoff-failed");
      await vi.waitFor(() => expect(reportUpdateFailure).toHaveBeenCalledOnce());

      harness.update({ phase: "reconnecting", client: null, hello: null, selfUser: null });
      first.resolve(null);
      await interrupted;
      expect(overlays.snapshot.updateFailureReportBusy).toBe(false);
      expect(overlays.snapshot.updateFailureReportNotice).toBeNull();

      harness.update({
        phase: "connected",
        client: client(request),
        hello: administrator,
        selfUser: { id: "gateway-owner" },
      });
      await flushMicrotasks();
      expect(overlays.snapshot.reportableUpdateFailureId).toBe("handoff-failed");
      await overlays.reportUpdateFailure("handoff-failed");
      expect(reportUpdateFailure).toHaveBeenCalledTimes(2);
    } finally {
      overlays.dispose();
    }
  });

  it("shows an older Gateway's missing-method error instead of hiding the action", async () => {
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.status" ? { sentinel: FAILURE } : {},
    );
    const harness = harnessFor(request);
    reportUpdateFailure.mockRejectedValue(new Error("unknown method: update.report"));
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      await overlays.reportUpdateFailure("handoff-failed");

      expect(overlays.snapshot.updateFailureReportNotice).toMatchObject({
        attemptId: "handoff-failed",
        result: { status: "error", message: expect.stringContaining("unknown method") },
      });
    } finally {
      overlays.dispose();
    }
  });
});
