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
// GlobalFetchRequestCapture also tees each captured response's raw SSE
// bytes (rawResponseTexts) and extractRawFunctionCallArguments pulls the
// `response.function_call_arguments.done` event's raw arguments string out
// of round 1's response, asserting it's a genuine bare/unquoted integer
// literal on the wire -- not a model-quoted string, which the pre-fix
// comparison already handled correctly. Without this, asserting only on
// the post-parser AssistantMessage.arguments value can't tell those two
// cases apart (both parse to the same string), so it wouldn't actually
// prove this fix's regression path. Confirmed live: raw wire text was
// exactly `{"n":9007199254740993}` -- a bare literal.
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
  // Raw SSE response bodies, one entry per captured request, in the same
  // order as `requests`. Captured via a stream tee so the real SDK consumer
  // is never disturbed -- this exists specifically to inspect the raw wire
  // bytes api.openai.com actually sent, before any OpenClaw-side parsing
  // (parseStreamingJson / parseJsonObjectPreservingUnsafeIntegers) can turn
  // an unsafe integer literal into a string. Without this, a live test that
  // only asserts on the post-parser AssistantMessage.arguments value can't
  // tell a real unquoted 9007199254740993 apart from the model having
  // quoted it as a string itself -- the case the pre-fix comparison already
  // handled, so it would prove nothing about this fix. (ClawSweeper P2 on
  // #134423.)
  readonly rawResponseTexts: string[] = [];
  private readonly realFetch = globalThis.fetch;

  install(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body;
      const isTarget = url.includes("api.openai.com") && typeof body === "string";
      if (isTarget) {
        try {
          this.requests.push(JSON.parse(body) as Record<string, unknown>);
        } catch {
          // Non-JSON body on this host is unexpected for a Responses call.
        }
      }
      const response = await this.realFetch(input, init);
      if (!isTarget || !response.body) {
        return response;
      }
      const [forCaller, forCapture] = response.body.tee();
      const captureIndex = this.rawResponseTexts.length;
      this.rawResponseTexts.push("");
      void (async () => {
        const reader = forCapture.getReader();
        const decoder = new TextDecoder();
        let text = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            text += decoder.decode(value, { stream: true });
          }
        } catch {
          // Best-effort capture; the real caller's own stream is unaffected.
        }
        this.rawResponseTexts[captureIndex] = text;
      })();
      return new Response(forCaller, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }) as typeof fetch;
  }

  restore(): void {
    globalThis.fetch = this.realFetch;
  }
}

/** Extracts the raw (pre-parser) arguments string from a captured SSE response's
 * `response.function_call_arguments.done` event -- the exact wire text the
 * provider sent for the tool call's arguments, before any OpenClaw-side JSON
 * parsing normalizes an unsafe integer literal into a string. */
function extractRawFunctionCallArguments(rawSse: string): string | undefined {
  for (const line of rawSse.split("\n")) {
    const trimmed = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!trimmed || trimmed === "[DONE]") {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      event &&
      typeof event === "object" &&
      (event as { type?: unknown }).type === "response.function_call_arguments.done" &&
      typeof (event as { arguments?: unknown }).arguments === "string"
    ) {
      return (event as { arguments: string }).arguments;
    }
  }
  return undefined;
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

          // Prove the provider actually emitted a bare, unquoted numeric literal
          // on the wire -- not a model-quoted string, which the pre-fix
          // comparison already handled and would make this whole test prove
          // nothing about the fix. Inspects raw SSE bytes, before any
          // OpenClaw-side parsing.
          const rawArguments = extractRawFunctionCallArguments(capture.rawResponseTexts[0] ?? "");
          expect(
            rawArguments,
            `expected a response.function_call_arguments.done event in the raw SSE response; got ${capture.rawResponseTexts.length} captured response(s)`,
          ).toBeDefined();
          expect(
            rawArguments,
            `raw wire arguments must contain the bare unquoted integer ${unsafeInt}, not a quoted string; got: ${rawArguments}`,
          ).toMatch(new RegExp(`"n"\\s*:\\s*${unsafeInt}(?!")`));
          expect(
            rawArguments,
            `raw wire arguments must NOT have quoted the integer as a string; got: ${rawArguments}`,
          ).not.toMatch(new RegExp(`"n"\\s*:\\s*"${unsafeInt}"`));

          const toolResultMsg = {
            role: "toolResult" as const,
            toolCallId: toolCall?.id ?? "",
            toolName: "record_value",
            isError: false,
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
          expect(
            (secondRequest?.previous_response_id as string | undefined)?.length ?? 0,
          ).toBeGreaterThan(0);
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
