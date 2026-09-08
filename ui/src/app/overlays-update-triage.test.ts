// @vitest-environment node
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createUpdateRunFixture as updateRunFixture } from "../test-helpers/update-run.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { client, flushMicrotasks, type RequestFn } from "./overlays-access.test-support.ts";
import type { ApplicationUpdateOverlayHooks } from "./overlays-updates.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { updateRunHarness } from "./update-run.test-support.ts";

const FAILURE = updateRunFixture({
  status: "failed",
  phase: "finished",
  reason: "build-failed",
  finishedAtMs: 3_000,
  after: { version: "2.0.0" },
  updatedAtMs: 3_000,
  steps: [{ step: "build", status: "failed", detail: "Disk is full" }],
});
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
} as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("update failure triage admission", () => {
  it("presents a manual terminal failure after its admission request releases the interlock", async () => {
    const harness = updateRunHarness(async (method) => {
      if (method === "update.run") {
        return { runId: FAILURE.runId };
      }
      return method === "update.runs.get" ? { run: FAILURE } : {};
    });
    const onUpdateFailure = vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>();
    const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
      await flushMicrotasks();
      await overlays.runUpdate();
      expect(overlays.snapshot.updateRun).toEqual(FAILURE);
      expect(overlays.snapshot.updateRunning).toBe(false);
      expect(onUpdateFailure).toHaveBeenCalledOnce();
      expect(onUpdateFailure.mock.calls[0]![1].admit()).toBe(true);
    } finally {
      overlays.dispose();
    }
  });

  it("carries the run failure once across events, status refreshes, access changes, and reload", async () => {
    let run = updateRunFixture();
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.runs.get" ? { run } : { lastRun: run },
    );
    const harness = updateRunHarness(request);
    const admin = harness.gateway.snapshot.hello;
    const onUpdateFailure = vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>();
    let overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
      await flushMicrotasks();
      expect(onUpdateFailure).not.toHaveBeenCalled();
      run = FAILURE;
      harness.emitEvent("update.run.changed", run);
      await flushMicrotasks();
      expect(onUpdateFailure).toHaveBeenCalledOnce();
      const [failure, admission] = onUpdateFailure.mock.calls[0]!;
      expect(failure).toMatchObject({
        id: FAILURE.runId,
        outcome: "failed",
        attempt: {
          reason: "build-failed",
          beforeVersion: "2026.9.1",
          afterVersion: "2.0.0",
          failure: { step: "build", detail: "Disk is full" },
        },
      });
      expect(overlays.snapshot.updateStatusBanner?.text).toContain("Disk is full");
      expect(admission.admit()).toBe(true);
      expect(admission.admit()).toBe(false);
      harness.emitEvent("update.run.changed", run);
      await overlays.refreshUpdateStatus();
      expect(onUpdateFailure).toHaveBeenCalledOnce();
      harness.update({
        hello: {
          auth: { role: "operator", scopes: ["operator.read"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      expect(overlays.snapshot.updateRun).toBeNull();
      expect(admission.isCurrent()).toBe(false);
      harness.update({ hello: admin });
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(FAILURE);
      expect(onUpdateFailure).toHaveBeenCalledOnce();
      overlays.dispose();
      overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(FAILURE);
      expect(onUpdateFailure).toHaveBeenCalledOnce();
      expect(request.mock.calls.some(([method]) => method === "update.run")).toBe(false);
    } finally {
      overlays.dispose();
    }
  });

  it.each(["Gateway", "profile"] as const)(
    "scopes a consumed diagnostic to its %s across switching and reload",
    async (boundary) => {
      const request = vi.fn<RequestFn>(async () => ({ lastRun: FAILURE }));
      const harness = updateRunHarness(request);
      const initialGateway = harness.gateway.connection.gatewayUrl;
      const admin = harness.gateway.snapshot.hello;
      const onUpdateFailure = vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>(
        (_failure, admission) => expect(admission.admit()).toBe(true),
      );
      let overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      const switchScope = (other: boolean) => {
        harness.gateway.connection.gatewayUrl =
          boundary === "Gateway" && other ? "ws://other.test" : initialGateway;
        harness.update({ phase: "connecting", client: null, hello: null });
        harness.update({
          phase: "connected",
          client: client(request),
          hello: admin,
          selfUser:
            boundary === "profile" && other
              ? ({ id: "other" } as NonNullable<ApplicationGatewaySnapshot["selfUser"]>)
              : undefined,
        });
      };
      try {
        await flushMicrotasks();
        const admission = onUpdateFailure.mock.calls[0]![1];
        switchScope(true);
        await flushMicrotasks();
        expect(admission.isCurrent()).toBe(false);
        expect(onUpdateFailure).toHaveBeenCalledTimes(2);
        switchScope(false);
        await flushMicrotasks();
        overlays.dispose();
        overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
        await flushMicrotasks();
        expect(overlays.snapshot.updateRun).toEqual(FAILURE);
        expect(onUpdateFailure).toHaveBeenCalledTimes(2);
      } finally {
        overlays.dispose();
      }
    },
  );

  it.each(["run", "campaign"])(
    "retires a queued failure admission when a newer %s starts",
    async (source) => {
      let run = FAILURE;
      const request = vi.fn<RequestFn>(async () => ({ activeRun: run }));
      const harness = updateRunHarness(request);
      const onUpdateFailure =
        vi.fn<NonNullable<ApplicationUpdateOverlayHooks["onUpdateFailure"]>>();
      const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        await flushMicrotasks();
        const admission = onUpdateFailure.mock.calls[0]![1];
        run = updateRunFixture({
          runId: "00000000-0000-4000-8000-000000000002",
          createdAtMs: 4_000,
          updatedAtMs: 4_000,
          origin: { campaignId: CAMPAIGN.campaign.id },
        });
        if (source === "campaign") {
          harness.emitEvent("update.available", { schedule: CAMPAIGN });
          expect(overlays.snapshot.updateRunning).toBe(true);
          expect(overlays.snapshot.updateRun).toEqual(FAILURE);
          expect(admission.isCurrent()).toBe(false);
          expect(admission.admit()).toBe(false);
          await overlays.runUpdate();
          expect(request.mock.calls.some(([method]) => method === "update.run")).toBe(false);
        }
        harness.emitEvent("update.run.changed", run);
        await flushMicrotasks();
        expect(admission.isCurrent()).toBe(false);
        expect(admission.admit()).toBe(false);
        expect(overlays.snapshot.updateRun).toEqual(run);
        expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();
        expect(onUpdateFailure).toHaveBeenCalledOnce();
      } finally {
        overlays.dispose();
      }
    },
  );

  it("reports a preparation failure without dispatching or diagnosing an update", async () => {
    const previous = updateRunFixture({
      status: "succeeded",
      phase: "finished",
      finishedAtMs: 3_000,
    });
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.status" ? { lastRun: previous } : {},
    );
    const harness = updateRunHarness(request);
    const onUpdateFailure = vi.fn();
    const overlays = createApplicationOverlays(harness.gateway, {
      onUpdateFailure,
      drainConfigWrites: async () => {
        throw new Error("Config preparation failed");
      },
    });
    try {
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(previous);
      await overlays.runUpdate();
      expect(overlays.snapshot.updateRun).toBeNull();
      expect(request.mock.calls.some(([method]) => method === "update.run")).toBe(false);
      expect(overlays.snapshot.updateRunning).toBe(false);
      expect(overlays.snapshot.updateReconciliationPending).toBe(false);
      expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();
      expect(overlays.snapshot.updateStatusBanner?.text).toContain("Config preparation failed");
      expect(onUpdateFailure).not.toHaveBeenCalled();
    } finally {
      overlays.dispose();
    }
  });

  it.each(["running", "succeeded", "skipped"] as const)(
    "does not diagnose a %s run",
    async (status) => {
      const run = updateRunFixture({
        status,
        phase: status === "running" ? "verifying" : "finished",
      });
      const harness = updateRunHarness(async () => ({ lastRun: run }));
      const onUpdateFailure = vi.fn();
      const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        await flushMicrotasks();
        expect(onUpdateFailure).not.toHaveBeenCalled();
      } finally {
        overlays.dispose();
      }
    },
  );

  it("still presents a retained pre-ledger failure on upgrade", async () => {
    const harness = updateRunHarness(async () => ({
      sentinel: { kind: "update", status: "error", ts: 1_000, stats: { reason: "build-failed" } },
    }));
    const onUpdateFailure = vi.fn();
    const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toBeNull();
      expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("build-failed");
      expect(onUpdateFailure).toHaveBeenCalledOnce();
    } finally {
      overlays.dispose();
    }
  });

  it("does not turn failed status or hold requests into a failed update", async () => {
    let unavailable = false;
    const harness = updateRunHarness(async (method) => {
      if (unavailable && (method === "update.status" || method === "update.hold")) {
        throw new Error("Unavailable");
      }
      return {};
    });
    const onUpdateFailure = vi.fn();
    const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
      await flushMicrotasks();
      unavailable = true;
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
  it.each([
    { code: "INVALID_REQUEST", message: "Invalid update request parameters" },
    { code: "INVALID_REQUEST", message: "Missing operator.admin scope" },
    { code: "UNAVAILABLE", message: "Gateway restart admission is unavailable" },
  ])("preserves the sent rejection $message over historical success", async (failure) => {
    const previous = updateRunFixture({
      status: "succeeded",
      phase: "finished",
      finishedAtMs: 3_000,
    });
    const request = vi.fn<RequestFn>(async (method, _params, options) => {
      if (method === "update.run") {
        options?.onSent?.();
        throw new GatewayRequestError(failure);
      }
      return method === "update.status" ? { lastRun: previous } : {};
    });
    const harness = updateRunHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(previous);
      await overlays.runUpdate();
      expect(overlays.snapshot.updateStatusBanner?.text).toContain(failure.message);
      expect(overlays.snapshot.updateRun).toBeNull();
      expect(overlays.snapshot.updateRunning).toBe(false);
    } finally {
      overlays.dispose();
    }
  });

  it.each(["recorded:1000", "stable-handoff"])(
    "does not replay the stable v2026.9.1 consumed diagnostic %s after reload",
    async (id) => {
      const scope = gatewayCredentialScope("ws://gateway.test");
      const stored = JSON.stringify({ triaged: [JSON.stringify([scope, null, id])] });
      sessionStorage.setItem("openclaw:control-ui:update:v1", stored);
      const harness = updateRunHarness(async () => ({
        sentinel: {
          kind: "update",
          status: "error",
          ts: 1_000,
          stats: { reason: "build-failed", ...(id === "stable-handoff" ? { handoffId: id } : {}) },
        },
      }));
      const onUpdateFailure = vi.fn();
      const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
      try {
        await flushMicrotasks();
        expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("build-failed");
        expect(onUpdateFailure).not.toHaveBeenCalled();
        expect(sessionStorage.getItem("openclaw:control-ui:update:v1")).toBe(stored);
      } finally {
        overlays.dispose();
      }
    },
  );
});
