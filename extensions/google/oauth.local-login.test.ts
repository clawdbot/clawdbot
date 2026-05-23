import { beforeEach, describe, expect, it, vi } from "vitest";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth?state=state-123";

const exchangeCodeForTokensMock = vi.hoisted(() =>
  vi.fn(async () => ({
    access: "access-token",
    refresh: "refresh-token",
    expires: 123,
  })),
);
const waitForLocalCallbackMock = vi.hoisted(() =>
  vi.fn(async () => ({ code: "oauth-code", state: "state-123" })),
);

vi.mock("./oauth.flow.js", () => ({
  buildAuthUrl: () => AUTH_URL,
  generateOAuthState: () => "state-123",
  generatePkce: () => ({ challenge: "pkce-challenge", verifier: "pkce-verifier" }),
  parseCallbackInput: vi.fn(),
  shouldUseManualOAuthFlow: (isRemote: boolean) => isRemote,
  waitForLocalCallback: waitForLocalCallbackMock,
}));

vi.mock("./oauth.token.js", () => ({
  exchangeCodeForTokens: exchangeCodeForTokensMock,
}));

describe("loginGeminiCliOAuth local browser flow", () => {
  beforeEach(() => {
    exchangeCodeForTokensMock.mockClear();
    waitForLocalCallbackMock.mockClear();
  });

  it("prints the auth URL before attempting best-effort browser launch", async () => {
    const events: string[] = [];
    const { loginGeminiCliOAuth } = await import("./oauth.js");
    const openUrl = vi.fn(async () => {
      events.push("open");
    });
    const log = vi.fn((message: string) => {
      events.push(`log:${message}`);
    });

    const result = await loginGeminiCliOAuth({
      isRemote: false,
      openUrl,
      log,
      note: async () => {},
      prompt: async () => "",
      progress: { update: () => {}, stop: () => {} },
    });

    expect(result).toEqual({
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(AUTH_URL));
    expect(openUrl).toHaveBeenCalledWith(AUTH_URL);
    expect(events.findIndex((event) => event.startsWith("log:"))).toBeLessThan(
      events.indexOf("open"),
    );
    expect(waitForLocalCallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: "state-123" }),
    );
    expect(exchangeCodeForTokensMock).toHaveBeenCalledWith("oauth-code", "pkce-verifier");
  });
});
