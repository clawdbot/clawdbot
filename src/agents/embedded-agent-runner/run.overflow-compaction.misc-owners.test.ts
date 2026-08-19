import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../auth-profiles.js";
import { markAuthProfileSuccess } from "../auth-profiles.js";
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
      },
    },
  };

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
