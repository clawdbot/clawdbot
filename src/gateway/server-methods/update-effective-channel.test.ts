import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { UpdateChannel } from "../../infra/update-channels.js";

type TestUpdateAvailable = {
  currentVersion: string;
  latestVersion: string;
  channel: string;
} | null;
type TestUpdateSentinel = {
  kind: string;
  status: string;
  ts: number;
  stats: Record<string, unknown>;
} | null;
type TestUpdateSchedule =
  | import("../../../packages/gateway-protocol/src/index.js").UpdateScheduleState
  | null;

const getUpdateAvailableMock = vi.hoisted(() => vi.fn<() => TestUpdateAvailable>(() => null));
const getUpdateEffectiveChannelMock = vi.hoisted(() =>
  vi.fn<() => Promise<UpdateChannel>>(async () => "stable"),
);
const getUpdateScheduleMock = vi.hoisted(() => vi.fn<() => TestUpdateSchedule>(() => null));
const refreshGatewayUpdateStatusMock = vi.hoisted(() =>
  vi.fn<typeof import("../../infra/update-startup.js").refreshGatewayUpdateStatus>(async () => {}),
);
const getLatestUpdateRestartSentinelMock = vi.hoisted(() =>
  vi.fn<() => TestUpdateSentinel>(() => null),
);
const refreshLatestUpdateRestartSentinelMock = vi.hoisted(() =>
  vi.fn<() => Promise<TestUpdateSentinel>>(async () => null),
);

vi.mock("../../infra/update-startup.js", () => ({
  getUpdateAvailable: getUpdateAvailableMock,
  getUpdateEffectiveChannel: getUpdateEffectiveChannelMock,
  getUpdateSchedule: getUpdateScheduleMock,
  refreshGatewayUpdateStatus: refreshGatewayUpdateStatusMock,
}));

vi.mock("../server-restart-sentinel.js", () => ({
  getLatestUpdateRestartSentinel: getLatestUpdateRestartSentinelMock,
  refreshLatestUpdateRestartSentinel: refreshLatestUpdateRestartSentinelMock,
}));

vi.mock("./validation.js", () => ({
  assertValidParams: () => true,
}));

beforeEach(() => {
  getUpdateAvailableMock.mockReset();
  getUpdateAvailableMock.mockReturnValue(null);
  getUpdateEffectiveChannelMock.mockReset();
  getUpdateEffectiveChannelMock.mockResolvedValue("stable");
  getUpdateScheduleMock.mockReset();
  getUpdateScheduleMock.mockReturnValue(null);
  refreshGatewayUpdateStatusMock.mockReset();
  refreshGatewayUpdateStatusMock.mockResolvedValue(undefined);
  getLatestUpdateRestartSentinelMock.mockReset();
  getLatestUpdateRestartSentinelMock.mockReturnValue(null);
  refreshLatestUpdateRestartSentinelMock.mockReset();
  refreshLatestUpdateRestartSentinelMock.mockResolvedValue(null);
});

