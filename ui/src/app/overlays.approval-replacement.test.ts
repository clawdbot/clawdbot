// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  client,
  createGatewayHarness,
  deferred,
  type RequestFn,
} from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";

function approvalRace(id: string, replacementInstanceId: string) {
  const resolveAttempt = deferred();
  const request = vi.fn<RequestFn>((method) =>
    method.endsWith(".list") ? Promise.resolve([]) : resolveAttempt.promise,
  );
  const harness = createGatewayHarness(client(request));
  const overlays = createApplicationOverlays(harness.gateway);
  harness.emitApproval(id, 1_000);
  const original = overlays.snapshot.approvalQueue[0];
  const decision = overlays.decideApproval("allow-once");
  harness.emitApproval(id, 1_000, replacementInstanceId);
  return { decision, original, overlays, request, resolveAttempt };
}

describe("application approval replacement races", () => {
  for (const outcome of ["success", "failure"] as const) {
    it(`keeps a refreshed approval owned by its pending decision after ${outcome}`, async () => {
      const { decision, original, overlays, resolveAttempt } = approvalRace(
        "approval-refreshed",
        "approval-refreshed:1000",
      );

      expect(overlays.snapshot.approvalQueue[0]).not.toBe(original);
      expect(overlays.snapshot.approvalQueue[0]).toMatchObject({
        createdAtMs: 1_000,
        id: "approval-refreshed",
        kind: "exec",
      });

      if (outcome === "success") {
        resolveAttempt.resolve({ ok: true });
      } else {
        resolveAttempt.reject(new Error("gateway unavailable"));
      }
      await decision;

      if (outcome === "success") {
        expect(overlays.snapshot.approvalQueue).toEqual([]);
        expect(overlays.snapshot.approvalErrors).toEqual(new Map());
      } else {
        expect(overlays.snapshot.approvalQueue).toEqual([
          expect.objectContaining({ createdAtMs: 1_000, id: "approval-refreshed" }),
        ]);
        expect(overlays.snapshot.approvalErrors.get("approval-refreshed")).toBe(
          "Approval failed: gateway unavailable",
        );
      }
      expect(overlays.snapshot.approvalBusy).toBe(false);
      overlays.dispose();
    });
  }

  it.each([
    { error: undefined, name: "success", stale: false },
    { error: "gateway unavailable", name: "failure", stale: false },
    { error: "unknown or expired approval id", name: "stale failure", stale: true },
  ])(
    "keeps a same-id replacement after the original decision's $name",
    async ({ error, stale }) => {
      const { decision, overlays, request, resolveAttempt } = approvalRace(
        "approval-reused",
        "replacement-instance",
      );
      const listRequestCount = request.mock.calls.filter(([method]) =>
        method.endsWith(".list"),
      ).length;

      if (error) {
        resolveAttempt.reject(new Error(error));
      } else {
        resolveAttempt.resolve({ ok: true });
      }
      await decision;

      expect(overlays.snapshot.approvalQueue).toEqual([
        expect.objectContaining({ instanceId: "replacement-instance", id: "approval-reused" }),
      ]);
      expect(overlays.snapshot.approvalErrors).toEqual(new Map());
      if (stale) {
        expect(request.mock.calls.filter(([method]) => method.endsWith(".list"))).toHaveLength(
          listRequestCount,
        );
      }
      expect(overlays.snapshot.approvalBusy).toBe(false);
      overlays.dispose();
    },
  );
});
