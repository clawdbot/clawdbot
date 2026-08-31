// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import {
  client,
  createGatewayHarness,
  deferred,
  flushMicrotasks,
  type RequestFn,
} from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";

afterEach(() => vi.useRealTimers());

describe("application update campaign overlays", () => {
  it("refreshes an explicit dev checkout comparison on demand", async () => {
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.status"
        ? {
            sentinel: null,
            updateAvailable: null,
            schedule: {
              channel: "dev",
              autoEnabled: false,
              install: { kind: "git", git: { status: "behind", commitsBehind: 12 } },
            },
          }
        : {},
    );
    const harness = createGatewayHarness(client(request));
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        snapshot: { updateSchedule: { channel: "dev", autoEnabled: false } },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const overlays = createApplicationOverlays(harness.gateway);

    await overlays.refreshUpdateStatus();

    expect(request).toHaveBeenCalledWith(
      "update.status",
      { refreshCheckout: true },
      { timeoutMs: 5_000 },
    );
    expect(overlays.snapshot.updateSchedule?.install?.git).toEqual({
      status: "behind",
      commitsBehind: 12,
    });
    overlays.dispose();
  });

  it("publishes pending and error state when a manual status refresh fails", async () => {
    const updateStatus = deferred();
    const request = vi.fn<RequestFn>((method) =>
      method === "update.status" ? updateStatus.promise : Promise.resolve({}),
    );
    const harness = createGatewayHarness(client(request));
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const overlays = createApplicationOverlays(harness.gateway);

    const refresh = overlays.refreshUpdateStatus();
    expect(overlays.snapshot.updateStatusRefreshing).toBe(true);

    updateStatus.reject(new Error("Gateway unavailable"));
    await refresh;

    expect(overlays.snapshot.updateStatusRefreshing).toBe(false);
    expect(overlays.snapshot.updateStatusBanner).toEqual({
      tone: "danger",
      text: expect.stringContaining("Gateway unavailable"),
    });
    overlays.dispose();
  });

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

  it("keeps an expired hold consumed after reconnect", async () => {
    const request = vi.fn<RequestFn>(async () => ({}));
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
              id: "campaign-held",
              state: "waiting-for-idle",
              announcedAtMs: 1_000,
              holdUntilMs: 2_000,
              forceAtMs: 902_000,
              updatedAtMs: 2_000,
            },
          },
        },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const overlays = createApplicationOverlays(harness.gateway);

    expect(overlays.snapshot.heldUpdateCampaignId).toBe("campaign-held");
    await expect(overlays.holdUpdate()).resolves.toBe(false);
    expect(request.mock.calls.filter(([method]) => method === "update.hold")).toHaveLength(0);
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
      expect(overlays.snapshot.updateCampaignStatusHydrated).toBe(false);
      expect(overlays.snapshot.updateSchedule?.campaign?.id).toBe("campaign-2");
    } finally {
      overlays.dispose();
    }
  });

  it("holds a campaign surface until its first authoritative status arrives", async () => {
    vi.useFakeTimers();
    const updateStatus = deferred();
    const request = vi.fn<RequestFn>((method) =>
      method === "update.status" ? updateStatus.promise : Promise.resolve({}),
    );
    const harness = createGatewayHarness(client(request));
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        snapshot: {
          updateSchedule: {
            channel: "dev",
            autoEnabled: true,
            campaign: {
              id: "campaign-blocked",
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

    expect(overlays.snapshot.updateCampaignStatusHydrated).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request.mock.calls.filter(([method]) => method === "update.status")).toHaveLength(1);
    expect(overlays.snapshot.updateCampaignStatusHydrated).toBe(false);

    updateStatus.resolve({
      sentinel: {
        kind: "update",
        status: "error",
        stats: { reason: "build-dirty" },
      },
    });
    await flushMicrotasks();

    expect(overlays.snapshot.updateCampaignStatusHydrated).toBe(true);
    expect(overlays.snapshot.updateStatusBanner?.text).toContain("build-dirty");
    overlays.dispose();
  });

  it("holds an active campaign and adopts the returned schedule", async () => {
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.hold"
        ? {
            ok: true,
            schedule: {
              channel: "stable",
              autoEnabled: true,
              target: { kind: "package", version: "2.0.0" },
              campaign: {
                id: "campaign-1",
                state: "waiting-for-idle",
                announcedAtMs: 1_000,
                holdUntilMs: 3_601_000,
                forceAtMs: 4_501_000,
                updatedAtMs: 1_000,
              },
            },
          }
        : {},
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
              applyAtMs: 61_000,
              forceAtMs: 901_000,
              updatedAtMs: 1_000,
            },
          },
        },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const overlays = createApplicationOverlays(harness.gateway);

    await expect(overlays.holdUpdate()).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith("update.hold", {});
    expect(overlays.snapshot.updateSchedule?.campaign).toMatchObject({
      state: "waiting-for-idle",
      holdUntilMs: 3_601_000,
    });
    expect(overlays.snapshot.heldUpdateCampaignId).toBe("campaign-1");

    harness.emitEvent("update.available", {
      updateAvailable: null,
      schedule: { channel: "stable", autoEnabled: true },
    });
    await expect(overlays.holdUpdate()).resolves.toBe(false);
    expect(request.mock.calls.filter(([method]) => method === "update.hold")).toHaveLength(1);
    overlays.dispose();
  });

  it("adopts an authoritative held schedule when update.hold returns false", async () => {
    const request = vi.fn<RequestFn>(async () => ({
      ok: false,
      schedule: {
        channel: "dev",
        autoEnabled: true,
        campaign: {
          id: "campaign-1",
          state: "waiting-for-idle",
          announcedAtMs: 1_000,
          holdUntilMs: 3_601_000,
          forceAtMs: 4_501_000,
          updatedAtMs: 1_000,
        },
      },
    }));
    const harness = createGatewayHarness(client(request));
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        snapshot: {
          updateSchedule: {
            channel: "dev",
            autoEnabled: true,
            campaign: {
              id: "campaign-1",
              state: "countdown",
              announcedAtMs: 1_000,
              applyAtMs: 61_000,
              forceAtMs: 901_000,
              updatedAtMs: 1_000,
            },
          },
        },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const overlays = createApplicationOverlays(harness.gateway);

    await expect(overlays.holdUpdate()).resolves.toBe(false);
    expect(overlays.snapshot.updateSchedule?.campaign).toMatchObject({
      state: "waiting-for-idle",
      holdUntilMs: 3_601_000,
    });
    expect(overlays.snapshot.heldUpdateCampaignId).toBe("campaign-1");
    overlays.dispose();
  });

  it("does not hold while an update run or its reconciliation is pending", async () => {
    let resolveUpdateRun: (value: unknown) => void = () => undefined;
    const updateRun = new Promise((resolve) => {
      resolveUpdateRun = resolve;
    });
    const request = vi.fn<RequestFn>((method) =>
      method === "update.run" ? updateRun : Promise.resolve({ ok: true }),
    );
    const harness = createGatewayHarness(client(request));
    harness.update({
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        snapshot: {
          updateSchedule: {
            channel: "stable",
            autoEnabled: true,
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

    const running = overlays.runUpdate();
    await flushMicrotasks();
    expect(overlays.snapshot.updateRunning).toBe(true);
    await expect(overlays.holdUpdate()).resolves.toBe(false);

    resolveUpdateRun({ ok: true, result: { status: "ok" } });
    await running;
    expect(overlays.snapshot.updateRunning).toBe(false);
    await expect(overlays.holdUpdate()).resolves.toBe(false);
    expect(request.mock.calls.filter(([method]) => method === "update.hold")).toHaveLength(0);
    overlays.dispose();
  });
});
