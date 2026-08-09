import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { FailoverError } from "../../failover-error.js";
import { runWithModelFallback } from "../../model-fallback-runner.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { handleEmbeddedAssistantFailure } from "./assistant-failure.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

const CREDENTIAL_FILE_ENOENT_MESSAGE =
  "ENOENT: no such file or directory, open '/home/operator/.claude/.credentials.json'";

type AssistantFailureInput = Parameters<typeof handleEmbeddedAssistantFailure>[0];

function makeExhaustedCredentialFailureInput(options?: { replaySafe?: boolean }) {
  const replaySafe = options?.replaySafe !== false;
  const assistant = buildEmbeddedRunnerAssistant({
    provider: "anthropic",
    model: "mock-1",
    stopReason: "error",
    errorMessage: CREDENTIAL_FILE_ENOENT_MESSAGE,
  });
  const attempt = makeEmbeddedRunnerAttempt({
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    toolMetas: replaySafe ? [] : [{ toolName: "write", replaySafe: false }],
  });
  const advanceAttemptAuthProfile = vi.fn(async () => true);
  const maybeMarkAuthProfileFailure = vi.fn(async () => {});
  const traceAttempts: AssistantFailureInput["traceAttempts"] = [];
  const input: AssistantFailureInput = {
    runParams: {
      sessionId: "session:credential-enoent",
      runId: "run:credential-enoent",
      config: undefined,
    } as AssistantFailureInput["runParams"],
    attempt,
    attemptAssistant: assistant,
    currentAttemptAssistant: assistant,
    terminalState: resolveEmbeddedRunAttemptTerminalState({
      attempt,
      assistant,
    }),
    activeErrorContext: { provider: "anthropic", model: "mock-1" },
    provider: "anthropic",
    modelId: "mock-1",
    model: "mock-1",
    thinkLevel: "off",
    getThinkLevel: () => "off",
    attemptedThinking: new Set(["off"]),
    fallbackConfigured: true,
    pluginHarnessOwnsTransport: false,
    canRestartForLiveSwitch: false,
    authProfileId: "anthropic:p1",
    authProfileStore: {
      version: 1,
      profiles: {
        "anthropic:p1": {
          type: "api_key",
          provider: "anthropic",
          key: "test-key",
        },
        "anthropic:p2": {
          type: "api_key",
          provider: "anthropic",
          key: "test-key-2",
        },
      },
      usageStats: {
        "anthropic:p1": { lastUsed: 1 },
        "anthropic:p2": { lastUsed: 2 },
      },
    },
    runtimeAuthRetry: false,
    maybeRefreshRuntimeAuthForAuthError: vi.fn(async () => false),
    resolveAuthProfileFailureReason: () => null,
    emptyErrorRetries: 3,
    overloadProfileRotations: 0,
    overloadProfileRotationLimit: 1,
    rateLimitProfileRotations: 0,
    rateLimitProfileRotationLimit: 1,
    sameModelIdleTimeoutRetries: 0,
    previousRetryFailoverReason: null,
    maybeMarkAuthProfileFailure,
    maybeEscalateRateLimitProfileFallback: vi.fn(),
    maybeRetrySameModelRateLimit: vi.fn(async () => false),
    maybeBackoffBeforeOverloadFailover: vi.fn(async () => {}),
    advanceAttemptAuthProfile,
    traceAttempts,
    suspendForFailure: vi.fn(),
    suspensionSessionId: "session:credential-enoent",
    agentDir: "/tmp/openclaw-assistant-failure-test",
    isProbeSession: false,
  };
  return {
    advanceAttemptAuthProfile,
    input,
    maybeMarkAuthProfileFailure,
    traceAttempts,
  };
}

describe("handleEmbeddedAssistantFailure", () => {
  it("falls back after exhausted replay-safe credential-file retries without touching auth state", async () => {
    const fixture = makeExhaustedCredentialFailureInput();

    await expect(handleEmbeddedAssistantFailure(fixture.input)).rejects.toMatchObject({
      reason: "unknown",
      provider: "anthropic",
      model: "mock-1",
      rawError: CREDENTIAL_FILE_ENOENT_MESSAGE,
    });

    expect(fixture.advanceAttemptAuthProfile).not.toHaveBeenCalled();
    expect(fixture.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
    expect(fixture.input.authProfileStore.usageStats).toEqual({
      "anthropic:p1": { lastUsed: 1 },
      "anthropic:p2": { lastUsed: 2 },
    });
    expect(fixture.traceAttempts).toEqual([
      {
        provider: "anthropic",
        model: "mock-1",
        result: "fallback_model",
        reason: "unknown",
        stage: "assistant",
      },
    ]);
  });

  it("does not fallback credential-file ENOENT after replay-unsafe tool activity", async () => {
    const fixture = makeExhaustedCredentialFailureInput({ replaySafe: false });

    const outcome = await handleEmbeddedAssistantFailure(fixture.input);

    expect(outcome.action).toBe("proceed");
    expect(fixture.advanceAttemptAuthProfile).not.toHaveBeenCalled();
    expect(fixture.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
    expect(fixture.traceAttempts).toEqual([]);
  });

  it("does not cache an exact credential-file failure from a fallback candidate", async () => {
    const previous = process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS;
    process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS = "60000";
    try {
      const config = {
        agents: {
          defaults: {
            model: {
              primary: "openai/mock-0",
              fallbacks: ["anthropic/mock-1", "groq/mock-2"],
            },
          },
        },
      } satisfies OpenClawConfig;
      const calls: string[] = [];
      const run = async (provider: string, model: string) => {
        calls.push(`${provider}/${model}`);
        if (provider === "openai") {
          throw new FailoverError("primary rate limited", {
            provider,
            model,
            reason: "rate_limit",
          });
        }
        if (provider === "anthropic") {
          await handleEmbeddedAssistantFailure(makeExhaustedCredentialFailureInput().input);
        }
        return "ok";
      };

      for (let turn = 0; turn < 2; turn += 1) {
        const result = await runWithModelFallback({
          cfg: config,
          provider: "openai",
          model: "mock-0",
          sessionId: "session:credential-enoent-no-skip",
          skipAuthProfileRuntime: true,
          run,
        });
        expect(result.result).toBe("ok");
      }

      expect(calls).toEqual([
        "openai/mock-0",
        "anthropic/mock-1",
        "groq/mock-2",
        "openai/mock-0",
        "anthropic/mock-1",
        "groq/mock-2",
      ]);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS;
      } else {
        process.env.OPENCLAW_FALLBACK_SKIP_TTL_MS = previous;
      }
    }
  });
});
