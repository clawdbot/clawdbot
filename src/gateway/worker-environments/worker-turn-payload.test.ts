import { describe, expect, it, vi } from "vitest";
import { WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { assertSupportedTurn, windowInitialMessages } from "./worker-turn-payload.js";

describe("assertSupportedTurn", () => {
  it("accepts scheduled authority for the worker launch envelope", () => {
    expect(
      assertSupportedTurn({
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "run",
        timeoutMs: 1_000,
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        config: {
          agents: {
            defaults: {
              models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
            },
          },
        },
        toolsAllow: ["write"],
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "default",
        },
      } as SessionPlacementTurnParams),
    ).toEqual({ provider: "openai", model: "gpt-5.4" });
  });
});

describe("windowInitialMessages", () => {
  it("reports replay omitted from the worker launch envelope", () => {
    const onOmitted = vi.fn();
    const messages = windowInitialMessages(
      [
        {
          role: "assistant",
          content: [{ type: "text", text: "visible" }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.5",
          providerReplay: {
            v: 1,
            type: "openai-responses-compaction",
            data: "x".repeat(WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES + 1),
            provider: "openai",
            api: "openai-responses",
            model: "gpt-5.5",
            baseUrlHash: "ozhevd1smnk8s",
          },
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        } as AgentMessage,
      ],
      onOmitted,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toHaveProperty("providerReplay");
    expect(onOmitted).toHaveBeenCalledWith({
      bytes: WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES + 1,
      limitBytes: WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES,
      reason: "provider-replay-data-budget",
    });
  });
});
