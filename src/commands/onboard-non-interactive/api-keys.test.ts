// Non-interactive API key tests cover flag, environment, auth-profile, and secret-ref mode precedence.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNonInteractiveApiKey } from "./api-keys.js";

const resolveEnvApiKey = vi.hoisted(() => vi.fn());
vi.mock("../../agents/model-auth.js", () => ({
  resolveEnvApiKey,
}));

const authStore = vi.hoisted(
  () =>
    ({
      version: 1,
      profiles: {} as Record<string, { type: "api_key"; provider: string; key: string }>,
    }) as const,
);
const resolveApiKeyForProfile = vi.hoisted(() =>
  vi.fn(async (params: { profileId: string }) => {
    const profile = authStore.profiles[params.profileId];
    return profile?.type === "api_key" ? { apiKey: profile.key, source: "profile" } : null;
  }),
);
vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: vi.fn(() => authStore),
  resolveApiKeyForProfile,
  resolveAuthProfileOrder: vi.fn(() => Object.keys(authStore.profiles)),
}));

beforeEach(() => {
  vi.clearAllMocks();
  for (const profileId of Object.keys(authStore.profiles)) {
    delete authStore.profiles[profileId];
  }
});

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("resolveNonInteractiveApiKey", () => {
  it("resolves provider environment auth against the staged config and agent workspace", async () => {
    const runtime = createRuntime();
    const cfg = { plugins: { entries: { example: { enabled: true } } } };
    const workspaceDir = "/tmp/openclaw-example-workspace";
    resolveEnvApiKey.mockReturnValue({
      apiKey: "example-manifest-key",
      source: "env: EXAMPLE_WORKSPACE_API_KEY",
    });

    const result = await resolveNonInteractiveApiKey({
      provider: "example",
      cfg,
      workspaceDir,
      flagName: "--example-api-key",
      envVar: "EXAMPLE_API_KEY",
      runtime: runtime as never,
    });

    expect(result).toEqual({
      key: "example-manifest-key",
      source: "env",
      envVarName: "EXAMPLE_WORKSPACE_API_KEY",
    });
    expect(resolveEnvApiKey).toHaveBeenCalledWith("example", process.env, {
      config: cfg,
      workspaceDir,
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("returns explicit flag keys before resolving env or plugin-backed setup", async () => {
    const runtime = createRuntime();
    resolveEnvApiKey.mockImplementation(() => {
      throw new Error("env lookup should not run for an explicit plaintext flag");
    });

    const result = await resolveNonInteractiveApiKey({
      provider: "xai",
      cfg: {},
      flagValue: "xai-flag-key",
      flagName: "--xai-api-key",
      envVar: "XAI_API_KEY",
      runtime: runtime as never,
    });

    expect(result).toEqual({ key: "xai-flag-key", source: "flag" });
    expect(resolveEnvApiKey).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each([
    { source: "flag", flagValue: "malformed" },
    { source: "environment", resolvedEnv: true },
    { source: "secret-ref environment", resolvedEnv: true, secretInputMode: "ref" as const },
  ])("rejects command-shaped $source keys before returning them", async (testCase) => {
    const runtime = createRuntime();
    const malformedKey =
      "openclaw onboard --non-interactive --auth-choice=zai-coding-global --zai-api-key $ZAI_API_KEY";
    if (testCase.resolvedEnv) {
      resolveEnvApiKey.mockReturnValue({
        apiKey: malformedKey,
        source: "env: ZAI_API_KEY",
      });
    } else {
      resolveEnvApiKey.mockImplementation(() => {
        throw new Error("env lookup should not run for a malformed explicit flag");
      });
    }

    const result = await resolveNonInteractiveApiKey({
      provider: "zai",
      cfg: {},
      flagValue: testCase.flagValue === "malformed" ? malformedKey : undefined,
      flagName: "--zai-api-key",
      envVar: "ZAI_API_KEY",
      runtime: runtime as never,
      secretInputMode: testCase.secretInputMode,
    });

    expect(result).toBeNull();
    expect(resolveEnvApiKey).toHaveBeenCalledTimes(testCase.resolvedEnv ? 1 : 0);
    expect(runtime.error).toHaveBeenCalledWith(
      testCase.resolvedEnv
        ? "Paste the API key value, not an OpenClaw onboarding command. Check ZAI_API_KEY."
        : "Paste the API key value, not an OpenClaw onboarding command.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects a command-shaped explicit env key before a secret-ref flag", async () => {
    const runtime = createRuntime();
    const previousZaiApiKey = process.env.ZAI_API_KEY;
    process.env.ZAI_API_KEY = "openclaw onboard --non-interactive --auth-choice zai-api-key"; // pragma: allowlist secret
    resolveEnvApiKey.mockImplementation(() => {
      throw new Error("broad env lookup should not run for an explicit ref-mode flag");
    });

    try {
      const result = await resolveNonInteractiveApiKey({
        provider: "zai",
        cfg: {},
        flagValue: "zai-flag-key",
        flagName: "--zai-api-key",
        envVar: "ZAI_API_KEY",
        runtime: runtime as never,
        secretInputMode: "ref",
      });

      expect(result).toBeNull();
      expect(resolveEnvApiKey).not.toHaveBeenCalled();
      expect(runtime.error).toHaveBeenCalledWith(
        "Paste the API key value, not an OpenClaw onboarding command. Check ZAI_API_KEY.",
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
    } finally {
      if (previousZaiApiKey === undefined) {
        delete process.env.ZAI_API_KEY;
      } else {
        process.env.ZAI_API_KEY = previousZaiApiKey;
      }
    }
  });

  it.each([
    {
      provider: "xai",
      flagValue: "xai-flag-key",
      flagName: "--xai-api-key",
      envVar: "XAI_API_KEY",
    },
    {
      provider: "custom-models-custom-local",
      flagValue: "custom-inline-key-should-not-leak",
      flagName: "--custom-api-key",
      envVar: "CUSTOM_API_KEY",
    },
  ])(
    "rejects $flagName input in secret-ref mode without broad env discovery",
    async ({ provider, flagValue, flagName, envVar }) => {
      const runtime = createRuntime();
      resolveEnvApiKey.mockReturnValue(null);
      const previousValue = process.env[envVar];
      delete process.env[envVar];

      try {
        const result = await resolveNonInteractiveApiKey({
          provider,
          cfg: {},
          flagValue,
          flagName,
          envVar,
          runtime: runtime as never,
          secretInputMode: "ref",
        });

        const errorText = runtime.error.mock.calls.map(([message]) => String(message)).join("\n");
        expect(result).toBeNull();
        expect(resolveEnvApiKey).not.toHaveBeenCalled();
        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(errorText).toContain(flagName);
        expect(errorText).toContain(envVar);
        expect(errorText).not.toContain(flagValue);
      } finally {
        if (previousValue === undefined) {
          delete process.env[envVar];
        } else {
          process.env[envVar] = previousValue;
        }
      }
    },
  );

  it("returns explicit env fallback keys when provider env discovery misses", async () => {
    const runtime = createRuntime();
    resolveEnvApiKey.mockReturnValue(null);
    const previousCustomApiKey = process.env.CUSTOM_API_KEY;
    process.env.CUSTOM_API_KEY = "custom-env-key"; // pragma: allowlist secret

    try {
      const result = await resolveNonInteractiveApiKey({
        provider: "custom-models-custom-local",
        cfg: {},
        flagName: "--custom-api-key",
        envVar: "CUSTOM_API_KEY",
        envVarName: "CUSTOM_API_KEY",
        runtime: runtime as never,
      });

      expect(result).toEqual({
        key: "custom-env-key",
        source: "env",
        envVarName: "CUSTOM_API_KEY",
      });
      expect(runtime.exit).not.toHaveBeenCalled();
    } finally {
      if (previousCustomApiKey === undefined) {
        delete process.env.CUSTOM_API_KEY;
      } else {
        process.env.CUSTOM_API_KEY = previousCustomApiKey;
      }
    }
  });

  it("returns explicit env fallback refs in secret-ref mode", async () => {
    const runtime = createRuntime();
    resolveEnvApiKey.mockReturnValue(null);
    const previousCustomApiKey = process.env.CUSTOM_API_KEY;
    process.env.CUSTOM_API_KEY = "custom-env-key"; // pragma: allowlist secret

    try {
      const result = await resolveNonInteractiveApiKey({
        provider: "custom-models-custom-local",
        cfg: {},
        flagName: "--custom-api-key",
        envVar: "CUSTOM_API_KEY",
        envVarName: "CUSTOM_API_KEY",
        runtime: runtime as never,
        secretInputMode: "ref",
      });

      expect(result).toEqual({
        key: "custom-env-key",
        source: "env",
        envVarName: "CUSTOM_API_KEY",
      });
      expect(runtime.exit).not.toHaveBeenCalled();
    } finally {
      if (previousCustomApiKey === undefined) {
        delete process.env.CUSTOM_API_KEY;
      } else {
        process.env.CUSTOM_API_KEY = previousCustomApiKey;
      }
    }
  });

  it("falls back to a matching API-key profile after flag and env are absent", async () => {
    const runtime = createRuntime();
    authStore.profiles["custom-models-custom-local:default"] = {
      type: "api_key",
      provider: "custom-models-custom-local",
      key: "custom-profile-key",
    };
    resolveEnvApiKey.mockReturnValue(null);

    const result = await resolveNonInteractiveApiKey({
      provider: "custom-models-custom-local",
      cfg: {},
      flagName: "--custom-api-key",
      envVar: "CUSTOM_API_KEY",
      runtime: runtime as never,
    });

    expect(result).toEqual({ key: "custom-profile-key", source: "profile" });
    expect(resolveApiKeyForProfile).toHaveBeenCalledOnce();
    const [profileParams] = resolveApiKeyForProfile.mock.calls[0] ?? [];
    expect(profileParams?.profileId).toBe("custom-models-custom-local:default");
  });

  it("retains existing profile reuse in secret-ref mode without inventing an env reference", async () => {
    const runtime = createRuntime();
    authStore.profiles["custom-models-custom-local:default"] = {
      type: "api_key",
      provider: "custom-models-custom-local",
      key: "fixture-profile-key",
    };
    resolveEnvApiKey.mockReturnValue(null);

    const result = await resolveNonInteractiveApiKey({
      provider: "custom-models-custom-local",
      cfg: {},
      flagName: "--custom-api-key",
      envVar: "CUSTOM_API_KEY",
      runtime: runtime as never,
      secretInputMode: "ref",
    });

    expect(result).toEqual({ key: "fixture-profile-key", source: "profile" });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("keeps intentionally keyless providers optional in secret-ref mode", async () => {
    const runtime = createRuntime();
    resolveEnvApiKey.mockReturnValue(null);

    const result = await resolveNonInteractiveApiKey({
      provider: "custom-models-custom-local",
      cfg: {},
      flagName: "--custom-api-key",
      envVar: "CUSTOM_API_KEY",
      runtime: runtime as never,
      required: false,
      secretInputMode: "ref",
    });

    expect(result).toBeNull();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each([
    {
      rejection: "a missing required key",
      expectedMessage: "Missing --fixture-api-key",
    },
    {
      rejection: "a command-shaped key",
      flagValue: "openclaw onboard --non-interactive --auth-choice fixture-api-key",
      expectedMessage: "Paste the API key value",
    },
    {
      rejection: "a literal key in reference mode",
      flagValue: "fixture-api-key",
      secretInputMode: "ref" as const,
      expectedMessage: "cannot be used with --secret-input-mode ref",
    },
    {
      rejection: "a provider-discovered key without an environment name",
      envVar: "",
      secretInputMode: "ref" as const,
      resolvedEnv: { apiKey: "fixture-api-key", source: "provider discovery" },
      expectedMessage: "requires an explicit environment variable",
    },
  ])("emits one options JSON object for $rejection", async (testCase) => {
    const runtime = createRuntime();
    resolveEnvApiKey.mockReturnValue(testCase.resolvedEnv ?? null);

    const result = await resolveNonInteractiveApiKey({
      provider: "fixture",
      cfg: {},
      flagName: "--fixture-api-key",
      envVar: testCase.envVar ?? "OPENCLAW_ONBOARD_MISSING_FIXTURE_KEY",
      flagValue: testCase.flagValue,
      secretInputMode: testCase.secretInputMode,
      runtime,
      json: true,
    });

    expect(result).toBeNull();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload).toEqual({
      ok: false,
      phase: "options",
      message: expect.stringContaining(testCase.expectedMessage),
    });
    expect(runtime.error).toHaveBeenCalledWith(payload.message);
  });
});
