import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../auth-profiles.js";
import { markAuthProfileSuccess } from "../auth-profiles.js";
import {
  clearAllRuntimeAuthMaterializations,
  getPreparedRuntimeAuthMaterializations,
} from "../auth-profiles/runtime-materializations.js";
import {
  markEmbeddedRunAuthProfileSuccess,
  reportEmbeddedRunSuccessfulAuthBinding,
} from "./run/auth-profile-success.js";
import { resolveInitialThinkLevel } from "./run/runtime-resolution.js";
import { copyAttemptDeliveryState } from "./run/terminal-resolution.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

vi.mock("../auth-profiles.js", () => ({
  markAuthProfileSuccess: vi.fn(),
}));

vi.mock("../../plugins/provider-model-routes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/provider-model-routes.js")>();
  return {
    ...actual,
    resolveProviderModelRoutes: (
      params: Parameters<typeof actual.resolveProviderModelRoutes>[0],
    ) => (params.provider === "anthropic" ? null : actual.resolveProviderModelRoutes(params)),
  };
});

const mockedMarkAuthProfileSuccess = vi.mocked(markAuthProfileSuccess);

afterEach(() => {
  clearAllRuntimeAuthMaterializations();
});

describe("markEmbeddedRunAuthProfileSuccess", () => {
  beforeEach(() => {
    mockedMarkAuthProfileSuccess.mockReset();
  });

  it("does not wait for post-run success bookkeeping", () => {
    const pendingSuccess = new Promise<void>(() => {});
    mockedMarkAuthProfileSuccess.mockReturnValueOnce(pendingSuccess);

    const result = markEmbeddedRunAuthProfileSuccess({
      profileId: "openai:test-profile",
      profileStore: { version: 1, profiles: {} } as AuthProfileStore,
      provider: "openai",
      runId: "run-1",
      sessionId: "session-1",
    });

    expect(result).toBeUndefined();
    expect(mockedMarkAuthProfileSuccess).toHaveBeenCalledOnce();
  });
});

