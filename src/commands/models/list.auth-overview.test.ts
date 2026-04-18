import { describe, expect, it, vi } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "../../agents/model-auth-markers.js";
import { withEnv } from "../../test-utils/env.js";
import { resolveProviderAuthOverview } from "./list.auth-overview.js";

vi.mock("../../agents/auth-profiles/display.js", () => ({
  resolveAuthProfileDisplayLabel: vi.fn(({ profileId }: { profileId: string }) => profileId),
}));

vi.mock("../../agents/auth-profiles/paths.js", () => ({
  resolveAuthStorePathForDisplay: vi.fn(() => "/tmp/auth-profiles.json"),
}));

vi.mock("../../agents/auth-profiles/profiles.js", () => ({
  listProfilesForProvider: vi.fn(
    (store: { profiles?: Record<string, { provider?: string }> }, provider: string) =>
      Object.keys(store.profiles ?? {}).filter(
        (profileId) => store.profiles?.[profileId]?.provider === provider,
      ),
  ),
}));

vi.mock("../../agents/auth-profiles/usage.js", () => ({
  resolveProfileUnusableUntilForDisplay: vi.fn(() => undefined),
}));

vi.mock("../../agents/model-auth.js", () => {
  const resolveConfigKey = (
    cfg: { models?: { providers?: Record<string, { apiKey?: string }> } } | undefined,
    provider: string,
  ) => cfg?.models?.providers?.[provider]?.apiKey;

  return {
    getCustomProviderApiKey: vi.fn(resolveConfigKey),
    resolveEnvApiKey: vi.fn((provider: string) => {
      if (provider !== "openai" || !process.env.OPENAI_API_KEY?.trim()) {
        return null;
      }
      return {
        apiKey: process.env.OPENAI_API_KEY,
        source: "env: OPENAI_API_KEY",
      };
    }),
    resolveUsableCustomProviderApiKey: vi.fn(
      (params: {
        cfg?: { models?: { providers?: Record<string, { apiKey?: string }> } };
        provider: string;
      }) => {
        const apiKey = resolveConfigKey(params.cfg, params.provider);
        if (!apiKey || apiKey === "secretref-managed") {
          return null;
        }
        if (apiKey === "OPENAI_API_KEY") {
          return process.env.OPENAI_API_KEY?.trim()
            ? { apiKey: process.env.OPENAI_API_KEY, source: "env: OPENAI_API_KEY" }
            : null;
        }
        return { apiKey, source: "models.json" };
      },
    ),
  };
});

function resolveOpenAiOverview(apiKey: string) {
  return resolveProviderAuthOverview({
    provider: "openai",
    cfg: {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            apiKey,
            models: [],
          },
        },
      },
    } as never,
    store: { version: 1, profiles: {} } as never,
    modelsPath: "/tmp/models.json",
  });
}

describe("resolveProviderAuthOverview", () => {
  it("does not throw when token profile only has tokenRef", () => {
    const overview = resolveProviderAuthOverview({
      provider: "github-copilot",
      cfg: {},
      store: {
        version: 1,
        profiles: {
          "github-copilot:default": {
            type: "token",
            provider: "github-copilot",
            tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
          },
        },
      } as never,
      modelsPath: "/tmp/models.json",
    });

    expect(overview.profiles.labels[0]).toContain("token:ref(env:GITHUB_TOKEN)");
  });

  it("renders marker-backed models.json auth as marker detail", () => {
    const overview = withEnv({ OPENAI_API_KEY: undefined }, () =>
      resolveOpenAiOverview(NON_ENV_SECRETREF_MARKER),
    );

    expect(overview.effective.kind).toBe("missing");
    expect(overview.effective.detail).toBe("missing");
    expect(overview.modelsJson?.value).toContain(`marker(${NON_ENV_SECRETREF_MARKER})`);
  });

  it("keeps env-var-shaped models.json values masked to avoid accidental plaintext exposure", () => {
    const overview = withEnv({ OPENAI_API_KEY: undefined }, () =>
      resolveOpenAiOverview("OPENAI_API_KEY"),
    );

    expect(overview.effective.kind).toBe("missing");
    expect(overview.effective.detail).toBe("missing");
    expect(overview.modelsJson?.value).not.toContain("marker(");
    expect(overview.modelsJson?.value).not.toContain("OPENAI_API_KEY");
  });

  it("treats env-var marker as usable only when the env key is currently resolvable", () => {
    const prior = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-from-env"; // pragma: allowlist secret
    try {
      const overview = resolveOpenAiOverview("OPENAI_API_KEY");
      expect(overview.effective.kind).toBe("env");
      expect(overview.effective.detail).not.toContain("OPENAI_API_KEY");
    } finally {
      if (prior === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = prior;
      }
    }
  });
});
