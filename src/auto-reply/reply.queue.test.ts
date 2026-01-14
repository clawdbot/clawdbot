import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import {
  isEmbeddedPiRunActive,
  isEmbeddedPiRunStreaming,
  runEmbeddedPiAgent,
} from "../agents/pi-embedded.js";
import { getReplyFromConfig } from "./reply.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) =>
    `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

function makeResult(text: string) {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  };
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      return await fn(home);
    },
    { prefix: "clawdbot-queue-" },
  );
}

function makeCfg(home: string, queue?: Record<string, unknown>) {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: path.join(home, "clawd"),
      },
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: path.join(home, "sessions.json") },
    messages: queue ? { queue } : undefined,
  };
}

describe("queue followups", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("collects queued messages and drains after run completes", async () => {
    vi.useFakeTimers();
    await withTempHome(async (home) => {
      const prompts: string[] = [];
      vi.mocked(runEmbeddedPiAgent).mockImplementation(async (params) => {
        prompts.push(params.prompt);
        if (params.prompt.includes("[Queued messages while agent was busy]")) {
          return makeResult("followup");
        }
        return makeResult("main");
      });

      vi.mocked(isEmbeddedPiRunActive).mockReturnValue(true);
      vi.mocked(isEmbeddedPiRunStreaming).mockReturnValue(true);

      const cfg = makeCfg(home, {
        mode: "collect",
        debounceMs: 200,
        cap: 10,
        drop: "summarize",
      });

      const first = await getReplyFromConfig(
        { Body: "first", From: "+1001", To: "+2000" },
        {},
        cfg,
      );
      expect(first).toBeUndefined();
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();

      vi.mocked(isEmbeddedPiRunActive).mockReturnValue(false);
      vi.mocked(isEmbeddedPiRunStreaming).mockReturnValue(false);

      const second = await getReplyFromConfig(
        { Body: "second", From: "+1001", To: "+2000" },
        {},
        cfg,
      );

      const secondText = Array.isArray(second) ? second[0]?.text : second?.text;
      expect(secondText).toBe("main");

      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();

      expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(2);
      expect(
        prompts.some((p) =>
          p.includes("[Queued messages while agent was busy]"),
        ),
      ).toBe(true);
    });
  });

  it("summarizes dropped followups when cap is exceeded", async () => {
    vi.useFakeTimers();
    await withTempHome(async (home) => {
      const prompts: string[] = [];
      vi.mocked(runEmbeddedPiAgent).mockImplementation(async (params) => {
        prompts.push(params.prompt);
        return makeResult("ok");
      });

      vi.mocked(isEmbeddedPiRunActive).mockReturnValue(true);
      vi.mocked(isEmbeddedPiRunStreaming).mockReturnValue(false);

      const cfg = makeCfg(home, {
        mode: "followup",
        debounceMs: 0,
        cap: 1,
        drop: "summarize",
      });

      await getReplyFromConfig(
        { Body: "one", From: "+1002", To: "+2000" },
        {},
        cfg,
      );
      await getReplyFromConfig(
        { Body: "two", From: "+1002", To: "+2000" },
        {},
        cfg,
      );

      vi.mocked(isEmbeddedPiRunActive).mockReturnValue(false);
      await getReplyFromConfig(
        { Body: "three", From: "+1002", To: "+2000" },
        {},
        cfg,
      );

      await vi.runAllTimersAsync();
      await Promise.resolve();

      expect(prompts.some((p) => p.includes("[Queue overflow]"))).toBe(true);
    });
  });
});
