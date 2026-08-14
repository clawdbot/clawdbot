import { beforeEach, describe, expect, it, vi } from "vitest";

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

const checkUpdateStatusMock = vi.hoisted(() => vi.fn());
const versionMock = vi.hoisted(() => ({ value: "1.0.0" }));
const getUpdateAvailableMock = vi.hoisted(() => vi.fn<() => TestUpdateAvailable>(() => null));
const getUpdateScheduleMock = vi.hoisted(() => vi.fn<() => TestUpdateSchedule>(() => null));
const refreshGatewayUpdateStatusMock = vi.hoisted(() => vi.fn(async () => {}));
const getLatestUpdateRestartSentinelMock = vi.hoisted(() =>
  vi.fn<() => TestUpdateSentinel>(() => null),
);
const refreshLatestUpdateRestartSentinelMock = vi.hoisted(() =>
  vi.fn<() => Promise<TestUpdateSentinel>>(async () => null),
);

vi.mock("../../infra/openclaw-root.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/openclaw-root.js")>(
    "../../infra/openclaw-root.js",
  );
  return { ...actual, resolveOpenClawPackageRoot: async () => "/tmp/openclaw" };
});

vi.mock("../../infra/update-check.js", () => ({
  checkUpdateStatus: checkUpdateStatusMock,
}));

vi.mock("../../infra/update-startup.js", () => ({
  getUpdateAvailable: getUpdateAvailableMock,
  getUpdateSchedule: getUpdateScheduleMock,
  refreshGatewayUpdateStatus: refreshGatewayUpdateStatusMock,
}));

vi.mock("../../version.js", () => ({
  get VERSION() {
    return versionMock.value;
  },
}));

vi.mock("../server-restart-sentinel.js", () => ({
  getLatestUpdateRestartSentinel: getLatestUpdateRestartSentinelMock,
  refreshLatestUpdateRestartSentinel: refreshLatestUpdateRestartSentinelMock,
}));

vi.mock("./validation.js", () => ({
  assertValidParams: () => true,
}));

beforeEach(() => {
  versionMock.value = "1.0.0";
  checkUpdateStatusMock.mockReset();
  getUpdateAvailableMock.mockReset();
  getUpdateAvailableMock.mockReturnValue(null);
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
  it("reports a verified configless extended-stable package channel", async () => {
    versionMock.value = "2026.6.33";
    checkUpdateStatusMock.mockResolvedValueOnce({
      root: "/tmp/openclaw",
      installKind: "package",
      packageManager: "npm",
    });
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
