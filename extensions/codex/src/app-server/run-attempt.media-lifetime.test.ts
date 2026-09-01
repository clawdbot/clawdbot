import path from "node:path";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { createHostTtsRuntimeContract } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import * as dynamicTools from "./dynamic-tools.js";
import {
  createParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("Codex attempt TTS media lifetime", () => {
  it.each([
    { scenario: "normal", timedOut: false, earlierAccepted: false },
    { scenario: "timed out", timedOut: true, earlierAccepted: false },
    { scenario: "timed out after earlier accepted audio", timedOut: true, earlierAccepted: true },
  ])(
    "delivers only accepted genuine host TTS after full Codex finalization: $scenario",
    async ({ timedOut, earlierAccepted }) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const middleware = async (event: {
        toolCallId: string;
        result: AgentToolResult<unknown>;
      }) => {
        if (event.toolCallId === "host-tts") {
          entered.resolve();
          await release.promise;
        }
        return { result: event.result };
      };
      const registry = createEmptyPluginRegistry();
      registry.agentToolResultMiddlewares.push({
        pluginId: "held-result",
        pluginName: "Held result",
        rawHandler: middleware,
        handler: middleware,
        runtimes: ["codex"],
        source: "test",
      });
      setActivePluginRegistry(registry);
      const createBridge = vi.spyOn(dynamicTools, "createCodexDynamicToolBridge");
      const harness = createStartedThreadHarness();
      const params = createParams(
        path.join(tempDir, "session.jsonl"),
        path.join(tempDir, "workspace"),
      );
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.sourceReplyDeliveryMode = "message_tool_only";
      params.toolsAllow = ["tts"];
      setCodexTestModelSupportsTools(params, true);
      const audioPath = path.join(tempDir, "reply.opus");
      const earlierPath = path.join(tempDir, "earlier.opus");
      const host = await createHostTtsRuntimeContract(params, audioPath);
      params.hostCapabilities = host.hostCapabilities;
      const run = runCodexAppServerAttempt(params);
      let handle:
        | MockInstance<
            ReturnType<typeof dynamicTools.createCodexDynamicToolBridge>["handleToolCall"]
          >
        | undefined;
      try {
        await harness.waitForMethod("turn/start");
        const bridge = createBridge.mock.results[0]?.value;
        if (!bridge) {
          throw new Error("Expected the attempt's real dynamic tool bridge");
        }
        handle = vi.spyOn(bridge, "handleToolCall");
        if (earlierAccepted) {
          host.synthesis.mockResolvedValueOnce({
            success: true,
            audioPath: earlierPath,
            provider: "test-speech",
            audioAsVoice: true,
          });
          expect(
            await harness.handleServerRequest({
              id: "earlier-tts",
              method: "item/tool/call",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                callId: "earlier-tts",
                namespace: null,
                tool: "tts",
                arguments: { text: "Earlier accepted audio." },
              },
            }),
          ).toMatchObject({ success: true });
        }
        vi.useFakeTimers();
        const response = harness.handleServerRequest({
          id: "host-tts",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "host-tts",
            namespace: null,
            tool: "tts",
            arguments: { text: "Read this aloud.", timeoutMs: 1 },
          },
        });
        await entered.promise;
        if (timedOut) {
          await vi.advanceTimersByTimeAsync(1);
          expect(await response).toMatchObject({ success: false });
        }
        release.resolve();
        // The watchdog winner does not await its losing middleware continuation.
        await Promise.all(handle.mock.results.map((entry) => entry.value));
        expect(await response).toMatchObject({ success: !timedOut });
        expect(host.synthesis).toHaveBeenCalledTimes(earlierAccepted ? 2 : 1);
        vi.useRealTimers();
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        const result = await run;
        const expectedMedia = earlierAccepted ? [earlierPath] : timedOut ? [] : [audioPath];
        expect(host.deliverablePayloads(result)).toEqual(
          expectedMedia.length
            ? [
                expect.objectContaining({
                  mediaUrls: expectedMedia,
                  audioAsVoice: true,
                  trustedLocalMedia: true,
                }),
              ]
            : [],
        );
        expect(result.toolMediaUrls ?? []).toEqual(expectedMedia);
      } finally {
        release.resolve();
        await Promise.allSettled(handle?.mock.results.map((entry) => entry.value) ?? []);
        vi.useRealTimers();
        host.close();
        setActivePluginRegistry(createEmptyPluginRegistry());
      }
    },
  );
});