describe("reportEmbeddedRunSuccessfulAuthBinding", () => {
  const profileStore = {
    version: 1 as const,
    profiles: {
      "openai:work": {
        type: "api_key" as const,
        provider: "openai",
        keyRef: { source: "env" as const, provider: "default", id: "OPENAI_WORK_KEY" },
      },
    },
  };

  it("uses a harness-owned SecretRef fingerprint when the harness resolves it", () => {
    const onSuccessfulAuthBinding = vi.fn();
    const agentDir = "/tmp/openclaw-secretref-materialization";

    reportEmbeddedRunSuccessfulAuthBinding({
      profileId: "openai:work",
      profileStore,
      apiKeyInfo: null,
      attempt: {
        authBindingFingerprint: "resolved-secretref-fingerprint",
      } as EmbeddedRunAttemptResult,
      provider: "openai",
      agentDir,
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      agentHarnessId: "codex",
      pluginHarnessOwnsTransport: true,
      pluginHarnessOwnsAuthBootstrap: true,
      onSuccessfulAuthBinding,
    });

    expect(onSuccessfulAuthBinding).toHaveBeenCalledWith({
      authProfileId: "openai:work",
      agentHarnessId: "codex",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      authFingerprint: "resolved-secretref-fingerprint",
      runtimeOwnerKind: "plugin-harness",
      runtimeOwnerId: "codex",
    });
    expect(getPreparedRuntimeAuthMaterializations(agentDir)).toEqual([
      {
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        requestTransportOverrides: "none",
        authMode: "api-key",
        runtimeOwnerId: "codex",
        authProfileId: "openai:work",
      },
    ]);
  });

  it("binds opaque harness auth to the exact captured runtime artifact", () => {
    const onSuccessfulAuthBinding = vi.fn();
    const runtimeArtifact = {
      id: "codex-app-server:test",
      fingerprint: "codex-runtime-fingerprint",
    };

    reportEmbeddedRunSuccessfulAuthBinding({
      profileId: "openai:work",
      profileStore,
      apiKeyInfo: null,
      attempt: { runtimeArtifact } as EmbeddedRunAttemptResult,
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      agentHarnessId: "codex",
      pluginHarnessOwnsTransport: true,
      pluginHarnessOwnsAuthBootstrap: true,
      onSuccessfulAuthBinding,
    });

    expect(onSuccessfulAuthBinding).toHaveBeenCalledWith({
      authProfileId: "openai:work",
      agentHarnessId: "codex",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      runtimeOwnerFingerprint: expect.any(String),
      runtimeOwnerKind: "plugin-harness",
      runtimeOwnerId: "codex",
      runtimeArtifactId: runtimeArtifact.id,
      runtimeArtifactFingerprint: runtimeArtifact.fingerprint,
    });
  });

  it("records exact native auth only after a credential-free harness succeeds", () => {
    const agentDir = "/tmp/openclaw-native-auth-materialization";
    reportEmbeddedRunSuccessfulAuthBinding({
      profileStore: { version: 1, profiles: {} },
      apiKeyInfo: null,
      attempt: {} as EmbeddedRunAttemptResult,
      provider: "anthropic",
      agentDir,
      modelId: "claude-opus-5",
      modelApi: "anthropic-messages",
      modelBaseUrl: "https://api.anthropic.com",
      requestTransportOverrides: "none",
      agentHarnessId: "claude-cli",
      pluginHarnessOwnsTransport: true,
      pluginHarnessOwnsAuthBootstrap: true,
    });

    expect(getPreparedRuntimeAuthMaterializations(agentDir)).toEqual([
      {
        provider: "anthropic",
        modelId: "claude-opus-5",
        modelApi: "anthropic-messages",
        modelBaseUrl: "https://api.anthropic.com",
        requestTransportOverrides: "none",
        authMode: "native",
        runtimeOwnerId: "claude-cli",
      },
    ]);
  });

  const nativeAuthDenialCases: Array<{
    label: string;
    overrides: Partial<Parameters<typeof reportEmbeddedRunSuccessfulAuthBinding>[0]>;
  }> = [
    {
      label: "transport ownership",
      overrides: { pluginHarnessOwnsTransport: false },
    },
    {
      label: "auth-bootstrap ownership",
      overrides: { pluginHarnessOwnsAuthBootstrap: false },
    },
    {
      label: "an unbound profile id",
      overrides: { profileId: "anthropic:missing" },
    },
    {
      label: "a SecretRef profile",
      overrides: {
        profileId: "anthropic:ref",
        profileStore: {
          version: 1,
          profiles: {
            "anthropic:ref": {
              type: "api_key",
              provider: "anthropic",
              keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
            },
          },
        },
      },
    },
    {
      label: "an inline profile credential",
      overrides: {
        profileId: "anthropic:inline",
        profileStore: {
          version: 1,
          profiles: {
            "anthropic:inline": {
              type: "api_key",
              provider: "anthropic",
              key: "inline-test-key",
            },
          },
        },
      },
    },
    {
      label: "forwarded auth material",
      overrides: {
        apiKeyInfo: { apiKey: "forwarded-test-key", mode: "api-key", source: "test" },
      },
    },
  ];

  it.each(nativeAuthDenialCases)("does not record native auth without $label", ({ overrides }) => {
    const agentDir = `/tmp/openclaw-unowned-native-auth-${overrides.profileId ?? "owner"}`;
    reportEmbeddedRunSuccessfulAuthBinding({
      profileStore: { version: 1, profiles: {} },
      apiKeyInfo: null,
      attempt: {} as EmbeddedRunAttemptResult,
      provider: "anthropic",
      agentDir,
      modelId: "claude-opus-5",
      modelApi: "anthropic-messages",
      modelBaseUrl: "https://api.anthropic.com",
      agentHarnessId: "claude-cli",
      pluginHarnessOwnsTransport: true,
      pluginHarnessOwnsAuthBootstrap: true,
      ...overrides,
    });

    expect(getPreparedRuntimeAuthMaterializations(agentDir)).toEqual([]);
  });
});

describe("overflow loop owner policies", () => {
  it("uses provider policy for a configless MiniMax-M3 run", () => {
    expect(
      resolveInitialThinkLevel({
        config: undefined,
        provider: "minimax",
        modelId: "MiniMax-M3",
        model: { reasoning: true },
      }),
    ).toBe("adaptive");
  });

  it("propagates deterministic approval delivery", () => {
    expect(
      copyAttemptDeliveryState({
        didSendDeterministicApprovalPrompt: true,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
      } as never).didSendDeterministicApprovalPrompt,
    ).toBe(true);
  });
});
