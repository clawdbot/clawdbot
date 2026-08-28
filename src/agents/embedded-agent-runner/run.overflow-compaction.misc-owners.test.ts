import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "../auth-profiles.js";
import { markAuthProfileSuccess } from "../auth-profiles.js";
import {
  clearAllRuntimeAuthMaterializations,
  getPreparedRuntimeAuthMaterializations,
  registerRuntimeAuthMaterializationMutationListener,
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

const mockedMarkAuthProfileSuccess = vi.mocked(markAuthProfileSuccess);

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
        key: "resolved-key",
      },
    },
  };

  afterEach(() => {
    clearAllRuntimeAuthMaterializations();
  });

  it("publishes an identical prepared API-key success only once", () => {
    const listener = vi.fn();
    const unregister = registerRuntimeAuthMaterializationMutationListener(listener);
    const agentDir = "/tmp/openclaw-auth-success-dedup";
    const input = {
      profileId: "openai:work",
      profileStore,
      apiKeyInfo: {
        apiKey: "resolved-key",
        source: "profile:openai:work",
        mode: "api-key" as const,
        profileId: "openai:work",
      },
      attempt: {} as EmbeddedRunAttemptResult,
      provider: "openai",
      agentDir,
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      requestTransportOverrides: "none" as const,
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-responses",
              models: [
                {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 8_192,
                  compat: { supportsTemperature: false },
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
      agentHarnessId: "codex",
      pluginHarnessOwnsTransport: true,
      pluginHarnessOwnsAuthBootstrap: true,
    };

    try {
      reportEmbeddedRunSuccessfulAuthBinding(input);
      reportEmbeddedRunSuccessfulAuthBinding(input);

      expect(getPreparedRuntimeAuthMaterializations(agentDir)).toEqual([
        expect.objectContaining({
          authMode: "api-key",
          authProfileId: "openai:work",
          requestTransportOverrides: "none",
          runtimeOwnerId: "codex",
        }),
      ]);
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });

  it.each([
    {
      name: "non-profile provenance",
      apiKeyInfo: {
        apiKey: "resolved-key",
        source: "env:OPENAI_API_KEY",
        mode: "api-key" as const,
        profileId: "openai:work",
      },
    },
    {
      name: "different profile provenance",
      apiKeyInfo: {
        apiKey: "resolved-key",
        source: "profile:openai:other",
        mode: "api-key" as const,
        profileId: "openai:other",
      },
    },
    {
      name: "non-API-key mode",
      apiKeyInfo: {
        apiKey: "resolved-key",
        source: "profile:openai:work",
        mode: "token" as const,
        profileId: "openai:work",
      },
    },
  ])("rejects prepared auth with $name", ({ apiKeyInfo }) => {
    reportEmbeddedRunSuccessfulAuthBinding({
      profileId: "openai:work",
      profileStore,
      apiKeyInfo,
      attempt: {} as EmbeddedRunAttemptResult,
      provider: "openai",
      agentDir: "/tmp/openclaw-auth-success-negative",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      modelBaseUrl: "https://api.openai.com/v1",
      requestTransportOverrides: "none",
      agentHarnessId: "codex",
      pluginHarnessOwnsTransport: true,
      pluginHarnessOwnsAuthBootstrap: true,
    });

    expect(getPreparedRuntimeAuthMaterializations("/tmp/openclaw-auth-success-negative")).toEqual(
      [],
    );
  });

  it("uses a harness-owned SecretRef fingerprint when the harness resolves it", () => {
    const onSuccessfulAuthBinding = vi.fn();

    reportEmbeddedRunSuccessfulAuthBinding({
      profileId: "openai:work",
      profileStore,
      apiKeyInfo: null,
      attempt: {
        authBindingFingerprint: "resolved-secretref-fingerprint",
      } as EmbeddedRunAttemptResult,
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
      authFingerprint: "resolved-secretref-fingerprint",
      runtimeOwnerKind: "plugin-harness",
      runtimeOwnerId: "codex",
    });
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
