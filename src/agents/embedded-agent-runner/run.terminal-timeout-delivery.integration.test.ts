import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settleReplyDispatcher } from "../../auto-reply/dispatch-dispatcher.js";
import type { ReplyDispatchRuntimeInfo } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

const GENERIC_TIMEOUT = "LLM request timed out.";
const AUTHORITATIVE_TIMEOUT =
  "Provider timed out after the request started. Retry the turn, or increase its configured timeout.";
const TOOL_MEDIA_URL = "https://example.test/tool-output.png";

let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
let buildEmbeddedRunPayloads: typeof import("./run/payloads.js").buildEmbeddedRunPayloads;
let createReplyDispatcher: typeof import("../../auto-reply/reply/reply-dispatcher.js").createReplyDispatcher;

beforeAll(async () => {
  runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  ({ buildEmbeddedRunPayloads } =
    await vi.importActual<typeof import("./run/payloads.js")>("./run/payloads.js"));
  ({ createReplyDispatcher } = await import("../../auto-reply/reply/reply-dispatcher.js"));
});

beforeEach(() => {
  resetSharedRunIntegrationHarnessMocks();
});

describe("provider timeout final delivery", () => {
  it.each([
    {
      label: "one final timeout",
      rawError: "request timed out",
      preserveIndependentErrorAndMedia: false,
    },
    {
      label: "one final timeout when the provider already uses canonical timeout copy",
      rawError: GENERIC_TIMEOUT,
      preserveIndependentErrorAndMedia: false,
    },
    {
      label: "an independent same-text error and tool media",
      rawError: "request timed out",
      preserveIndependentErrorAndMedia: true,
    },
  ])(
    "delivers $label without duplicating the provider timeout",
    async ({ rawError, preserveIndependentErrorAndMedia }) => {
      const assistant = makeAssistantMessageFixture({
        stopReason: "aborted",
        errorMessage: rawError,
        content: [],
      });
      const independentError: ReplyPayload = { text: GENERIC_TIMEOUT, isError: true };
      mockedBuildEmbeddedRunPayloads.mockImplementation((params) => [
        ...buildEmbeddedRunPayloads(params),
        ...(preserveIndependentErrorAndMedia ? [independentError] : []),
      ]);
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
          currentAttemptCompletedAssistant: assistant,
          terminal: { kind: "timeout", phase: "prompt", source: "idle", aborted: true },
          promptTimeoutOutcome: {
            message: AUTHORITATIVE_TIMEOUT,
            replayInvalid: false,
            livenessState: "abandoned",
            timeoutPhase: "provider",
            providerStarted: true,
          },
          ...(preserveIndependentErrorAndMedia ? { toolMediaUrls: [TOOL_MEDIA_URL] } : {}),
        }),
      );
      useOpenAIPlatformAuthFixture();

      const result = await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.4",
        runId: "provider-idle-timeout-single-final-delivery",
      });
      const finalPayloads = result.payloads ?? [];
      const physicalSends: Array<{ payload: ReplyPayload; info: ReplyDispatchRuntimeInfo }> = [];
      const mockChannelApi = vi.fn(
        async (payload: ReplyPayload, info: ReplyDispatchRuntimeInfo) => {
          physicalSends.push({ payload, info });
          return { visibleReplySent: true, messageId: `mock-send-${physicalSends.length}` };
        },
      );
      const dispatcher = createReplyDispatcher({ deliver: mockChannelApi });

      for (const payload of finalPayloads) {
        expect(dispatcher.sendFinalReply(payload)).toBe(true);
      }
      await settleReplyDispatcher({ dispatcher });

      const independentSend = {
        payload: expect.objectContaining({
          text: GENERIC_TIMEOUT,
          isError: true,
          mediaUrl: TOOL_MEDIA_URL,
          mediaUrls: [TOOL_MEDIA_URL],
        }),
        info: expect.objectContaining({ kind: "final" }),
      };
      const authoritativeSend = {
        payload: { text: AUTHORITATIVE_TIMEOUT, isError: true },
        info: expect.objectContaining({ kind: "final" }),
      };

      expect(physicalSends).toEqual(
        preserveIndependentErrorAndMedia
          ? [independentSend, authoritativeSend]
          : [authoritativeSend],
      );
      expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
    },
  );
});
