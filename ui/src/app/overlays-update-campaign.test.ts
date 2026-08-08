// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import {
  client,
  createGatewayHarness,
  flushMicrotasks,
  type RequestFn,
} from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";

afterEach(() => vi.useRealTimers());

describe("application update campaign overlays", () => {
  it("hydrates campaign state from hello and update.available events", () => {
    const harness = createGatewayHarness(client(async () => ({})));
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
        snapshot: {
          updateSchedule: {
            channel: "stable",
            autoEnabled: true,
            target: { kind: "package", version: "2.0.0" },
            campaign: {
              id: "campaign-1",
              state: "waiting-for-idle",
              announcedAtMs: 1_000,
              forceAtMs: 901_000,
              updatedAtMs: 1_000,
            },
          },
        },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const overlays = createApplicationOverlays(harness.gateway);

    expect(overlays.snapshot.updateSchedule?.campaign?.state).toBe("waiting-for-idle");

    harness.emitEvent("update.available", {
      updateAvailable: {
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        channel: "stable",
      },
      schedule: {
        channel: "stable",
        autoEnabled: true,
        target: { kind: "package", version: "2.0.0" },
        campaign: {
          id: "campaign-1",
          state: "countdown",
          announcedAtMs: 1_000,
          applyAtMs: 62_000,
          forceAtMs: 901_000,
          updatedAtMs: 2_000,
        },
      },
    });

    expect(overlays.snapshot.updateAvailable?.latestVersion).toBe("2.0.0");
    expect(overlays.snapshot.updateSchedule?.campaign?.state).toBe("countdown");
    overlays.dispose();
  });

  it("polls update.status only for administrators with an active campaign", async () => {
    vi.useFakeTimers();
    const request = vi.fn<RequestFn>((method) =>
      Promise.resolve(
        method === "update.status"
          ? {
              sentinel: {
                kind: "update",
                status: "error",
                stats: { reason: "build-failed" },
              },
              updateAvailable: {
                currentVersion: "1.0.0",
                latestVersion: "2.0.0",
                channel: "stable",
              },
              schedule: {
                channel: "stable",
                autoEnabled: true,
                target: { kind: "package", version: "2.0.0" },
              },
            }
          : {},
      ),
    );
    const harness = createGatewayHarness(client(request));
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        snapshot: {
          updateSchedule: {
            channel: "stable",
            autoEnabled: true,
            target: { kind: "package", version: "2.0.0" },
            campaign: {
              id: "campaign-1",
              state: "countdown",
              announcedAtMs: 1_000,
              applyAtMs: 62_000,
              forceAtMs: 901_000,
              updatedAtMs: 2_000,
            },
          },
        },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const overlays = createApplicationOverlays(harness.gateway);

    try {
      await vi.advanceTimersByTimeAsync(4_000);
      harness.update({ sessionKey: "agent:main:active" });
      await vi.advanceTimersByTimeAsync(1_000);
      await flushMicrotasks();
      expect(request.mock.calls.filter(([method]) => method === "update.status")).toHaveLength(1);
      expect(overlays.snapshot.updateSchedule?.campaign).toBeUndefined();
      expect(overlays.snapshot.updateStatusBanner?.text).toContain("build-failed");

      await vi.advanceTimersByTimeAsync(10_000);
      await flushMicrotasks();
      expect(request.mock.calls.filter(([method]) => method === "update.status")).toHaveLength(1);

      harness.update({
        hello: {
          auth: { role: "operator", scopes: ["operator.read"] },
          snapshot: {
            updateSchedule: {
              channel: "stable",
              autoEnabled: true,
              campaign: {
                id: "campaign-2",
                state: "waiting-for-idle",
                announcedAtMs: 20_000,
                forceAtMs: 920_000,
                updatedAtMs: 20_000,
              },
            },
          },
        } as ApplicationGatewaySnapshot["hello"],
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await flushMicrotasks();
      expect(request.mock.calls.filter(([method]) => method === "update.status")).toHaveLength(1);
    } finally {
      overlays.dispose();
    }
  });
});
