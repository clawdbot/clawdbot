import { beforeEach, describe, expect, it, vi } from "vitest";

const { oauthRuntimeMocks, oauthRuntimeLoaded } = vi.hoisted(() => ({
  oauthRuntimeMocks: {
    loginXaiDeviceCode: vi.fn(),
    refreshXaiOAuthCredential: vi.fn(),
  },
  oauthRuntimeLoaded: vi.fn(),
}));

vi.mock("./xai-oauth.js", () => {
  oauthRuntimeLoaded();
  return oauthRuntimeMocks;
});

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

    expect(oauthRuntimeLoaded).not.toHaveBeenCalled();
    expect(oauthRuntimeMocks.loginXaiDeviceCode).not.toHaveBeenCalled();
    expect(oauthRuntimeMocks.refreshXaiOAuthCredential).not.toHaveBeenCalled();

    await method.run({} as never);
    expect(oauthRuntimeLoaded).toHaveBeenCalledOnce();
    expect(oauthRuntimeMocks.loginXaiDeviceCode).toHaveBeenCalledOnce();

    await entry.refreshXaiOAuthCredential({
      type: "oauth",
      provider: "xai",
      access: "access",
      refresh: "refresh",
      expires: 1,
    });
    expect(oauthRuntimeLoaded).toHaveBeenCalledOnce();
    expect(oauthRuntimeMocks.refreshXaiOAuthCredential).toHaveBeenCalledOnce();
  });
});