describe("update.status effective channel", () => {
  it("reports the lifecycle-owned channel before the startup schedule is ready", async () => {
    getUpdateEffectiveChannelMock.mockResolvedValueOnce("extended-stable");
    const { updateHandlers } = await import("./update.js");
    const respond = vi.fn();

    const handler = updateHandlers["update.status"];
    if (!handler) {
      throw new Error("update.status handler is unavailable");
    }
    await handler({
      params: {},
      respond,
      context: { getRuntimeConfig: () => ({ update: {} }) },
    } as never);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ effectiveChannel: "extended-stable" }),
    );
    expect(refreshGatewayUpdateStatusMock).not.toHaveBeenCalled();
  });

  it("prefers the current config channel over the startup schedule", async () => {
    getUpdateScheduleMock.mockReturnValueOnce({ channel: "beta", autoEnabled: true });
    const { updateHandlers } = await import("./update.js");
    const respond = vi.fn();
    const handler = updateHandlers["update.status"];
    if (!handler) {
      throw new Error("update.status handler is unavailable");
    }

    await handler({
      params: {},
      respond,
      context: { getRuntimeConfig: () => ({ update: { channel: "dev" } }) },
    } as never);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ effectiveChannel: "dev" }),
    );
    expect(getUpdateEffectiveChannelMock).not.toHaveBeenCalled();
  });

  it("awaits the current config's checkout refresh before reporting its schedule", async () => {
    const { updateHandlers } = await import("./update.js");
    const handler = updateHandlers["update.status"];
    if (!handler) {
      throw new Error("update.status handler is unavailable");
    }
    const config = { update: { channel: "dev" as const } };
    const context = { getRuntimeConfig: () => config };
    const refresh = createDeferred();
    refreshGatewayUpdateStatusMock.mockReturnValueOnce(refresh.promise);
    const respond = vi.fn();
    const checking = handler({
      params: { refreshCheckout: true },
      respond,
      context,
    } as never);
    const schedule = { channel: "dev" as const, autoEnabled: false };
    try {
      await vi.waitFor(() => expect(refreshGatewayUpdateStatusMock).toHaveBeenCalledOnce());
      expect(refreshGatewayUpdateStatusMock.mock.calls[0]?.[0]).toBe(config);
      expect(getUpdateScheduleMock).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
      getUpdateScheduleMock.mockReturnValue(schedule);
    } finally {
      refresh.resolve();
      await checking;
    }
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ effectiveChannel: "dev", schedule }),
    );
  });

  it("keeps status available when install identity initialization fails", async () => {
    getUpdateEffectiveChannelMock.mockRejectedValueOnce(new Error("probe failed"));
    const warn = vi.fn();
    const { updateHandlers } = await import("./update.js");
    const respond = vi.fn();

    const handler = updateHandlers["update.status"];
    if (!handler) {
      throw new Error("update.status handler is unavailable");
    }
    await handler({ params: {}, respond, context: { logGateway: { warn } } } as never);

    expect(warn).toHaveBeenCalledWith("update.status install identity failed: probe failed");
    expect(respond).toHaveBeenCalledWith(true, { sentinel: null, updateAvailable: null });
  });

  it("refreshes the latest update sentinel before responding", async () => {
    getUpdateAvailableMock.mockReturnValueOnce({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "latest",
    });
    getLatestUpdateRestartSentinelMock.mockReturnValueOnce({
      kind: "update",
      status: "skipped",
      ts: 1,
      stats: { reason: "restart-health-pending" },
    });
    refreshLatestUpdateRestartSentinelMock.mockResolvedValueOnce({
      kind: "update",
      status: "ok",
      ts: 2,
      stats: { after: { version: "2.0.0" } },
    });
    getUpdateScheduleMock.mockReturnValueOnce({ channel: "beta", autoEnabled: true });
    const { updateHandlers } = await import("./update.js");
    const respond = vi.fn();

    const handler = updateHandlers["update.status"];
    if (!handler) {
      throw new Error("update.status handler is unavailable");
    }
    await handler({ params: {}, respond } as never);

    expect(refreshLatestUpdateRestartSentinelMock).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sentinel: expect.objectContaining({ kind: "update", status: "ok" }),
        updateAvailable: expect.objectContaining({ latestVersion: "2.0.0" }),
        schedule: expect.objectContaining({ channel: "beta" }),
      }),
    );
    expect(getUpdateEffectiveChannelMock).not.toHaveBeenCalled();
  });

  it("falls back to the cached update sentinel when refresh fails", async () => {
    refreshLatestUpdateRestartSentinelMock.mockRejectedValueOnce(new Error("read failed"));
    getLatestUpdateRestartSentinelMock.mockReturnValueOnce({
      kind: "update",
      status: "skipped",
      ts: 1,
      stats: { reason: "restart-health-pending" },
    });
    const warn = vi.fn();
    const { updateHandlers } = await import("./update.js");
    const respond = vi.fn();

    const handler = updateHandlers["update.status"];
    if (!handler) {
      throw new Error("update.status handler is unavailable");
    }
    await handler({ params: {}, respond, context: { logGateway: { warn } } } as never);

    expect(warn).toHaveBeenCalledWith("update.status sentinel refresh failed: read failed");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sentinel: expect.objectContaining({ status: "skipped" }) }),
    );
  });
});
