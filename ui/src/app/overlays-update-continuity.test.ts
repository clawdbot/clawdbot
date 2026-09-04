// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showToast } from "../lib/toast.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createUpdateRunFixture as updateRunFixture } from "../test-helpers/update-run.ts";
import { flushMicrotasks, type RequestFn } from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { updateRunHarness } from "./update-run.test-support.ts";

vi.mock("../lib/toast.ts", () => ({ showToast: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("server-owned update continuity", () => {
  it("reads an accepted run and follows events through restart to a visible success row", async () => {
    let run = updateRunFixture();
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "update.run") {
        return { ok: true, runId: run.runId };
      }
      if (method === "update.runs.get") {
        return { run };
      }
      if (method === "update.status" && run.status === "succeeded") {
        return { updateAvailable: null };
      }
      return {};
    });
    const harness = updateRunHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      await overlays.runUpdate();
      expect(request).toHaveBeenCalledWith("update.runs.get", { runId: run.runId });
      expect(overlays.snapshot.updateRun).toEqual(run);
      expect(overlays.snapshot.updateRunning || overlays.snapshot.updateReconciliationPending).toBe(
        true,
      );

      for (const phase of ["activating", "restarting"] as const) {
        run = updateRunFixture({ phase, updatedAtMs: run.updatedAtMs + 1 });
        harness.emitEvent("update.run.changed", run);
        await flushMicrotasks();
        expect(overlays.snapshot.updateRun?.phase).toBe(phase);
      }
      const hello = harness.gateway.snapshot.hello;
      harness.update({ phase: "reconnecting", hello: null });
      await vi.advanceTimersByTimeAsync(40 * 60_000);
      expect(overlays.snapshot.updateRun?.phase).toBe("restarting");
      expect(overlays.snapshot.updateReconciliationPending || overlays.snapshot.updateRunning).toBe(
        true,
      );
      expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();

      run = { ...run, phase: "verifying", updatedAtMs: run.updatedAtMs + 1 };
      harness.update({ phase: "connected", hello });
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun?.phase).toBe("verifying");
      run = {
        ...run,
        phase: "finished",
        status: "succeeded",
        updatedAtMs: run.updatedAtMs + 1,
        after: { version: "2.0.0" },
        finishedAtMs: Date.now(),
        verification: {
          serviceRunning: true,
          versionMatch: true,
          channelsReady: true,
          inferenceProbe: "passed",
        },
      };
      harness.emitEvent("update.run.changed", run);
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(run);
      expect(overlays.snapshot.updateRunning).toBe(false);
      expect(overlays.snapshot.updateReconciliationPending).toBe(false);
      expect(overlays.snapshot.updateStatusBanner).toBeNull();
      expect(overlays.snapshot.updateAvailable).toBeNull();
      expect(showToast).not.toHaveBeenCalled();
      expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
      expect(sessionStorage.length).toBe(0);
    } finally {
      overlays.dispose();
    }
  });

  it("does not fetch an unchanged event, but fetches changed step details in the same phase", async () => {
    let run = updateRunFixture();
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.runs.get" ? { run } : { activeRun: run },
    );
    const harness = updateRunHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(run);
      const reads = () => request.mock.calls.filter(([method]) => method === "update.runs.get");
      harness.emitEvent("update.run.changed", run);
      harness.emitEvent("update.run.changed", run);
      await flushMicrotasks();
      expect(reads()).toHaveLength(0);
      run = {
        ...run,
        updatedAtMs: run.updatedAtMs + 1,
        steps: [
          ...run.steps,
          { step: "download", status: "in_progress", detail: "Downloading package" },
        ],
      };
      harness.emitEvent("update.run.changed", run);
      await flushMicrotasks();
      expect(reads()).toHaveLength(1);
      expect(overlays.snapshot.updateRun?.steps.at(-1)?.detail).toBe("Downloading package");
    } finally {
      overlays.dispose();
    }
  });

  it.each(["activeRun", "lastRun"] as const)(
    "discovers %s after a document reload without browser run storage",
    async (field) => {
      const run = updateRunFixture(
        field === "lastRun"
          ? {
              phase: "finished",
              status: "succeeded",
              after: { version: "2.0.0" },
              finishedAtMs: 5_000,
            }
          : {},
      );
      const request = vi.fn<RequestFn>(async (method) =>
        method === "update.status" ? { [field]: run } : {},
      );
      const harness = updateRunHarness(request);
      let overlays = createApplicationOverlays(harness.gateway);
      try {
        await flushMicrotasks();
        expect(overlays.snapshot.updateRun).toEqual(run);
        overlays.dispose();
        overlays = createApplicationOverlays(harness.gateway);
        await flushMicrotasks();
        expect(overlays.snapshot.updateRun).toEqual(run);
        expect(request.mock.calls.filter(([method]) => method === "update.status")).toHaveLength(2);
        expect(request.mock.calls.some(([method]) => method === "update.run")).toBe(false);
        expect(sessionStorage.length).toBe(0);
      } finally {
        overlays.dispose();
      }
    },
  );

  it("keeps a known run on reconnect even when status retains another attempt", async () => {
    let run = updateRunFixture();
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "update.run") {
        return { ok: true, runId: run.runId };
      }
      if (method === "update.runs.get") {
        return { run };
      }
      return {};
    });
    const harness = updateRunHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await overlays.runUpdate();
      const statusReads = request.mock.calls.filter(
        ([method]) => method === "update.status",
      ).length;
      harness.update({ phase: "reconnecting" });
      run = { ...run, phase: "verifying", updatedAtMs: 3_000 };
      harness.update({ phase: "connected" });
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(run);
      expect(request.mock.calls.filter(([method]) => method === "update.status")).toHaveLength(
        statusReads,
      );
      expect(request.mock.calls.filter(([method]) => method === "update.runs.get")).toHaveLength(2);
    } finally {
      overlays.dispose();
    }
  });
});
