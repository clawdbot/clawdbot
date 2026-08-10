import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenManager } from "../api/token.js";
import { ApiError } from "../types.js";
import { registerAccount, withTokenRetry } from "./sender.js";

describe("QQBot token retry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes when QQ reports an expired token as HTTP 500 with business code 11244", async () => {
    const getAccessToken = vi
      .spyOn(TokenManager.prototype, "getAccessToken")
      .mockResolvedValueOnce("expired-token")
      .mockResolvedValueOnce("fresh-token");
    const clearCache = vi.spyOn(TokenManager.prototype, "clearCache");
    const send = vi
      .fn<(token: string) => Promise<string>>()
      // Keep the message free of retry keywords so the structured code is the only signal.
      .mockRejectedValueOnce(new ApiError("credential rejected", 500, "/gateway", 11244))
      .mockResolvedValueOnce("sent");
    const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    registerAccount("retry-app", { logger });

    await expect(
      withTokenRetry({ appId: "retry-app", clientSecret: "secret" }, send, logger),
    ).resolves.toBe("sent");

    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(clearCache).toHaveBeenCalledWith("retry-app");
    expect(send).toHaveBeenNthCalledWith(1, "expired-token");
    expect(send).toHaveBeenNthCalledWith(2, "fresh-token");
  });
});
