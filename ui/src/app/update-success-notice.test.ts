// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSafeSessionStorageMock, reloadControlUiIfStaleMock, showToastMock } = vi.hoisted(() => ({
  getSafeSessionStorageMock: vi.fn(),
  reloadControlUiIfStaleMock: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock("../build-info.ts", () => ({
  reloadControlUiIfStale: reloadControlUiIfStaleMock,
}));
vi.mock("../i18n/index.ts", () => ({
  t: (_key: string, params?: Record<string, string>) => `Gateway updated · now on ${params?.sha}.`,
}));
vi.mock("../lib/toast.ts", () => ({ showToast: showToastMock }));
vi.mock("../local-storage.ts", () => ({
  getSafeSessionStorage: getSafeSessionStorageMock,
}));

describe("update success notice", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getSafeSessionStorageMock.mockReturnValue(null);
    reloadControlUiIfStaleMock.mockReturnValue(false);
  });

  it("announces a non-reloading success when session storage is unavailable", async () => {
    const { announceVerifiedUpdateInstall } = await import("./update-success-notice.ts");

    announceVerifiedUpdateInstall(
      { version: "2026.8.11", sha: "abcdef1234567890" },
      { gateway: "ws://gateway.test", profileId: null },
    );

    expect(showToastMock).toHaveBeenCalledWith({
      message: "Gateway updated · now on abcdef1.",
    });
  });
});
