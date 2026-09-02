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

const AUTO_UPDATE_SCHEDULE = {
  channel: "stable",
  autoEnabled: true,
  target: { kind: "package", version: "2.0.0" },
  campaign: {
    id: "campaign-auto",
    state: "countdown",
    announcedAtMs: 1_000,
    applyAtMs: 61_000,
    forceAtMs: 901_000,
    updatedAtMs: 1_000,
  },
} as const;

function createAutomaticUpdateHarness(request: RequestFn) {
  const harness = createGatewayHarness(client(request));
  harness.update({
    hello: {
      auth: { role: "operator", scopes: ["operator.admin"] },
      snapshot: { updateSchedule: AUTO_UPDATE_SCHEDULE },
    } as ApplicationGatewaySnapshot["hello"],
  });
  return harness;
}

describe("application update campaign overlays", () => {
  it("owns the running interlock while an automatic campaign applies", async () => {
    const request = vi.fn<RequestFn>(async () => ({}));
    const harness = createAutomaticUpdateHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      harness.emitEvent("update.available", {
        schedule: {
          ...AUTO_UPDATE_SCHEDULE,
          campaign: {
            ...AUTO_UPDATE_SCHEDULE.campaign,
            state: "applying",
            updatedAtMs: 61_000,
          },
        },
      });

      // This published fact also suspends writes at the app-lifetime config owner.
      expect(overlays.snapshot.updateRunning).toBe(true);
      await overlays.runUpdate();
      await expect(overlays.holdUpdate()).resolves.toBe(false);
      expect(request.mock.calls.map(([method]) => method)).not.toContain("update.run");
      expect(request.mock.calls.map(([method]) => method)).not.toContain("update.hold");

      harness.emitEvent("update.available", {
        schedule: { channel: "stable", autoEnabled: true },
      });
      expect(overlays.snapshot.updateRunning).toBe(false);
    } finally {
      overlays.dispose();
    }
  });

  it("reads the recorded outcome when an automatic campaign ends between polls", async () => {
    vi.useFakeTimers();
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.status"
        ? {
            sentinel: {
              kind: "update",
              status: "error",
              ts: 62_000,
              stats: { reason: "build-failed", mode: "git" },
            },
            schedule: { channel: "stable", autoEnabled: true },
          }
        : {},
    );
    const harness = createAutomaticUpdateHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      harness.emitEvent("update.available", {
        schedule: {
          ...AUTO_UPDATE_SCHEDULE,
          campaign: {
            ...AUTO_UPDATE_SCHEDULE.campaign,
            state: "applying",
            updatedAtMs: 61_000,
          },
        },
      });
      harness.emitEvent("update.available", {
        schedule: { channel: "stable", autoEnabled: true },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      expect(overlays.snapshot.updateStatusBanner?.text).toContain("build-failed");
      expect(overlays.snapshot.recordedUpdateAttempt).toMatchObject({
        timestampMs: 62_000,
        status: "error",
        reason: "build-failed",
      });
      expect(overlays.snapshot.updateSchedule?.campaign).toBeUndefined();
      const statusRequests = request.mock.calls.filter(([method]) => method === "update.status");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request.mock.calls.filter(([method]) => method === "update.status")).toHaveLength(
        statusRequests.length,
      );
    } finally {
      overlays.dispose();
    }
  });

  it.each(["manual refresh", "campaign poll"])(
    "does not let a %s replace a newer campaign event",
    async (source) => {
      vi.useFakeTimers();
      const updateStatus = deferred();
      const request = vi.fn<RequestFn>((method) =>
        method === "update.status" ? updateStatus.promise : Promise.resolve({}),
      );
      const harness = createAutomaticUpdateHarness(request);
      const overlays = createApplicationOverlays(harness.gateway);
      try {
        const refresh = source === "manual refresh" ? overlays.refreshUpdateStatus() : undefined;
        if (source === "campaign poll") {
          await vi.advanceTimersByTimeAsync(5_000);
        }
        expect(request.mock.calls.filter(([method]) => method === "update.status")).toHaveLength(1);
        harness.emitEvent("update.available", {
          schedule: {
            ...AUTO_UPDATE_SCHEDULE,
            campaign: {
              ...AUTO_UPDATE_SCHEDULE.campaign,
              state: "applying",
              updatedAtMs: 61_000,
            },
          },
        });
        updateStatus.resolve({
          sentinel: {
            kind: "update",
            status: "error",
            ts: 500,
            stats: { reason: "previous-build-failed" },
          },
          schedule: AUTO_UPDATE_SCHEDULE,
        });
        await refresh;
        await flushMicrotasks();

        expect(overlays.snapshot.updateSchedule?.campaign?.state).toBe("applying");
        expect(overlays.snapshot.updateStatusBanner).toBeNull();
        expect(overlays.snapshot.updateStatusRefreshing).toBe(false);
      } finally {
        updateStatus.resolve({});
        overlays.dispose();
      }
    },
  );

  it.each(["campaign ended", "disconnect", "dispose"])(
    "does not restart an in-flight campaign poll after %s",
    async (boundary) => {
      vi.useFakeTimers();
      const updateStatus = deferred();
      const request = vi.fn<RequestFn>((method) =>
        method === "update.status" ? updateStatus.promise : Promise.resolve({}),
      );
      const harness = createAutomaticUpdateHarness(request);
      const overlays = createApplicationOverlays(harness.gateway);
      try {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(request.mock.calls.filter(([method]) => method === "update.status")).toHaveLength(1);
        if (boundary === "campaign ended") {
          harness.emitEvent("update.available", {
            schedule: { channel: "stable", autoEnabled: true },
          });
        } else if (boundary === "disconnect") {
          harness.update({ phase: "reconnecting" });
        } else {
          overlays.dispose();
        }
        updateStatus.resolve({ schedule: AUTO_UPDATE_SCHEDULE });
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(request.mock.calls.filter(([method]) => method === "update.status")).toHaveLength(1);
      } finally {
        updateStatus.resolve({});
        overlays.dispose();
      }
    },
  );

  it("keeps a manual status check's error visible when campaign polling becomes due", async () => {
    vi.useFakeTimers();
    const manualStatus = deferred();
    const request = vi.fn<RequestFn>((method, params) => {
      if (method !== "update.status") {
        return Promise.resolve({});
      }
      return (params as { refreshCheckout?: boolean }).refreshCheckout
        ? manualStatus.promise
        : Promise.resolve({ schedule: AUTO_UPDATE_SCHEDULE });
    });
    const harness = createAutomaticUpdateHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      const refresh = overlays.refreshUpdateStatus();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(overlays.snapshot.updateStatusRefreshing).toBe(true);

      manualStatus.reject(new Error("manual status unavailable"));
      await refresh;

      expect(overlays.snapshot.updateStatusRefreshing).toBe(false);
      expect(overlays.snapshot.updateStatusBanner?.text).toContain("manual status unavailable");
    } finally {
      manualStatus.resolve({});
      overlays.dispose();
    }
  });

  it.each([false, true])(
    "discards an explicit refresh after administrator access is revoked (restored: %s)",
    async (restoreAdmin) => {
      const updateStatus = deferred();
      let statusReads = 0;
      const request = vi.fn<RequestFn>((method) => {
        if (method !== "update.status") {
          return Promise.resolve({});
        }
        statusReads += 1;
        return statusReads === 1
          ? Promise.resolve({
              sentinel: {
                kind: "update",
                status: "error",
                ts: 500,
                stats: { reason: "retained-admin-only-attempt" },
              },
            })
          : updateStatus.promise;
      });
      const harness = createAutomaticUpdateHarness(request);
      const overlays = createApplicationOverlays(harness.gateway);
      try {
        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("retained-admin-only-attempt");
        const refresh = overlays.refreshUpdateStatus();
        harness.update({
          hello: {
            auth: { role: "operator", scopes: ["operator.read"] },
            snapshot: { updateSchedule: AUTO_UPDATE_SCHEDULE },
          } as ApplicationGatewaySnapshot["hello"],
        });
        expect(overlays.snapshot.updateStatusBanner).toBeNull();
        expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();
        if (restoreAdmin) {
          harness.update({
            hello: {
              auth: { role: "operator", scopes: ["operator.admin"] },
              snapshot: { updateSchedule: AUTO_UPDATE_SCHEDULE },
            } as ApplicationGatewaySnapshot["hello"],
          });
        }
        updateStatus.resolve({
          sentinel: {
            kind: "update",
            status: "error",
            ts: 62_000,
            stats: { reason: "admin-only-attempt" },
          },
        });
        await refresh;

        expect(overlays.snapshot.updateStatusBanner).toBeNull();
        expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();
        expect(overlays.snapshot.updateStatusRefreshing).toBe(false);
      } finally {
        updateStatus.resolve({});
        overlays.dispose();
      }
    },
  );

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

  it.each([
    { boundary: "applying", reply: "success" },
    { boundary: "applying", reply: "error" },
    { boundary: "revoked", reply: "success" },
    { boundary: "revoked", reply: "error" },
  ])("does not publish a stale hold $reply after $boundary", async ({ boundary, reply }) => {
    const holdReply = deferred();
    const request = vi.fn<RequestFn>((method) =>
      method === "update.hold" ? holdReply.promise : Promise.resolve({}),
    );
    const harness = createAutomaticUpdateHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    const holding = overlays.holdUpdate();
    try {
      if (boundary === "applying") {
        harness.emitEvent("update.available", {
          schedule: {
            ...AUTO_UPDATE_SCHEDULE,
            campaign: { ...AUTO_UPDATE_SCHEDULE.campaign, state: "applying", updatedAtMs: 61_000 },
          },
        });
      } else {
        harness.update({
          hello: {
            auth: { role: "operator", scopes: ["operator.read"] },
            snapshot: { updateSchedule: AUTO_UPDATE_SCHEDULE },
          } as ApplicationGatewaySnapshot["hello"],
        });
      }
      if (reply === "success") {
        holdReply.resolve({
          ok: true,
          schedule: {
            ...AUTO_UPDATE_SCHEDULE,
            campaign: { ...AUTO_UPDATE_SCHEDULE.campaign, holdUntilMs: 3_601_000 },
          },
        });
      } else {
        holdReply.reject(new Error("retired hold response"));
      }
      await expect(holding).resolves.toBe(boundary === "applying" && reply === "success");

      expect(overlays.snapshot.updateRunning).toBe(boundary === "applying");
      expect(overlays.snapshot.updateSchedule?.campaign?.state).toBe(
        boundary === "applying" ? "applying" : "countdown",
      );
      expect(overlays.snapshot.heldUpdateCampaignId).toBeNull();
      expect(overlays.snapshot.updateStatusBanner).toBeNull();
    } finally {
      holdReply.resolve({});
      await holding;
      overlays.dispose();
    }
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
