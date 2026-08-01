// Github Copilot tests cover auth plugin behavior.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn());
const listProfilesForProviderMock = vi.hoisted(() => vi.fn());
const coerceSecretRefMock = vi.hoisted(() => vi.fn());
const resolveConfiguredSecretInputWithFallbackMock = vi.hoisted(() => vi.fn());
const resolveRequiredConfiguredSecretRefInputStringMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  coerceSecretRef: coerceSecretRefMock,
  ensureAuthProfileStore: ensureAuthProfileStoreMock,
  listProfilesForProvider: listProfilesForProviderMock,
  normalizeOptionalSecretInput: (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined,
}));

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  resolveConfiguredSecretInputWithFallback: resolveConfiguredSecretInputWithFallbackMock,
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
    resolveConfiguredSecretInputWithFallbackMock.mockResolvedValue({
      value: "test-token-placeholder",
      source: "config",
      secretRefConfigured: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ensureAuthProfileStoreMock.mockReset();
    listProfilesForProviderMock.mockReset();
    coerceSecretRefMock.mockReset();
    resolveConfiguredSecretInputWithFallbackMock.mockReset();
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

  it("uses environment direct auth without falling back to config or the first profile", async () => {
    const config = {
      models: {
        providers: {
          "github-copilot": { apiKey: "test-token-placeholder" },
        },
      },
    } as never;
    const env = { GH_TOKEN: "test-auth-token" } as NodeJS.ProcessEnv;

    const result = await resolveFirstGithubToken({
      config,
      env,
      authProfileMode: "api_key",
    });

    expect(result).toEqual({
      githubToken: "test-auth-token",
      hasProfile: false,
    });
    expect(resolveConfiguredSecretInputWithFallbackMock).not.toHaveBeenCalled();
    expect(resolveRequiredConfiguredSecretRefInputStringMock).not.toHaveBeenCalled();
  });

  it("lets explicit api-key config outrank environment direct auth", async () => {
    const config = {
      models: {
        providers: {
          "github-copilot": {
            auth: "api-key",
            apiKey: "test-token-placeholder",
          },
        },
      },
    } as never;
    const env = { GH_TOKEN: "test-auth-token" } as NodeJS.ProcessEnv;

    const result = await resolveFirstGithubToken({
      config,
      env,
      authProfileMode: "api_key",
    });

    expect(result).toEqual({
      githubToken: "test-token-placeholder",
      hasProfile: false,
    });
    expect(resolveConfiguredSecretInputWithFallbackMock).toHaveBeenCalledWith({
      config,
      env,
      value: "test-token-placeholder",
      path: "models.providers.github-copilot.apiKey",
      readFallback: expect.any(Function),
    });
    expect(resolveRequiredConfiguredSecretRefInputStringMock).not.toHaveBeenCalled();
  });

  it("skips empty higher-priority environment variables", async () => {
    const result = await resolveFirstGithubToken({
      env: {
        COPILOT_GITHUB_TOKEN: "",
        GH_TOKEN: "test-auth-token",
      } as NodeJS.ProcessEnv,
      authProfileMode: "api_key",
    });

    expect(result).toEqual({
      githubToken: "test-auth-token",
      hasProfile: false,
    });
  });

  it("resolves config-only direct auth for unscoped model discovery", async () => {
    ensureAuthProfileStoreMock.mockReturnValue({ profiles: {} });
    listProfilesForProviderMock.mockReturnValue([]);
    const config = {
      models: {
        providers: {
          "github-copilot": { apiKey: "test-token-placeholder" },
        },
      },
    } as never;

    const result = await resolveFirstGithubToken({
      config,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      githubToken: "test-token-placeholder",
      hasProfile: false,
    });
    expect(resolveConfiguredSecretInputWithFallbackMock).toHaveBeenCalledOnce();
  });

  it("does not report stored profiles for a missing direct credential", async () => {
    resolveConfiguredSecretInputWithFallbackMock.mockResolvedValue({
      secretRefConfigured: false,
    });

    const result = await resolveFirstGithubToken({
      config: {},
      env: {} as NodeJS.ProcessEnv,
      authProfileMode: "api_key",
    });

    expect(result).toEqual({
      githubToken: "",
      hasProfile: false,
    });
    expect(resolveRequiredConfiguredSecretRefInputStringMock).not.toHaveBeenCalled();
  });

  it("resolves non-env SecretRefs when config is available", async () => {
    const config = { secrets: { defaults: { provider: "default" } } } as never;
    const env = {} as NodeJS.ProcessEnv;
    const result = await resolveFirstGithubToken({
      config,
      env,
    });

    expect(result).toEqual({
      githubToken: "resolved-profile-token",
      hasProfile: true,
    });
    expect(resolveRequiredConfiguredSecretRefInputStringMock).toHaveBeenCalledWith({
      config,
      env,
      value: {
        source: "file",
        provider: "default",
        id: "/providers/github-copilot/token",
      },
      path: "providers.github-copilot.authProfiles.github-copilot:github.tokenRef",
    });
  });
});
