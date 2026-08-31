import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

// Live coverage for the instructions-field default against the *real* native
// OpenAI Responses API. The committed loopback integration test
// (openai-responses-payload-policy.instructions.integration.test.ts) proves
// openclaw's own request-building logic; it cannot prove the real API
// actually accepts top-level `instructions` the way openclaw assumes, or
// that HTTP continuation still works once the system prompt moved out of
// `input`. This test captures the literal request bytes that leave the
// process for the real API by wrapping globalThis.fetch. This avoids a proxy
// while retaining the explicit native OpenAI baseUrl below; a loopback proxy
// baseUrl would itself defeat the native-route classification under test.
const LIVE = process.env.OPENCLAW_LIVE_TEST === "1";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const describeLive = LIVE && OPENAI_KEY ? describe : describe.skip;
const LIVE_MODEL_ID = process.env.OPENCLAW_LIVE_RESPONSES_MODEL || "gpt-5.6-luna";
const LIVE_TIMEOUT_MS = 120_000;

function userMessage(text: string, timestamp: number) {
  return { role: "user" as const, content: text, timestamp };
}

async function captureOpenAIRequests<T>(run: () => Promise<T>): Promise<{
  result: T;
  requests: Array<Record<string, unknown>>;
}> {
  const requests: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("api.openai.com") && typeof init?.body === "string") {
      try {
        requests.push(JSON.parse(init.body) as Record<string, unknown>);
      } catch {
        // Non-JSON body (unexpected for this endpoint) -- skip capture, still forward the real call.
      }
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const result = await run();
    return { result, requests };
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function runTurn(
  model: Model<"openai-responses">,
  context: Context,
  sessionId: string,
): Promise<AssistantMessage> {
  const stream = await createOpenAIResponsesTransportStreamFn()(model, context, {
    apiKey: OPENAI_KEY,
    sessionId,
    transport: "sse",
    reasoningEffort: "low",
    maxTokens: 256,
    onPayload: (payload: Record<string, unknown>) => ({ ...payload, store: true }),
  } as never);
  return stream.result();
}

describeLive("instructions-field default on the real native OpenAI Responses API", () => {
  afterEach(() => {
    cleanupSessionResources();
  });

  it(
    "carries the system prompt via top-level instructions and still continues via previous_response_id",
    async () => {
      // Explicit canonical baseUrl: usesKnownNativeOpenAIRoute classifies
      // this as native via endpointClass "openai-public" either way, but
      // continuation eligibility (supportsNativeOpenAIResponsesEndpoint in
      // openai-responses-websocket.ts) is stricter -- it requires an exact
      // https://api.openai.com/v1 origin/path match and returns false for
      // an absent baseUrl outright, unlike this PR's own instructions-field
      // policy which treats "no baseUrl + provider openai" as native too.
      // A loopback proxy baseUrl would fail that same exact-match check,
      // which is why capture happens via a fetch wrapper instead (see above).
      const model: Model<"openai-responses"> = {
        id: LIVE_MODEL_ID,
        name: LIVE_MODEL_ID,
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">;

      const sessionId = "live-instructions-default-continuation";
      const secretCode = "GRANITE-ORBIT-4127";
      const firstUser = userMessage(
        `This is an automated test. Remember this secret code: ${secretCode}. ` +
          "Do not reply with the code yet -- just reply with exactly: ack",
        1,
      );

      const { result: first, requests: firstRequests } = await captureOpenAIRequests(() =>
        runTurn(
          model,
          { systemPrompt: "You are a terse test assistant.", messages: [firstUser], tools: [] },
          sessionId,
        ),
      );
      expect(first.stopReason).toBe("stop");
      expect(firstRequests).toHaveLength(1);
      // The actual claim under test: the real native API request carries
      // instructions at top level, not the system prompt embedded in input.
      expect(firstRequests[0]?.instructions).toBe("You are a terse test assistant.");
      expect(firstRequests[0]).not.toHaveProperty("previous_response_id");

      const { result: second, requests: secondRequests } = await captureOpenAIRequests(() =>
        runTurn(
          model,
          {
            systemPrompt: "You are a terse test assistant.",
            messages: [
              firstUser,
              first,
              userMessage("What was the secret code I gave you? Reply with exactly that code.", 2),
            ],
            tools: [],
          },
          sessionId,
        ),
      );
      expect(second.stopReason).toBe("stop");
      const secondText = second.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      // Structural proof (previous_response_id present) is not behavioral
      // proof -- a silent full-history fallback would look identical on the
      // wire shape alone. The model can only produce this secret if the
      // real API actually resolved server-side state through
      // previous_response_id, since the trimmed turn-2 input never repeats it.
      expect(secondText).toContain(secretCode);
      expect(secondRequests).toHaveLength(1);
      expect(secondRequests[0]).toHaveProperty("previous_response_id");
      expect(typeof secondRequests[0]?.previous_response_id).toBe("string");
      const previousResponseId = secondRequests[0]?.previous_response_id as string | undefined;
      expect(previousResponseId?.length).toBeGreaterThan(0);
      // Instructions keep flowing on every request regardless of
      // continuation status (they are not part of the continuation
      // comparator -- see openai-responses-continuation.ts).
      expect(secondRequests[0]?.instructions).toBe("You are a terse test assistant.");
      const secondInput = secondRequests[0]?.input as Array<{ role?: string }> | undefined;
      expect(secondInput?.every((item) => item.role !== "system")).toBe(true);
      expect(secondInput).toHaveLength(1);
    },
    LIVE_TIMEOUT_MS,
  );
});
