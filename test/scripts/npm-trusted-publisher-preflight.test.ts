import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preflightNpmTrustedPublisher } from "../../scripts/npm-trusted-publisher-preflight.mjs";

const githubRequestToken = "github-request-secret";
const githubOidcToken = "github-oidc-secret";
const npmToken = "npm-exchange-secret";

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("npm trusted-publisher preflight", () => {
  beforeEach(() => {
    vi.stubEnv(
      "ACTIONS_ID_TOKEN_REQUEST_URL",
      "https://token.actions.githubusercontent.com/request?job=123",
    );
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", githubRequestToken);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requests the npm audience and exchanges the GitHub token for the exact package", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ value: githubOidcToken }))
      .mockResolvedValueOnce(jsonResponse({ token: npmToken }));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await preflightNpmTrustedPublisher("@openclaw/fish-audio-speech");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const githubCall = fetchMock.mock.calls[0];
    const npmCall = fetchMock.mock.calls[1];
    expect(githubCall).toBeDefined();
    expect(npmCall).toBeDefined();
    const [githubUrl, githubInit] = githubCall!;
    expect(githubUrl).toBe(
      "https://token.actions.githubusercontent.com/request?job=123&audience=npm%3Aregistry.npmjs.org",
    );
    expect(githubInit).toMatchObject({
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${githubRequestToken}`,
      },
    });
    const [npmUrl, npmInit] = npmCall!;
    expect(npmUrl).toBe(
      "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@openclaw%2ffish-audio-speech",
    );
    expect(npmInit).toMatchObject({
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${githubOidcToken}`,
      },
    });
    expect(log).toHaveBeenCalledWith(
      "npm trusted-publisher OIDC exchange verified for @openclaw/fish-audio-speech.",
    );
  });

  it("reports a GitHub token request failure without attempting npm exchange", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({}, 403));
    vi.stubGlobal("fetch", fetchMock);

    await expect(preflightNpmTrustedPublisher("@openclaw/fish-audio-speech")).rejects.toThrow(
      "GitHub OIDC token request failed (HTTP 403).",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports an npm exchange failure without leaking response or request tokens", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ value: githubOidcToken }))
      .mockResolvedValueOnce(
        jsonResponse({ message: `${githubRequestToken} ${githubOidcToken} ${npmToken}` }, 404),
      );
    vi.stubGlobal("fetch", fetchMock);

    const error = await preflightNpmTrustedPublisher("@openclaw/fish-audio-speech").catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(Error);
    const visibleError = error instanceof Error ? error.message : String(error);
    expect(visibleError).toBe(
      "npm trusted-publisher exchange for @openclaw/fish-audio-speech failed (HTTP 404).",
    );
    expect(visibleError).not.toContain(githubRequestToken);
    expect(visibleError).not.toContain(githubOidcToken);
    expect(visibleError).not.toContain(npmToken);
  });

  it("rejects an npm exchange response without a token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ value: githubOidcToken }))
      .mockResolvedValueOnce(jsonResponse({ token: "" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(preflightNpmTrustedPublisher("@openclaw/fish-audio-speech")).rejects.toThrow(
      "npm trusted-publisher exchange for @openclaw/fish-audio-speech response is missing token.",
    );
  });
});
