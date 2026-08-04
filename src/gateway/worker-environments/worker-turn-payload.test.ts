import { describe, expect, it } from "vitest";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { assertSupportedTurn } from "./worker-turn-payload.js";

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
