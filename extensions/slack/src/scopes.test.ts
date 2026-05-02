import { beforeEach, describe, expect, it, vi } from "vitest";

const createSlackWebClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createSlackWebClient: createSlackWebClientMock,
}));

const { fetchSlackScopes } = await import("./scopes.js");

function mockSlackClient(apiCall: ReturnType<typeof vi.fn>) {
  createSlackWebClientMock.mockReturnValue({ apiCall });
}

describe("fetchSlackScopes", () => {
  beforeEach(() => {
    createSlackWebClientMock.mockReset();
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
    expect(createSlackWebClientMock).toHaveBeenCalledWith("xoxb-token", { timeout: 1234 });
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
});
