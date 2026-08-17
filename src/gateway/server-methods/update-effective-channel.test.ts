import { beforeEach, describe, expect, it, vi } from "vitest";
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
const getUpdateEffectiveChannelMock = vi.hoisted(() => vi.fn<() => UpdateChannel>(() => "stable"));
const getUpdateScheduleMock = vi.hoisted(() => vi.fn<() => TestUpdateSchedule>(() => null));
const refreshGatewayUpdateStatusMock = vi.hoisted(() => vi.fn(async () => {}));
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
  getUpdateEffectiveChannelMock.mockReturnValue("stable");
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
    getUpdateEffectiveChannelMock.mockReturnValueOnce("extended-stable");
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
  });

  it("scopes explicit checkout refreshes to the current config identity", async () => {
    const { updateHandlers } = await import("./update.js");
    const handler = updateHandlers["update.status"];
    if (!handler) {
      throw new Error("update.status handler is unavailable");
    }
    const config = { update: { channel: "dev" as const } };
    const context = { getRuntimeConfig: () => config };

    await handler({ params: {}, respond: vi.fn(), context } as never);
    expect(refreshGatewayUpdateStatusMock).not.toHaveBeenCalled();

    let settleRefresh: (() => void) | undefined;
    refreshGatewayUpdateStatusMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settleRefresh = resolve;
        }),
    );
    const first = handler({
      params: { refreshCheckout: true },
      respond: vi.fn(),
      context,
    } as never);
    const second = handler({
      params: { refreshCheckout: true },
      respond: vi.fn(),
      context,
    } as never);
    await vi.waitFor(() => expect(refreshGatewayUpdateStatusMock).toHaveBeenCalledTimes(1));

    await handler({
      params: { refreshCheckout: true },
      respond: vi.fn(),
      context: { getRuntimeConfig: () => ({ update: { channel: "beta" } }) },
    } as never);
    expect(refreshGatewayUpdateStatusMock).toHaveBeenCalledTimes(2);

    settleRefresh?.();
    await Promise.all([first, second]);

    await handler({ params: { refreshCheckout: true }, respond: vi.fn(), context } as never);
    expect(refreshGatewayUpdateStatusMock).toHaveBeenCalledTimes(3);
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
