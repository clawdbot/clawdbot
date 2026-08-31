import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

// Live coverage, against the real native api.openai.com endpoint, for the
// argument-canonicalization half of this PR: HTTP continuation must still
// hold across a real multi-round tool-calling turn whose argument contains
// an integer value ABOVE Number.MAX_SAFE_INTEGER. This isolates the
// native-only path this PR's own code (claimOpenAIResponsesHttpContinuation)
// actually gates on, rather than the stack this PR's prior live evidence
// used, which also carried #128633's separate compat-endpoint opt-in.
//
// This test caught a real regression on first run: an earlier revision of
// this fix tagged the cached side's unsafe integer to distinguish it from a
// genuine same-digits string, but AssistantMessage.arguments already stores
// every unsafe integer as a string (parseJsonObjectPreservingUnsafeIntegers,
// precision-preserving), so an *unmodified* replay of this exact call always
// re-serializes it as a same-digits string -- tagging only the cached side
// made every real large-integer tool call permanently ineligible for
// continuation on its very next round. Confirmed live: this test failed
// (fell through to a full-history resend) before that tag was removed, and
// passes now. See the unit regression test with the same shape
// (`treats a cached number-typed unsafe integer as equal to its own
// replayed string-typed round-trip`) for the deterministic version of this
// proof.
//
// (The call_id-reshaping half of this PR is not exercisable here: a real
// native OpenAI tool-call id already arrives in the call_*/fc_*-paired shape
// normalizeOpenAIResponsesToolCallIds produces, so its idempotent
// short-circuit correctly leaves it unchanged -- an earlier version of this
// test asserted the id WOULD change and failed for exactly that reason.
// That half stays covered by the existing unit tests using the real
// transform function directly.)
const LIVE = process.env.OPENCLAW_LIVE_TEST === "1";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const describeLive = LIVE && OPENAI_KEY ? describe : describe.skip;
const LIVE_MODEL_ID = process.env.OPENCLAW_LIVE_RESPONSES_MODEL || "gpt-5.6-luna";
const LIVE_TIMEOUT_MS = 120_000;

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
          // Non-JSON body on this host is unexpected for a Responses call.
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

const recordValueTool = {
  name: "record_value",
  description: "Record an integer value for the test harness.",
  parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
};

function model(): Model<"openai-responses"> {
  return {
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
}

async function run(context: Context, sessionId: string): Promise<AssistantMessage> {
  const stream = await createOpenAIResponsesTransportStreamFn()(model(), context, {
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
  "HTTP continuation across a real unsafe-integer tool-call argument (real api.openai.com)",
  () => {
    afterEach(() => {
      cleanupSessionResources();
    });

    it(
      "continues a real tool-calling round whose argument is above Number.MAX_SAFE_INTEGER",
      async () => {
        const capture = new GlobalFetchRequestCapture();
        capture.install();
        try {
          const sessionId = "live-toolcall-arg-canonicalization";
          const unsafeInt = "9007199254740993"; // > Number.MAX_SAFE_INTEGER
          const firstUser = userMessage(
            `This is an automated test. Call the record_value tool with exactly n=${unsafeInt}. ` +
              "Do not round or alter the number.",
            1,
          );
          const callTurn = await run(
            { messages: [firstUser], tools: [recordValueTool] },
            sessionId,
          );
          const toolCall = callTurn.content.find((block) => block.type === "toolCall") as
            | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
            | undefined;
          expect(toolCall).toBeDefined();
          expect(String(toolCall?.arguments.n)).toBe(unsafeInt);

          const toolResultMsg = {
            role: "toolResult" as const,
            toolCallId: toolCall?.id ?? "",
            content: [{ type: "text" as const, text: "recorded" }],
            timestamp: 2,
          };
          const round1Messages: Context["messages"] = [firstUser, callTurn, toolResultMsg];
          const afterToolResult = await run(
            { messages: round1Messages, tools: [recordValueTool] },
            sessionId,
          );
          expect(afterToolResult.stopReason).toBe("stop");

          // Exactly two requests reached the real API -- a rejected
          // previous_response_id (the recovery path is a silent
          // full-history resend) would show up as a third.
          expect(capture.requests).toHaveLength(2);
          const secondRequest = capture.requests[1];
          expect(secondRequest).toHaveProperty("previous_response_id");
          expect(typeof secondRequest?.previous_response_id).toBe("string");
          expect((secondRequest?.previous_response_id as string).length).toBeGreaterThan(0);
          // toolCall.id is OpenClaw's own internal call_id|fc_id pairing;
          // the wire delta's call_id must be restored to the bare provider
          // call_id (the part before the pairing separator), not the
          // compound internal id.
          const rawCallId = toolCall?.id.split("|")[0];
          expect(secondRequest?.input).toEqual([
            {
              type: "function_call_output",
              call_id: rawCallId,
              output: "recorded",
            },
          ]);
        } finally {
          capture.restore();
        }
      },
      LIVE_TIMEOUT_MS,
    );
  },
);
