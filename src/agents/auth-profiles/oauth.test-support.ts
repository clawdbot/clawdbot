import "./oauth.js";

type OAuthTestApi = {
  isRefreshTokenReusedError(error: unknown): boolean;
  resetOAuthRefreshQueuesForTest(): void;
};

function getTestApi(): OAuthTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.oauthTestApi")
  ] as OAuthTestApi;
}

export const isRefreshTokenReusedError = (error: unknown): boolean =>
  getTestApi().isRefreshTokenReusedError(error);

export const resetOAuthRefreshQueuesForTest = (): void =>
  getTestApi().resetOAuthRefreshQueuesForTest();
