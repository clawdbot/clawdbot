import { capturePluginRegistration } from "openclaw/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";

const { readClaudeCliCredentialsForSetupMock, readClaudeCliCredentialsForRuntimeMock } = vi.hoisted(
  () => ({
    readClaudeCliCredentialsForSetupMock: vi.fn(),
    readClaudeCliCredentialsForRuntimeMock: vi.fn(),
  }),
);

vi.mock("./cli-auth-seam.js", () => {
  return {
    readClaudeCliCredentialsForSetup: readClaudeCliCredentialsForSetupMock,
    readClaudeCliCredentialsForRuntime: readClaudeCliCredentialsForRuntimeMock,
  };
});

import anthropicPlugin from "./index.js";

describe("anthropic provider replay hooks", () => {
  it("registers the claude-cli backend", async () => {
    const captured = capturePluginRegistration({ register: anthropicPlugin.register });

    expect(captured.cliBackends).toContainEqual(
      expect.objectContaining({
        id: "claude-cli",
        bundleMcp: true,
        config: expect.objectContaining({
          command: "claude",
          modelArg: "--model",
          sessionArg: "--session-id",
        }),
      }),
    );
  });

  it("owns native reasoning output mode for Claude transports", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "anthropic",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never),
    ).toBe("native");
  });

  it("owns replay policy for Claude transports", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "anthropic",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never),
    ).toEqual({
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      preserveNativeAnthropicToolUseIds: true,
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      validateAnthropicTurns: true,
      allowSyntheticToolResults: true,
    });
  });

  it("defaults provider api through plugin config normalization", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.normalizeConfig?.({
        provider: "anthropic",
        providerConfig: {
          models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
        },
      } as never),
    ).toMatchObject({
      api: "anthropic-messages",
    });
  });

  it("applies Anthropic pruning defaults through plugin hooks", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const next = provider.applyConfigDefaults?.({
      provider: "anthropic",
      env: {},
      config: {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
          },
        },
      },
    } as never);

    expect(next?.agents?.defaults?.contextPruning).toMatchObject({
      mode: "cache-ttl",
      ttl: "1h",
    });
    expect(next?.agents?.defaults?.heartbeat).toMatchObject({
      every: "30m",
    });
    expect(
      next?.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.params?.cacheRetention,
    ).toBe("short");
  });

  it("backfills Claude CLI allowlist defaults through plugin hooks for older configs", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const next = provider.applyConfigDefaults?.({
      provider: "anthropic",
      env: {},
      config: {
        auth: {
          profiles: {
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "claude-cli/claude-sonnet-4-6" },
            models: {
              "claude-cli/claude-sonnet-4-6": {},
            },
          },
        },
      },
    } as never);

    expect(next?.agents?.defaults?.heartbeat).toMatchObject({
      every: "1h",
    });
    expect(next?.agents?.defaults?.models).toMatchObject({
      "claude-cli/claude-sonnet-4-6": {},
      "claude-cli/claude-opus-4-6": {},
      "claude-cli/claude-opus-4-5": {},
      "claude-cli/claude-sonnet-4-5": {},
      "claude-cli/claude-haiku-4-5": {},
    });
  });

  it("resolves claude-cli synthetic oauth auth", async () => {
    readClaudeCliCredentialsForRuntimeMock.mockReset();
    readClaudeCliCredentialsForRuntimeMock.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
    });

    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.resolveSyntheticAuth?.({
        provider: "claude-cli",
      } as never),
    ).toEqual({
      apiKey: "access-token",
      source: "Claude CLI native auth",
      mode: "oauth",
    });
    expect(readClaudeCliCredentialsForRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it("resolves claude-cli synthetic token auth", async () => {
    readClaudeCliCredentialsForRuntimeMock.mockReset();
    readClaudeCliCredentialsForRuntimeMock.mockReturnValue({
      type: "token",
      provider: "anthropic",
      token: "bearer-token",
      expires: 123,
    });

    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.resolveSyntheticAuth?.({
        provider: "claude-cli",
      } as never),
    ).toEqual({
      apiKey: "bearer-token",
      source: "Claude CLI native auth",
      mode: "token",
    });
  });

  it("stores a claude-cli auth profile during anthropic cli migration", async () => {
    readClaudeCliCredentialsForSetupMock.mockReset();
    readClaudeCliCredentialsForSetupMock.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "setup-access-token",
      refresh: "refresh-token",
      expires: 123,
    });

    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    const cliAuth = provider.auth.find((entry) => entry.id === "cli");

    expect(cliAuth).toBeDefined();

    const result = await cliAuth?.run({
      config: {},
    } as never);

    expect(result?.profiles).toEqual([
      {
        profileId: "anthropic:claude-cli",
        credential: {
          type: "oauth",
          provider: "claude-cli",
          access: "setup-access-token",
          refresh: "refresh-token",
          expires: 123,
        },
      },
    ]);
  });
});
