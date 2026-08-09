// @vitest-environment node
// Control UI tests cover ambiguous update request reconciliation races.
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import {
  client,
  createGatewayHarness,
  deferred,
  flushMicrotasks,
  type RequestFn,
} from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { UPDATE_HANDOFF_STARTED_REASON } from "./update-overlay-helpers.ts";

const UNKNOWN_OUTCOME_TEXT =
  "The update request may have been accepted, but the Gateway did not report a final result after reconnect. Run `openclaw update status` before retrying.";

function installUpdateTranslations() {
  const translations: Record<string, string> = {
    "updates.outcomeUnknown": UNKNOWN_OUTCOME_TEXT,
    "updates.verificationFailedWithVersions":
      "Update installed but running version did not change — restart may have been blocked. Expected v{expectedVersion}, running v{actualVersion}.",
    "updates.verificationFailedWithIdentity":
      "Update finished, but the running install does not match the expected revision. Expected {expected}, running {actual}.",
    "common.unknown": "Unknown",
  };
  return vi.spyOn(i18n, "t").mockImplementation((key, params) => {
    const template = translations[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => params?.[name] ?? `{${name}}`);
  });
}

function expectUpdateStatusRequested(request: ReturnType<typeof vi.fn<RequestFn>>) {
  expect(request).toHaveBeenCalledWith("update.status", {}, { timeoutMs: expect.any(Number) });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("application update reconciliation races", () => {
  it("checks the authoritative sentinel when disconnect wins the update.run response race", async () => {
    installUpdateTranslations();
    const updateRun = deferred<{
      ok: boolean;
      handoff: { status: string };
      result: { reason: string; status: string };
    }>();
    const request = vi.fn<RequestFn>((method) => {
      if (method.endsWith(".list")) {
        return Promise.resolve([]);
      }
      if (method === "update.run") {
        return updateRun.promise;
      }
      if (method === "update.status") {
        return Promise.resolve({
          sentinel: {
            kind: "update",
            status: "ok",
            stats: { after: { version: "1.0.0" } },
          },
        });
      }
      return Promise.resolve({});
    });
    const gatewayClient = client(request);
    const harness = createGatewayHarness(gatewayClient);
    const overlays = createApplicationOverlays(harness.gateway);

    try {
      harness.update({
        hello: {
          server: { version: "1.0.0" },
          snapshot: {
            updateAvailable: {
              currentVersion: "1.0.0",
              latestVersion: "2.0.0",
              channel: "stable",
            },
          },
        } as ApplicationGatewaySnapshot["hello"],
      });

      const running = overlays.runUpdate();
      await flushMicrotasks();
      expect(request).toHaveBeenCalledWith("update.run", {});
      expect(overlays.snapshot.updateReconciliationPending).toBe(true);

      harness.update({ phase: "stopped" });
      harness.update({ phase: "connected" });
      await flushMicrotasks();

      expectUpdateStatusRequested(request);
      expect(overlays.snapshot.updateReconciliationPending).toBe(false);
      expect(overlays.snapshot.updateStatusBanner).toEqual({
        tone: "danger",
        text: expect.stringContaining("Expected v2.0.0, running v1.0.0"),
      });

      updateRun.resolve({
        ok: true,
        handoff: { status: "started" },
        result: { reason: UPDATE_HANDOFF_STARTED_REASON, status: "skipped" },
      });
      await running;
      expect(overlays.snapshot.updateReconciliationPending).toBe(false);
    } finally {
      updateRun.resolve({
        ok: true,
        handoff: { status: "started" },
        result: { reason: UPDATE_HANDOFF_STARTED_REASON, status: "skipped" },
      });
      overlays.dispose();
    }
  });

  it("accepts the replacement Gateway sentinel as proof of an ambiguous update", async () => {
    installUpdateTranslations();
    const updateRun = deferred();
    const request = vi.fn<RequestFn>((method) => {
      if (method.endsWith(".list")) {
        return Promise.resolve([]);
      }
      if (method === "update.run") {
        return updateRun.promise;
      }
      if (method === "update.status") {
        return Promise.resolve({
          sentinel: {
            kind: "update",
            status: "ok",
            stats: { after: { version: "2.0.0" } },
          },
        });
      }
      return Promise.resolve({});
    });
    const gatewayClient = client(request);
    const harness = createGatewayHarness(gatewayClient);
    const overlays = createApplicationOverlays(harness.gateway);

    try {
      harness.update({
        hello: {
          server: { version: "1.0.0" },
          snapshot: {
            updateAvailable: {
              currentVersion: "1.0.0",
              latestVersion: "2.0.0",
              channel: "stable",
            },
          },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const running = overlays.runUpdate();
      await flushMicrotasks();
      harness.update({ phase: "stopped" });
      harness.update({
        phase: "connected",
        hello: {
          server: { version: "2.0.0" },
        } as ApplicationGatewaySnapshot["hello"],
      });
      await flushMicrotasks();

      expect(overlays.snapshot.updateReconciliationPending).toBe(false);
      expect(overlays.snapshot.updateStatusBanner).toBeNull();
      expectUpdateStatusRequested(request);

      updateRun.resolve({});
      await running;
    } finally {
      updateRun.resolve({});
      overlays.dispose();
    }
  });

  it("times out a hung status request for a confirmed update", async () => {
    vi.useFakeTimers();
    installUpdateTranslations();
    const request = vi.fn<RequestFn>((method, _params, options) => {
      if (method === "update.run") {
        return Promise.resolve({
          ok: true,
          result: { after: { version: "2.0.0" }, status: "ok" },
        });
      }
      if (method === "update.status") {
        return new Promise((_resolve, reject) => {
          globalThis.setTimeout(
            () => reject(new Error("request timed out")),
            options?.timeoutMs ?? 0,
          );
        });
      }
      return Promise.resolve([]);
    });
    const harness = createGatewayHarness(client(request));
    harness.update({
      hello: {
        server: { version: "1.0.0" },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const overlays = createApplicationOverlays(harness.gateway);

    try {
      await overlays.runUpdate();
      harness.update({ phase: "stopped" });
      harness.update({ phase: "connected" });
      await flushMicrotasks();

      expect(request).toHaveBeenCalledWith("update.status", {}, { timeoutMs: 10_000 });
      await vi.advanceTimersByTimeAsync(10_000);
      await flushMicrotasks();

      expect(overlays.snapshot.updateReconciliationPending).toBe(false);
      expect(overlays.snapshot.updateStatusBanner).toEqual({
        tone: "danger",
        text: expect.stringContaining("Expected v2.0.0"),
      });
    } finally {
      overlays.dispose();
      vi.useRealTimers();
    }
  });

  it("releases confirmed reconciliation when update status access is revoked", async () => {
    installUpdateTranslations();
    const updateStatus = deferred();
    const request = vi.fn<RequestFn>((method) => {
      if (method === "update.run") {
        return Promise.resolve({
          ok: true,
          handoff: { status: "started" },
          result: { reason: UPDATE_HANDOFF_STARTED_REASON, status: "skipped" },
        });
      }
      if (method === "update.status") {
        return updateStatus.promise;
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

    try {
      await overlays.runUpdate();
      expect(overlays.snapshot.updateReconciliationPending).toBe(true);

      harness.update({ phase: "stopped" });
      harness.update({ phase: "connected" });
      await flushMicrotasks();
      expectUpdateStatusRequested(request);

      harness.update({
        hello: {
          auth: { role: "operator", scopes: ["operator.read"] },
        } as ApplicationGatewaySnapshot["hello"],
      });

      expect(overlays.snapshot.updateRunning).toBe(false);
      expect(overlays.snapshot.updateReconciliationPending).toBe(false);
      expect(overlays.snapshot.updateStatusBanner).toEqual({
        tone: "danger",
        text: UNKNOWN_OUTCOME_TEXT,
      });

      updateStatus.resolve({
        sentinel: {
          kind: "update",
          status: "error",
          stats: { reason: "stale-result" },
        },
      });
      await flushMicrotasks();
      expect(overlays.snapshot.updateStatusBanner).toEqual({
        tone: "danger",
        text: UNKNOWN_OUTCOME_TEXT,
      });
      expect(request.mock.calls.filter(([method]) => method === "update.status")).toHaveLength(1);
    } finally {
      updateStatus.resolve({});
      overlays.dispose();
    }
  });

  it("ignores a status response from a retired reconnect", async () => {
    const retiredStatus = deferred();
    const firstRequest = vi.fn<RequestFn>((method) => {
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
        return retiredStatus.promise;
      }
      return Promise.resolve({});
    });
    const replacementRequest = vi.fn<RequestFn>((method) =>
      Promise.resolve(
        method === "update.status"
          ? {
              sentinel: {
                kind: "update",
                status: "ok",
                stats: { after: { version: "2.0.0" } },
              },
            }
          : [],
      ),
    );
    const harness = createGatewayHarness(client(firstRequest));
    const overlays = createApplicationOverlays(harness.gateway);

    try {
      await overlays.runUpdate();
      harness.update({ phase: "stopped" });
      harness.update({ phase: "connected" });
      await flushMicrotasks();
      expectUpdateStatusRequested(firstRequest);

      harness.update({ phase: "stopped" });
      harness.update({ client: client(replacementRequest), phase: "connected" });
      await flushMicrotasks();
      expectUpdateStatusRequested(replacementRequest);
      expect(overlays.snapshot.updateReconciliationPending).toBe(false);

      retiredStatus.resolve({
        sentinel: {
          kind: "update",
          status: "error",
          stats: { reason: "retired-result" },
        },
      });
      await flushMicrotasks();

      expect(overlays.snapshot.updateStatusBanner).toBeNull();
    } finally {
      retiredStatus.resolve({});
      overlays.dispose();
    }
  });
});
