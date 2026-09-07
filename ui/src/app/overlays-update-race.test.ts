// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdateRunFixture as updateRunFixture } from "../test-helpers/update-run.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import {
  client,
  deferred,
  flushMicrotasks,
  type RequestFn,
} from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { updateRunHarness } from "./update-run.test-support.ts";

afterEach(() => vi.restoreAllMocks());

describe("update run response races", () => {
  it("retires privileged run facts when reconnect authenticates without administrator access", async () => {
    const run = updateRunFixture({
      phase: "finished",
      status: "failed",
      reason: "build-failed",
      finishedAtMs: 3_000,
    });
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.status" ? { lastRun: run } : {},
    );
    const harness = updateRunHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(run);
      expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("build-failed");
      harness.update({ phase: "reconnecting", hello: null });
      expect(overlays.snapshot.updateRun).toEqual(run);
      // A build-skew handshake publishes its new auth before connection admission.
      harness.update({
        phase: "reconnecting",
        hello: {
          auth: { role: "operator", scopes: ["operator.read"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      harness.update({ phase: "connected" });
      expect(overlays.snapshot.updateRun).toBeNull();
      expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();
      expect(overlays.snapshot.updateStatusBanner).toBeNull();
    } finally {
      overlays.dispose();
    }
  });

  it.each(["activeRun", "lastRun"] as const)(
    "discovers %s when disconnect wins the admission reply",
    async (field) => {
      const admission = deferred();
      const run = updateRunFixture(
        field === "lastRun"
          ? {
              phase: "finished",
              status: "succeeded",
              after: { version: "2.0.0" },
              finishedAtMs: 3_000,
            }
          : {},
      );
      let admitted = false;
      const request = vi.fn<RequestFn>(async (method, _params, options) => {
        if (method === "update.run") {
          options?.onSent?.();
          admitted = true;
          return admission.promise;
        }
        return method === "update.status" && admitted ? { [field]: run } : {};
      });
      const harness = updateRunHarness(request);
      const overlays = createApplicationOverlays(harness.gateway);
      await flushMicrotasks();
      const running = overlays.runUpdate();
      try {
        await flushMicrotasks();
        harness.update({ phase: "reconnecting" });
        harness.update({ phase: "connected" });
        await flushMicrotasks();
        expect(overlays.snapshot.updateRun).toEqual(run);
        admission.reject(new Error("old socket closed"));
        await running;
        expect(overlays.snapshot.updateRun).toEqual(run);
        expect(overlays.snapshot.updateStatusBanner).toBeNull();
        expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
      } finally {
        admission.resolve({});
        await running;
        overlays.dispose();
      }
    },
  );

  it.each(["Gateway", "profile", "administrator", "dispose"] as const)(
    "discards a run read after changing %s",
    async (boundary) => {
      const pending = deferred();
      const run = updateRunFixture();
      const request = vi.fn<RequestFn>(async (method) =>
        method === "update.runs.get" ? pending.promise : {},
      );
      const harness = updateRunHarness(request);
      const overlays = createApplicationOverlays(harness.gateway);
      try {
        await flushMicrotasks();
        harness.emitEvent("update.run.changed", run);
        await flushMicrotasks();
        expect(request.mock.calls.some(([method]) => method === "update.runs.get")).toBe(true);
        if (boundary === "Gateway") {
          harness.gateway.connection.gatewayUrl = "ws://other-gateway.test";
          harness.update({ phase: "connecting", client: null, hello: null });
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
        } else {
          overlays.dispose();
        }
        pending.resolve({ run });
        await flushMicrotasks();
        expect(overlays.snapshot.updateRun).toBeNull();
        expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();
      } finally {
        pending.resolve({});
        overlays.dispose();
      }
    },
  );

  it("ignores a retired reconnect response after a replacement connection reads the final row", async () => {
    const pending = deferred();
    const run = updateRunFixture();
    let reads = 0;
    const firstRequest = vi.fn<RequestFn>(async (method) => {
      if (method === "update.run") {
        return { ok: true, runId: run.runId };
      }
      if (method === "update.runs.get") {
        return ++reads === 1 ? { run } : pending.promise;
      }
      return {};
    });
    const finished = {
      ...run,
      status: "succeeded" as const,
      phase: "finished" as const,
      updatedAtMs: 4_000,
      finishedAtMs: 4_000,
      after: { version: "2.0.0" },
    };
    const replacement = vi.fn<RequestFn>(async (method) =>
      method === "update.runs.get" ? { run: finished } : {},
    );
    const harness = updateRunHarness(firstRequest);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await overlays.runUpdate();
      harness.update({ phase: "reconnecting" });
      harness.update({ phase: "connected" });
      await flushMicrotasks();
      harness.update({ phase: "reconnecting" });
      harness.update({ phase: "connected", client: client(replacement) });
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(finished);
      pending.resolve({ run: { ...run, phase: "verifying", updatedAtMs: 3_000 } });
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(finished);
    } finally {
      pending.resolve({});
      overlays.dispose();
    }
  });

  it("does not send an update after the config-write barrier loses its authority", async () => {
    const drained = deferred<void>();
    const request = vi.fn<RequestFn>(async () => ({}));
    const harness = updateRunHarness(request);
    const overlays = createApplicationOverlays(harness.gateway, {
      drainConfigWrites: () => drained.promise,
    });
    const running = overlays.runUpdate();
    try {
      expect(overlays.snapshot.updateRunning).toBe(true);
      harness.update({
        hello: {
          auth: { role: "operator", scopes: ["operator.read"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      drained.resolve();
      await running;
      expect(request.mock.calls.some(([method]) => method === "update.run")).toBe(false);
      expect(overlays.snapshot.updateRunning).toBe(false);
    } finally {
      drained.resolve();
      await running;
      overlays.dispose();
    }
  });
  it.each([
    { baseline: "unknown", discovered: "old", attach: false },
    { baseline: "unknown", discovered: "old after disconnect", attach: false },
    { baseline: "previous", discovered: "old", attach: false },
    { baseline: "previous", discovered: "new", attach: true },
    { baseline: "empty", discovered: "new", attach: true },
    { baseline: "unknown", discovered: "active", attach: true },
  ] as const)(
    "reconciles lost admission using $baseline history and $discovered run identity",
    async ({ baseline, discovered, attach }) => {
      const admission = deferred();
      const previous = updateRunFixture({
        status: "succeeded",
        phase: "finished",
        finishedAtMs: 3_000,
      });
      let found = discovered.startsWith("old")
        ? previous
        : updateRunFixture({
            runId: "00000000-0000-4000-8000-000000000002",
            ...(discovered === "active"
              ? {}
              : { status: "succeeded", phase: "finished", finishedAtMs: 4_000 }),
          });
      let requested = false;
      const request = vi.fn<RequestFn>(async (method, _params, options) => {
        if (method === "update.run") {
          options?.onSent?.();
          requested = true;
          return admission.promise;
        }
        if (method === "update.runs.get") {
          return { run: found };
        }
        if (method !== "update.status") {
          return {};
        }
        if (!requested) {
          if (baseline === "unknown") {
            throw new Error("Initial history unavailable");
          }
          return baseline === "previous" ? { lastRun: previous } : {};
        }
        return found.status === "running" ? { activeRun: found } : { lastRun: found };
      });
      const harness = updateRunHarness(request);
      const overlays = createApplicationOverlays(harness.gateway);
      let operation: Promise<void> | undefined;
      const outcome =
        discovered === "old after disconnect" ? "outcome is unknown" : "Admission reply lost";
      try {
        await flushMicrotasks();
        operation = overlays.runUpdate();
        await flushMicrotasks();
        if (discovered === "old after disconnect") {
          harness.update({ phase: "reconnecting" });
        }
        admission.reject(new Error("Admission reply lost"));
        if (discovered === "old after disconnect") {
          harness.update({ phase: "connected" });
        }
        await operation;
        await flushMicrotasks();
        if (attach) {
          expect(overlays.snapshot.updateRun).toEqual(found);
          if (discovered === "active") {
            found = {
              ...found,
              status: "succeeded",
              phase: "finished",
              finishedAtMs: 4_000,
              updatedAtMs: 4_000,
            };
            harness.emitEvent("update.run.changed", found);
            await flushMicrotasks();
            expect(overlays.snapshot.updateRun).toEqual(found);
          }
        } else {
          expect(overlays.snapshot.updateRun).toBeNull();
          expect(overlays.snapshot.updateStatusBanner?.tone).toBe("danger");
          expect(overlays.snapshot.updateStatusBanner?.text).toContain(outcome);
          expect(overlays.snapshot.updateRunning).toBe(false);
          harness.update({ phase: "reconnecting" });
          harness.update({ phase: "connected" });
          await flushMicrotasks();
          harness.emitEvent("update.run.changed", { ...previous, updatedAtMs: 4_000 });
          await flushMicrotasks();
          expect(overlays.snapshot.updateRun).toBeNull();
          expect(overlays.snapshot.updateStatusBanner?.text).toContain(outcome);
          await overlays.refreshUpdateStatus();
          expect(overlays.snapshot.updateRun).toBeNull();
          expect(overlays.snapshot.updateStatusBanner?.text).toContain(outcome);
        }
        expect(request.mock.calls.filter(([method]) => method === "update.run")).toHaveLength(1);
      } finally {
        admission.resolve({});
        await operation;
        overlays.dispose();
      }
    },
  );
});
