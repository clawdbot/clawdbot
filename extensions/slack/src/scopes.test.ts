// Slack tests cover scopes plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const createSlackReadClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createSlackReadClient: createSlackReadClientMock,
}));

const { fetchSlackScopes } = await import("./scopes.js");

function mockSlackClient(apiCall: ReturnType<typeof vi.fn>) {
  createSlackReadClientMock.mockReturnValue({ apiCall });
}

describe("fetchSlackScopes", () => {
  beforeEach(() => {
    createSlackReadClientMock.mockReset();
  });

  it("uses auth.test response metadata scopes for modern bot tokens", async () => {
    const apiCall = vi.fn().mockResolvedValue({
      ok: true,
      user_id: "U123",
      response_metadata: { scopes: ["chat:write", "im:history"] },
    });
    mockSlackClient(apiCall);

    await expect(fetchSlackScopes("xoxb-token", 1234)).resolves.toEqual({
      ok: true,
      scopes: ["chat:write", "im:history"],
      source: "auth.test",
    });
    expect(createSlackReadClientMock).toHaveBeenCalledWith("xoxb-token", { timeout: 1234 });
    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(apiCall).toHaveBeenCalledWith("auth.test");
  });

  it("falls back to legacy scope methods when auth.test has no scope metadata", async () => {
    const apiCall = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, scopes: "channels:read,chat:write" });
    mockSlackClient(apiCall);

    await expect(fetchSlackScopes("xoxb-token", 5000)).resolves.toEqual({
      ok: true,
      scopes: ["channels:read", "chat:write"],
      source: "auth.scopes",
    });
    expect(apiCall.mock.calls.map((call) => call[0])).toEqual(["auth.test", "auth.scopes"]);
  });

  it("includes auth.test in the diagnostic when every method fails", async () => {
    const apiCall = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "invalid_auth" })
      .mockResolvedValueOnce({ ok: false, error: "unknown_method" })
      .mockResolvedValueOnce({ ok: false, error: "unknown_method" });
    mockSlackClient(apiCall);

    await expect(fetchSlackScopes("xoxb-token", 5000)).resolves.toEqual({
      ok: false,
      error:
        "auth.test: invalid_auth | auth.scopes: unknown_method | apps.permissions.info: unknown_method",
    });
  });

  it("surfaces a revoked/expired user token (SLACK_USER_TOKEN) with a clear regenerate-the-token message instead of a raw SDK error, when the SDK throws for the { ok: false } body", async () => {
    const platformError = new Error("An API error occurred: token_revoked") as Error & {
      code: string;
      data: { ok: false; error: string };
    };
    platformError.code = "slack_webapi_platform_error";
    platformError.data = { ok: false, error: "token_revoked" };
    const apiCall = vi.fn().mockRejectedValue(platformError);
    mockSlackClient(apiCall);

    const result = await fetchSlackScopes("xoxp-revoked-user-token", 5000);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("token_revoked");
    expect(result.error).toContain("Regenerate the token");
  });
});
