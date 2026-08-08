import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCompleteReplyConfig } from "../auto-reply/reply/get-reply-fast-path.test-support.js";
import { resolveStorePath } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { getReplyFromConfig } from "./heartbeat-runner.runtime.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import { withSystemEventOwner } from "./system-event-ownership.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

type RunEmbeddedAgentParams = Parameters<
  typeof import("../agents/embedded-agent.js").runEmbeddedAgent
>[0];

const runEmbeddedAgentMock = vi.hoisted(() => vi.fn());

vi.mock("../agents/embedded-agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/embedded-agent.js")>();
  return {
    ...actual,
    runEmbeddedAgent: (...args: unknown[]) => runEmbeddedAgentMock(...args),
  };
});

installHeartbeatRunnerTestRuntime();

const heartbeatDeps = {
  getQueueSize: () => 0,
  getReplyFromConfig,
} satisfies HeartbeatDeps;

function modelPrompt(index: number): string {
  const prompt = runEmbeddedAgentMock.mock.calls[index]?.[0]?.prompt;
  if (typeof prompt !== "string") {
    throw new Error(`embedded-agent prompt ${index + 1} missing`);
  }
  return prompt;
}

describe("heartbeat reply admission", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    runEmbeddedAgentMock.mockReset().mockImplementation(async (params: RunEmbeddedAgentParams) => ({
      payloads: [{ text: "HEARTBEAT_OK" }],
      meta: {
        durationMs: 5,
        agentMeta: {
          sessionId: params.sessionId,
          provider: "anthropic",
          model: "claude-opus-4-6",
        },
      },
    }));
  });

  afterEach(() => {
    resetSystemEventsForTest();
    vi.unstubAllEnvs();
  });

  it("keeps global events isolated through production reply admission", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir }) => {
      const storeTemplate = path.join(tmpDir, "agents", "{agentId}", "sessions", "sessions.json");
      const cfg = markCompleteReplyConfig(
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-6",
              workspace: tmpDir,
            },
            entries: { main: { default: true }, alpha: {}, beta: {} },
          },
          models: {
            providers: {
              anthropic: {
                baseUrl: "https://api.anthropic.test",
                apiKey: "test-key",
                models: [
                  {
                    id: "claude-opus-4-6",
                    name: "Claude Opus 4.6",
                    reasoning: true,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 200_000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
          session: { scope: "global", store: storeTemplate },
        },
        { runtimeMode: "full" },
      ) as OpenClawConfig;
      await seedSessionStore(resolveStorePath(storeTemplate, { agentId: "alpha" }), "global", {});
      await seedSessionStore(resolveStorePath(storeTemplate, { agentId: "beta" }), "global", {});
      enqueueSystemEvent(
        "Alpha hook finished",
        withSystemEventOwner({ sessionKey: "global" }, "alpha"),
      );
      enqueueSystemEvent(
        "Beta hook finished",
        withSystemEventOwner({ sessionKey: "global" }, "beta"),
      );

      const alphaResult = await runHeartbeatOnce({
        cfg,
        agentId: "alpha",
        source: "hook",
        intent: "immediate",
        reason: "hook:wake",
        deps: heartbeatDeps,
      });

      expect(alphaResult.status).toBe("ran");
      expect(modelPrompt(0)).toContain("Alpha hook finished");
      expect(modelPrompt(0)).not.toContain("Beta hook finished");
      expect(peekSystemEventEntries("global").map((event) => event.text)).toEqual([
        "Beta hook finished",
      ]);

      const betaResult = await runHeartbeatOnce({
        cfg,
        agentId: "beta",
        source: "hook",
        intent: "immediate",
        reason: "hook:wake",
        deps: heartbeatDeps,
      });

      expect(betaResult.status).toBe("ran");
      expect(modelPrompt(1)).toContain("Beta hook finished");
      expect(modelPrompt(1)).not.toContain("Alpha hook finished");
      expect(peekSystemEventEntries("global")).toEqual([]);
    });
  });
});
