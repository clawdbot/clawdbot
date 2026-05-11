import { completeSimple, getModel, streamSimple } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveTestEnabled,
} from "./live-test-helpers.js";
import {
  isBillingErrorMessage,
  isOverloadedErrorMessage,
} from "./pi-embedded-helpers/failover-matches.js";
import { applyExtraParamsToAgent } from "./pi-embedded-runner.js";
import { createWebSearchTool } from "./tools/web-search.js";

const XAI_KEY = process.env.XAI_API_KEY ?? "";
const LIVE = isLiveTestEnabled(["XAI_LIVE_TEST"]);
const XAI_COMPLETE_LIVE_TIMEOUT_MS = 90_000;
const XAI_WEB_SEARCH_LIVE_TIMEOUT_SECONDS = 60;

const describeLive = LIVE && XAI_KEY ? describe : describe.skip;

type AssistantLikeMessage = {
  content: Array<{
    type?: string;
    text?: string;
    id?: string;
    function?: {
      strict?: unknown;
    };
  }>;
};

function resolveLiveXaiModel() {
  return getModel("xai", "grok-4.3" as never) ?? getModel("xai", "grok-4");
}

function requireLiveValue<T>(value: T | null | undefined, label: string): T {
  if (value == null) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

async function runXaiLiveCase(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isBillingErrorMessage(message)) {
      console.warn(`[xai:live] skip ${label}: billing drift: ${message}`);
      return;
    }
    if (isOverloadedErrorMessage(message)) {
      console.warn(`[xai:live] skip ${label}: temporary provider capacity: ${message}`);
      return;
    }
    if (message.includes("web_search is disabled or no provider is available")) {
      console.warn(`[xai:live] skip ${label}: web_search unavailable in this environment`);
      return;
    }
    throw error;
  }
}

async function collectDoneMessage(
  stream: AsyncIterable<{ type: string; message?: AssistantLikeMessage }>,
): Promise<AssistantLikeMessage> {
  let doneMessage: AssistantLikeMessage | undefined;
  for await (const event of stream) {
    if (event.type === "done") {
      doneMessage = event.message;
    }
  }
  return requireLiveValue(doneMessage, "done message");
}

describeLive("xai live", () => {
  it(
    "returns assistant text for Grok 4.3",
    async () => {
      await runXaiLiveCase("complete", async () => {
        const model = requireLiveValue(resolveLiveXaiModel(), "xAI model");
        const res = await completeSimple(
          model,
          {
            messages: createSingleUserPromptMessage(),
          },
          {
            apiKey: XAI_KEY,
            maxTokens: 64,
          },
        );

        expect(extractNonEmptyAssistantText(res.content).length).toBeGreaterThan(0);
      });
    },
    XAI_COMPLETE_LIVE_TIMEOUT_MS,
  );

  it("sends wrapped xAI tool payloads live", async () => {
    await runXaiLiveCase("tool-call", async () => {
      const model = requireLiveValue(resolveLiveXaiModel(), "xAI model");
      const agent = { streamFn: streamSimple };
      applyExtraParamsToAgent(agent, undefined, "xai", model.id);

      const noopTool = {
        name: "noop",
        description: "Return ok.",
        parameters: Type.Object({}, { additionalProperties: false }),
      };

      let capturedPayload: Record<string, unknown> | undefined;
      const stream = agent.streamFn(
        model,
        {
          messages: createSingleUserPromptMessage(
            "Call the tool `noop` with {} if needed, then finish.",
          ),
          tools: [noopTool],
        },
        {
          apiKey: XAI_KEY,
          maxTokens: 128,
          onPayload: (payload) => {
            capturedPayload = payload as Record<string, unknown>;
          },
        },
      );

      const doneMessage = await collectDoneMessage(
        stream as AsyncIterable<{ type: string; message?: AssistantLikeMessage }>,
      );
      expect(Array.isArray(doneMessage.content)).toBe(true);
      const payload = requireLiveValue(capturedPayload, "captured xAI payload");
      if ("tool_stream" in payload) {
        expect(payload.tool_stream).toBe(true);
      }

      const payloadTools = Array.isArray(payload.tools)
        ? (payload.tools as Array<Record<string, unknown>>)
        : [];
      expect(payloadTools.length).toBeGreaterThan(0);
      const firstFunction = payloadTools[0]?.function;
      expect(firstFunction).not.toBeNull();
      expect(typeof firstFunction).toBe("object");
      expect(Array.isArray(firstFunction)).toBe(false);
      expect([undefined, false]).toContain((firstFunction as Record<string, unknown>).strict);
    });
  }, 90_000);

  it("runs Grok web_search live", async () => {
    await runXaiLiveCase("web-search", async () => {
      const tool = createWebSearchTool({
        config: {
          tools: {
            web: {
              search: {
                provider: "grok",
                timeoutSeconds: XAI_WEB_SEARCH_LIVE_TIMEOUT_SECONDS,
                grok: {
                  model: "grok-4-1-fast",
                },
              },
            },
          },
        },
      });

      const webSearchTool = requireLiveValue(tool, "grok web search tool");
      const result = await webSearchTool.execute("web-search:grok-live", {
        query: "OpenClaw GitHub",
        count: 3,
      });

      const details = (result.details ?? {}) as {
        provider?: string;
        content?: string;
        citations?: string[];
        inlineCitations?: Array<unknown>;
        error?: string;
        message?: string;
      };

      const errorMessage =
        details.error && details.message
          ? `${details.error} ${details.message}`
          : details.error || details.message || "";
      if (isBillingErrorMessage(errorMessage)) {
        console.warn(`[xai:live] skip web-search: billing drift: ${errorMessage}`);
        return;
      }

      expect(details.error, details.message).toBeUndefined();
      expect(details.provider).toBe("grok");
      expect(details.content?.trim().length ?? 0).toBeGreaterThan(0);

      const citationCount =
        (Array.isArray(details.citations) ? details.citations.length : 0) +
        (Array.isArray(details.inlineCitations) ? details.inlineCitations.length : 0);
      expect(citationCount).toBeGreaterThan(0);
    });
  }, 90_000);
});
