import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn());
const listProfilesForProviderMock = vi.hoisted(() => vi.fn());
const coerceSecretRefMock = vi.hoisted(() => vi.fn());
const resolveRequiredConfiguredSecretRefInputStringMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  coerceSecretRef: coerceSecretRefMock,
  ensureAuthProfileStore: ensureAuthProfileStoreMock,
  listProfilesForProvider: listProfilesForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  resolveRequiredConfiguredSecretRefInputString: resolveRequiredConfiguredSecretRefInputStringMock,
}));

import { resolveFirstGithubToken } from "./auth.js";

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/provider-auth");
  vi.doUnmock("openclaw/plugin-sdk/secret-input-runtime");
  vi.resetModules();
});

describe("resolveFirstGithubToken", () => {
  beforeEach(() => {
    ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "github-copilot:github": {
          type: "token",
          tokenRef: { source: "file", provider: "default", id: "/providers/github-copilot/token" },
        },
      },
    });
    listProfilesForProviderMock.mockReturnValue(["github-copilot:github"]);
    coerceSecretRefMock.mockReturnValue({
      source: "file",
      provider: "default",
      id: "/providers/github-copilot/token",
    });
    resolveRequiredConfiguredSecretRefInputStringMock.mockResolvedValue("resolved-profile-token");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ensureAuthProfileStoreMock.mockReset();
    listProfilesForProviderMock.mockReset();
    coerceSecretRefMock.mockReset();
    resolveRequiredConfiguredSecretRefInputStringMock.mockReset();
  });

  it("prefers env tokens when available", async () => {
    const result = await resolveFirstGithubToken({
      env: { GH_TOKEN: "env-token" } as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      githubToken: "env-token",
      hasProfile: true,
    });
    expect(resolveRequiredConfiguredSecretRefInputStringMock).not.toHaveBeenCalled();
  });

  it("returns direct profile tokens before resolving SecretRefs", async () => {
    ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "github-copilot:github": {
          type: "token",
          token: "profile-token",
        },
      },
    });
    coerceSecretRefMock.mockReturnValue(null);

    const result = await resolveFirstGithubToken({
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      githubToken: "profile-token",
      hasProfile: true,
    });
  });

  it("resolves non-env SecretRefs when config is available", async () => {
    const result = await resolveFirstGithubToken({
      config: { secrets: { defaults: { provider: "default" } } } as never,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      githubToken: "resolved-profile-token",
      hasProfile: true,
    });
    expect(resolveRequiredConfiguredSecretRefInputStringMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "providers.github-copilot.authProfiles.github-copilot:github.tokenRef",
      }),
    );
  });
});
