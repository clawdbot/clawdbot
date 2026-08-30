import type { AssistantMessage, Context, Model, Tool } from "@openclaw/llm-core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

// Live coverage, against the real native api.openai.com endpoint, for the
// exact question the requestWithoutInput() `tools` exclusion depends on: does
// the official Responses API actually accept and honor previous_response_id
// when the current turn's `tools` differs from the turn that produced that
// response? A unit test on the comparator alone can prove openclaw *decides*
// to continue; only a real round-trip against the official API can prove the
// provider accepts that combination instead of rejecting it.
const LIVE = process.env.OPENCLAW_LIVE_TEST === "1";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const describeLive = LIVE && OPENAI_KEY ? describe : describe.skip;
const LIVE_MODEL_ID = process.env.OPENCLAW_LIVE_RESPONSES_MODEL || "gpt-5.6-luna";
const LIVE_TIMEOUT_MS = 120_000;

// The native-endpoint eligibility check
// (supportsNativeOpenAIResponsesEndpoint) matches the literal baseUrl string
// against https://api.openai.com/v1, so this test cannot front the request
// with a capturing loopback proxy the way the sibling
// openai-responses-client.continuation.live.test.ts does for a private-network
// opt-in scenario. Instead it captures at the injectable seam one layer in:
// the OpenAI SDK client is constructed with `fetch: buildGuardedModelFetch(model)`,
// which falls back to the live `globalThis.fetch` for an unconfigured
// (default/inert) AiTransportHost -- read fresh at call time, not captured at
// import time -- so patching it here still forwards every real byte to the
// real API and records exactly what was sent.
class GlobalFetchRequestCapture {
  readonly requests: Array<Record<string, unknown>> = [];
  private readonly realFetch = globalThis.fetch;

  install(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body;
      if (url.includes("api.openai.com") && typeof body === "string") {
        try {
          this.requests.push(JSON.parse(body) as Record<string, unknown>);
        } catch {
          // Non-JSON body on this host is unexpected for a Responses call;
          // let it through unrecorded rather than fail the real request.
        }
      }
      return this.realFetch(input, init);
    }) as typeof fetch;
  }

  restore(): void {
    globalThis.fetch = this.realFetch;
  }
}

function userMessage(text: string, timestamp: number) {
  return { role: "user" as const, content: text, timestamp };
}

const toolA: Tool = {
  name: "read_file",
  description: "Read the contents of a file by path.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const toolB: Tool = {
  name: "web_fetch",
  description: "Fetch the contents of a URL.",
  parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
};

async function run(
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

describeLive(
  "OpenAI Responses HTTP continuation across a tools-list change (real api.openai.com)",
  () => {
    afterEach(() => {
      cleanupSessionResources();
    });

    it(
      "accepts previous_response_id after the turn's tool list changes, and still resolves history server-side",
      async () => {
        const capture = new GlobalFetchRequestCapture();
        capture.install();
        try {
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
          const sessionId = "live-http-continuation-tools-change";
          // Same secret-recall shape as the sibling live test: a structurally
          // correct previous_response_id is not proof the server actually used
          // the omitted history -- the model could get lucky on a
          // self-contained prompt. Only a correct answer to a fact stated
          // solely in the omitted turn-1 history proves real server-side
          // continuation, as opposed to a silently-accepted but effectively
          // stateless request.
          const secretCode = "OPAL-CINDER-4482";
          const firstUser = userMessage(
            `This is an automated test. Remember this secret code: ${secretCode}. ` +
              "Do not reply with the code yet -- just reply with exactly: ack",
            1,
          );
          const first = await run(model, { messages: [firstUser], tools: [toolA] }, sessionId);
          expect(first.stopReason).toBe("stop");

          // Turn 2 offers a genuinely different tool list than turn 1 -- the
          // exact condition requestWithoutInput() now excludes from the
          // continuation comparison instead of forcing request_changed.
          const second = await run(
            model,
            {
              messages: [
                firstUser,
                first,
                userMessage(
                  "What was the secret code I gave you? Reply with exactly that code.",
                  2,
                ),
              ],
              tools: [toolA, toolB],
            },
            sessionId,
          );
          expect(second.stopReason).toBe("stop");
          const secondText = second.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
          expect(secondText).toContain(secretCode);

          // Exactly two requests reached the real API -- a silent full-history
          // fallback (the recovery path for a rejected previous_response_id)
          // would show up as a third captured request here.
          expect(capture.requests).toHaveLength(2);
          expect(capture.requests[0]).not.toHaveProperty("previous_response_id");
          const secondRequest = capture.requests[1];
          expect(secondRequest).toHaveProperty("previous_response_id");
          expect(typeof secondRequest?.previous_response_id).toBe("string");
          expect((secondRequest?.previous_response_id as string).length).toBeGreaterThan(0);
          // The wire request really did carry the changed (2-tool) list, not a
          // stale cached copy of turn 1's single-tool list.
          expect(secondRequest?.tools).toHaveLength(2);
          expect(
            (secondRequest?.tools as Array<{ name: string }>).map((t) => t.name).sort(),
          ).toEqual(["read_file", "web_fetch"]);
          // Trimmed input -- only the new user message, not the full replayed
          // history -- confirms this was a real continuation, not the
          // full-history fallback succeeding to coincidentally produce the
          // right answer.
          expect(secondRequest?.input).toEqual([
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "What was the secret code I gave you? Reply with exactly that code.",
                },
              ],
            },
          ]);
          expect(JSON.stringify(secondRequest)).not.toContain(secretCode);
        } finally {
          capture.restore();
        }
      },
      LIVE_TIMEOUT_MS,
    );
  },
);
