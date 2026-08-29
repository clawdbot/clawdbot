import type { ModelCompatConfig } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it, vi } from "vitest";
import {
  createStartedThreadHarness,
  createTestParams,
  fastWait,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("Codex reasoning effort across completed turns", () => {
  it.each([
    {
      metadata: "Platform",
      supported: ["none", "low", "medium", "high", "xhigh", "max"],
      expectedOff: "none",
    },
    {
      metadata: "subscription",
      supported: ["low", "medium", "high", "xhigh", "max"],
      expectedOff: null,
    },
    { metadata: "unknown", supported: undefined, expectedOff: null },
  ] as const)(
    "changes high to off on the same thread with $metadata metadata",
    async ({ metadata, supported, expectedOff }) => {
      let turnCount = 0;
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "thread/resume") {
          return threadStartResult();
        }
        if (method === "turn/start") {
          return turnStartResult(`turn-${++turnCount}`);
        }
        return undefined;
      });
      const params = createTestParams();
      const compat: ModelCompatConfig = {
        supportsTools: false,
        ...(supported ? { supportedReasoningEfforts: [...supported] } : {}),
      };
      params.provider = "openai";
      params.modelId = "gpt-5.6-luna";
      params.model = {
        ...params.model,
        provider: "openai",
        id: params.modelId,
        api: metadata === "subscription" ? "openai-chatgpt-responses" : "openai-responses",
        baseUrl:
          metadata === "subscription"
            ? "https://chatgpt.com/backend-api/codex"
            : "https://api.openai.com/v1",
        compat,
      };

      for (const [index, thinkLevel] of (["high", "off"] as const).entries()) {
        const run = runCodexAppServerAttempt({
          ...params,
          thinkLevel,
          runId: `run-${index + 1}`,
        });
        await vi.waitFor(() => expect(turnCount).toBe(index + 1), fastWait);
        await harness.completeTurn({ threadId: "thread-1", turnId: `turn-${index + 1}` });
        await run;
      }

      expect(harness.requests.filter(({ method }) => method === "thread/start")).toHaveLength(1);
      const turnRequests = harness.requests.filter(({ method }) => method === "turn/start");
      expect(turnRequests.map(({ params: request }) => request)).toMatchObject([
        {
          threadId: "thread-1",
          effort: "high",
          collaborationMode: { settings: { reasoning_effort: "high" } },
        },
        {
          threadId: "thread-1",
          effort: expectedOff,
          collaborationMode: { settings: { reasoning_effort: expectedOff } },
        },
      ]);
    },
  );
});
