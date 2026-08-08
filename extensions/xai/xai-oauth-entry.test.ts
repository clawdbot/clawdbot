import { beforeEach, describe, expect, it, vi } from "vitest";

const oauthRuntimeMocks = vi.hoisted(() => ({
  loginXaiDeviceCode: vi.fn(),
  refreshXaiOAuthCredential: vi.fn(),
}));

vi.mock("./xai-oauth.js", () => oauthRuntimeMocks);

beforeEach(() => {
  vi.resetModules();
  oauthRuntimeMocks.loginXaiDeviceCode.mockReset();
  oauthRuntimeMocks.refreshXaiOAuthCredential.mockReset();
  oauthRuntimeMocks.loginXaiDeviceCode.mockResolvedValue({ profiles: [] });
  oauthRuntimeMocks.refreshXaiOAuthCredential.mockResolvedValue({
    type: "oauth",
    provider: "xai",
    access: "next-access",
    refresh: "next-refresh",
    expires: 123,
  });
});

describe("xAI OAuth lazy entry", () => {
  it("loads OAuth runtime only when an auth operation runs", async () => {
    const entry = await import("./xai-oauth-entry.js");
    const method = entry.createXaiOAuthAuthMethod();

    expect(oauthRuntimeMocks.loginXaiDeviceCode).not.toHaveBeenCalled();
    expect(oauthRuntimeMocks.refreshXaiOAuthCredential).not.toHaveBeenCalled();

    await method.run({} as never);
    expect(oauthRuntimeMocks.loginXaiDeviceCode).toHaveBeenCalledOnce();

    await entry.refreshXaiOAuthCredential({
      type: "oauth",
      provider: "xai",
      access: "access",
      refresh: "refresh",
      expires: 1,
    });
    expect(oauthRuntimeMocks.refreshXaiOAuthCredential).toHaveBeenCalledOnce();
  });
});
