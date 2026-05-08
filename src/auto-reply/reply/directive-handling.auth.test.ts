import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/config.js";

let mockStore: AuthProfileStore;
let mockOrder: string[];
const resolveEnvApiKeyMock = vi.hoisted(() =>
  vi.fn(
    (
      _provider?: string,
      _env?: NodeJS.ProcessEnv,
      _options?: { config?: OpenClawConfig; workspaceDir?: string },
    ) => null as { apiKey: string; source: string } | null,
  ),
);
const githubCopilotTokenRefProfile: AuthProfileStore["profiles"][string] = {
  type: "token",
  provider: "github-copilot",
  tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
};

vi.mock("../../agents/auth-health.js", () => ({
  formatRemainingShort: () => "1h",
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  isConfiguredAwsSdkAuthProfileForProvider: ({
    cfg,
    provider,
    profileId,
  }: {
    cfg?: OpenClawConfig;
    provider: string;
    profileId: string;
  }) => {
    const profile = cfg?.auth?.profiles?.[profileId];
    return (
      profile?.mode === "aws-sdk" &&
      profile.provider.trim().toLowerCase() === provider.trim().toLowerCase()
    );
  },
  isProfileInCooldown: () => false,
  resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
  resolveAuthStorePathForDisplay: () => "/tmp/auth-profiles.json",
}));

vi.mock("../../agents/model-selection.js", () => ({
  findNormalizedProviderValue: (
    values: Record<string, unknown> | undefined,
    provider: string,
  ): unknown => {
    if (!values) {
      return undefined;
    }
    return Object.entries(values).find(
      ([key]) => key.toLowerCase() === provider.toLowerCase(),
    )?.[1];
  },
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("../../agents/model-auth.js", () => ({
  ensureAuthProfileStore: () => mockStore,
  resolveUsableCustomProviderApiKey: () => null,
  resolveAuthProfileOrder: () => mockOrder,
  resolveEnvApiKey: (
    provider?: string,
    env?: NodeJS.ProcessEnv,
    options?: { config?: OpenClawConfig; workspaceDir?: string },
  ) => resolveEnvApiKeyMock(provider, env, options),
}));

const { resolveAuthLabel } = await import("./directive-handling.auth.js");

async function resolveRefOnlyAuthLabel(params: {
  provider: string;
  profileId: string;
  profile:
    | (AuthProfileStore["profiles"][string] & { type: "api_key" })
    | (AuthProfileStore["profiles"][string] & { type: "token" });
  mode: "compact" | "verbose";
}) {
  mockStore.profiles = {
    [params.profileId]: params.profile,
  };
  mockOrder = [params.profileId];

  return resolveAuthLabel(
    params.provider,
    {} as OpenClawConfig,
    "/tmp/models.json",
    undefined,
    params.mode,
  );
}

describe("resolveAuthLabel ref-aware labels", () => {
  beforeEach(() => {
    mockStore = {
      version: 1,
      profiles: {},
    };
    mockOrder = [];
    resolveEnvApiKeyMock.mockReset();
    resolveEnvApiKeyMock.mockReturnValue(null);
  });

  it("shows api-key (ref) for keyRef-only profiles in compact mode", async () => {
    const result = await resolveRefOnlyAuthLabel({
      provider: "openai",
      profileId: "openai:default",
      profile: {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
      mode: "compact",
    });

    expect(result.label).toBe("openai:default api-key (ref)");
  });

  it("shows token (ref) for tokenRef-only profiles in compact mode", async () => {
    const result = await resolveRefOnlyAuthLabel({
      provider: "github-copilot",
      profileId: "github-copilot:default",
      profile: githubCopilotTokenRefProfile,
      mode: "compact",
    });

    expect(result.label).toBe("github-copilot:default token (ref)");
  });

  it("uses token:ref instead of token:missing in verbose mode", async () => {
    const result = await resolveRefOnlyAuthLabel({
      provider: "github-copilot",
      profileId: "github-copilot:default",
      profile: githubCopilotTokenRefProfile,
      mode: "verbose",
    });

    expect(result.label).toContain("github-copilot:default=token:ref");
    expect(result.label).not.toContain("token:missing");
  });

  it("labels config-only aws-sdk profiles as valid in compact mode", async () => {
    mockOrder = ["amazon-bedrock:default"];
    const result = await resolveAuthLabel(
      "amazon-bedrock",
      {
        models: {
          providers: {
            "amazon-bedrock": {
              auth: "aws-sdk",
              baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
              api: "bedrock-converse-stream",
              models: [],
            },
          },
        },
        auth: {
          profiles: {
            "amazon-bedrock:default": {
              provider: "amazon-bedrock",
              mode: "aws-sdk",
            },
          },
        },
      } as OpenClawConfig,
      "/tmp/models.json",
      undefined,
      "compact",
    );

    expect(result.label).toBe("amazon-bedrock:default aws-sdk");
    expect(result.label).not.toContain("missing");
  });

  it("labels config-only aws-sdk profiles as valid in verbose mode", async () => {
    mockOrder = ["amazon-bedrock:default"];
    const result = await resolveAuthLabel(
      "amazon-bedrock",
      {
        models: {
          providers: {
            "amazon-bedrock": {
              auth: "aws-sdk",
              baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
              api: "bedrock-converse-stream",
              models: [],
            },
          },
        },
        auth: {
          profiles: {
            "amazon-bedrock:default": {
              provider: "amazon-bedrock",
              mode: "aws-sdk",
            },
          },
        },
      } as OpenClawConfig,
      "/tmp/models.json",
      undefined,
      "verbose",
    );

    expect(result.label).toContain("amazon-bedrock:default=aws-sdk");
    expect(result.label).not.toContain("missing");
  });

  it("passes workspace scope to env auth labels", async () => {
    const cfg = { plugins: { allow: ["workspace-auth-label"] } } as OpenClawConfig;
    resolveEnvApiKeyMock.mockReturnValue({
      apiKey: "workspace-local-credentials",
      source: "workspace credentials",
    });

    const result = await resolveAuthLabel(
      "anthropic",
      cfg,
      "/tmp/models.json",
      "/tmp/agent",
      "verbose",
      "/tmp/workspace",
    );

    expect(resolveEnvApiKeyMock).toHaveBeenCalledWith("anthropic", process.env, {
      config: cfg,
      workspaceDir: "/tmp/workspace",
    });
    expect(result.source).toBe("workspace credentials");
  });
});
