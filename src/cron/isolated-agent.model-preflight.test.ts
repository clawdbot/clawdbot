import { beforeEach, describe, expect, it } from "vitest";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  preflightCronModelProviderMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resetRunCronIsolatedAgentTurnHarness,
  runEmbeddedPiAgentMock,
} from "./isolated-agent/run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn model provider preflight", () => {
  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "ollama",
      model: "qwen3:32b",
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: {
          sessionId: "cron-session",
          updatedAt: 0,
          systemSent: false,
          skillsSnapshot: undefined,
        },
      }),
    );
  });

  it("skips isolated cron execution when the local model provider is unavailable", async () => {
    preflightCronModelProviderMock.mockResolvedValueOnce({
      status: "unavailable",
      reason:
        "Agent cron job uses ollama/qwen3:32b but the local provider endpoint is not reachable at http://127.0.0.1:11434.",
      provider: "ollama",
      model: "qwen3:32b",
      baseUrl: "http://127.0.0.1:11434",
      retryAfterMs: 300000,
    });

    const result = await runCronIsolatedAgentTurn({
      cfg: {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      },
      deps: {} as never,
      job: {
        id: "dead-ollama",
        name: "Dead Ollama",
        enabled: true,
        createdAtMs: 0,
        updatedAtMs: 0,
        schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        state: {},
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "summarize" },
        delivery: { mode: "none" },
      },
      message: "summarize",
      sessionKey: "cron:dead-ollama",
      lane: "cron",
    });

    expect(result).toMatchObject({
      status: "skipped",
      provider: "ollama",
      model: "qwen3:32b",
      sessionId: "cron-session",
    });
    expect(result.error).toContain("local provider endpoint is not reachable");
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });
});
