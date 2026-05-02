import { completeSimple, getModel, streamSimple } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveTestEnabled,
} from "./live-test-helpers.js";
import { isBillingErrorMessage } from "./pi-embedded-helpers/failover-matches.js";
import { applyExtraParamsToAgent } from "./pi-embedded-runner.js";
import { createWebSearchTool } from "./tools/web-search.js";

const XAI_KEY = process.env.XAI_API_KEY ?? "";
const LIVE = isLiveTestEnabled(["XAI_LIVE_TEST"]);
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

async function runXaiLiveCase(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isBillingErrorMessage(message)) {
      console.warn(`[xai:live] skip ${label}: billing drift: ${message}`);
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
  expect(doneMessage).toBeDefined();
  return doneMessage!;
}

describeLive("xai live", () => {
  it("returns assistant text for Grok 4.3", async () => {
    await runXaiLiveCase("complete", async () => {
      const model = resolveLiveXaiModel();
      expect(model).toBeDefined();
      const res = await completeSimple(
        model,
        {
          messages: createSingleUserPromptMessage(),
        },
        {
          apiKey: XAI_KEY,
          maxTokens: 64,
          reasoning: "medium",
        },
      );

      expect(extractNonEmptyAssistantText(res.content).length).toBeGreaterThan(0);
    });
  }, 30_000);

  it("sends wrapped xAI tool payloads live", async () => {
    await runXaiLiveCase("tool-call", async () => {
      const model = resolveLiveXaiModel();
      expect(model).toBeDefined();
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
          reasoning: "medium",
          onPayload: (payload) => {
            capturedPayload = payload as Record<string, unknown>;
          },
        },
      );

      const doneMessage = await collectDoneMessage(
        stream as AsyncIterable<{ type: string; message?: AssistantLikeMessage }>,
      );
      expect(doneMessage).toBeDefined();
      expect(capturedPayload).toBeDefined();
      expect(capturedPayload?.tool_stream).toBe(true);

      const payloadTools = Array.isArray(capturedPayload?.tools)
        ? (capturedPayload.tools as Array<Record<string, unknown>>)
        : [];
      expect(payloadTools.length).toBeGreaterThan(0);
      const firstFunction = payloadTools[0]?.function;
      expect(firstFunction && typeof firstFunction === "object").toBe(true);
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

      expect(tool).toBeTruthy();
      const result = await tool!.execute("web-search:grok-live", {
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

      const errorMessage = [details.error, details.message].filter(Boolean).join(" ");
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
