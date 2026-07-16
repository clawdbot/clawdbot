import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeZalouser } from "./probe.js";
import { getZaloUserInfo } from "./zalo-js.js";

vi.mock("./zalo-js.js", () => ({
  getZaloUserInfo: vi.fn(),
}));

const mockGetUserInfo = vi.mocked(getZaloUserInfo);

describe("probeZalouser", () => {
  beforeEach(() => {
    mockGetUserInfo.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns ok=true with user when authenticated", async () => {
    mockGetUserInfo.mockResolvedValueOnce({
      userId: "123",
      displayName: "Alice",
    });

    await expect(probeZalouser("default")).resolves.toEqual({
      ok: true,
      user: { userId: "123", displayName: "Alice" },
    });
  });

  it("returns not authenticated when no user info is returned", async () => {
    mockGetUserInfo.mockResolvedValueOnce(null);
    await expect(probeZalouser("default")).resolves.toEqual({
      ok: false,
      error: "Not authenticated",
    });
  });

  it("returns error when user lookup throws", async () => {
    mockGetUserInfo.mockRejectedValueOnce(new Error("network down"));
    await expect(probeZalouser("default")).resolves.toEqual({
      ok: false,
      error: "network down",
    });
  });

  it("times out when lookup takes too long", async () => {
    vi.useFakeTimers();
    mockGetUserInfo.mockReturnValueOnce(new Promise(() => undefined));

    const pending = probeZalouser("default", 10);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toEqual({
      ok: false,
      error: "Not authenticated",
    });
  });
});
