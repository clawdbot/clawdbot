import { beforeEach, describe, expect, it, vi } from "vitest";

const checkUpdateStatusMock = vi.hoisted(() => vi.fn());
const versionMock = vi.hoisted(() => ({ value: "1.0.0" }));

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
  getUpdateAvailable: () => null,
}));

vi.mock("../../version.js", () => ({
  get VERSION() {
    return versionMock.value;
  },
}));

vi.mock("../server-restart-sentinel.js", () => ({
  getLatestUpdateRestartSentinel: () => null,
  refreshLatestUpdateRestartSentinel: async () => null,
}));

vi.mock("./validation.js", () => ({
  assertValidParams: () => true,
}));

beforeEach(() => {
  versionMock.value = "1.0.0";
  checkUpdateStatusMock.mockReset();
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
});
