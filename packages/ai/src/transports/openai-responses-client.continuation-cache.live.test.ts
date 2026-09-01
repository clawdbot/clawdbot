import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

// Live coverage for the idle-TTL default bump and the ready-entry
// count/byte-budget cache (this PR's own changes) against the *real* native
// api.openai.com endpoint -- the existing continuation unit/mocked tests can
// only prove this module's own selection and eviction logic; they cannot
// prove the real API still honors previous_response_id, or that the new
// capacity/byte-bookkeeping wired around a commit doesn't silently break the
// wire request, for a genuine native connection with no compat opt-in
// (ClawSweeper P1 on #134550: "no redacted after-fix real transport trace
// shows the 90-minute reuse behavior").
//
// A capturing fetch shim (not a loopback proxy) is enough here: this test
// only needs each request body, not the raw SSE stream, so it skips the
// tee/stream-capture machinery the unsafe-integer live test needs.
const LIVE = process.env.OPENCLAW_LIVE_TEST === "1";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const describeLive = LIVE && OPENAI_KEY ? describe : describe.skip;
const LIVE_MODEL_ID = process.env.OPENCLAW_LIVE_RESPONSES_MODEL || "gpt-5.6-luna";
const LIVE_TIMEOUT_MS = 120_000;
// Real wall-clock gap the second test waits between turns, comfortably past
// the *former* 5-minute idle TTL this PR replaces -- a live run that only
// sends turn 2 immediately (like the first test above) can't tell "the cache
// survived because the new 90-minute TTL actually matters" apart from "the
// cache would have survived under the old 5-minute TTL too" (ClawSweeper P2
// on #134550: "does not show the proposed post-five-minute... improvement").
// Real setTimeout, not fake timers: this exercises the real in-memory idle
// eviction timer against real elapsed time, which fake timers can't stand in
// for over a genuine network round trip.
const PAST_FORMER_TTL_DELAY_MS = 6 * 60 * 1000;
const DELAYED_TIMEOUT_MS = PAST_FORMER_TTL_DELAY_MS + LIVE_TIMEOUT_MS;

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

function model(): Model<"openai-responses"> {
  return {
    id: LIVE_MODEL_ID,
    name: LIVE_MODEL_ID,
    api: "openai-responses",
    provider: "openai",
    // No compat opt-in and no forward proxy: this is the plain native
    // api.openai.com connection every real OpenClaw user gets by default --
    // the exact path the idle-TTL default and cache-bound code changed.
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
    // buildOpenAIResponsesParams resolves the shared payload policy with
    // storeMode:"disable" -- store:true (and therefore HTTP continuation
    // eligibility) only ever comes from a caller-supplied onPayload, the
    // same hook the real per-session/model continuation decision threads
    // through above this package. Forcing it here isn't a test-only
    // shortcut; it's the one real way any caller (test or production) gets
    // store:true on this branch.
    onPayload: (payload: Record<string, unknown>) => ({ ...payload, store: true }),
  } as never);
  return stream.result();
}

/** Runs the shared secret-recall two-turn proof, waiting `gapMs` of real
 * wall-clock time between the turns. A correct answer on turn 2 is only
 * possible if the real API resolved server-side state through
 * previous_response_id, not because the model got lucky on a self-contained
 * prompt -- and a captured trimmed input with no second copy of the secret
 * confirms the request genuinely omitted the full history, not just some
 * other, less telling field. */
async function runSecretRecallProof(
  sessionId: string,
  secretCode: string,
  gapMs: number,
): Promise<{ requests: Array<Record<string, unknown>> }> {
  const capture = new GlobalFetchRequestCapture();
  capture.install();
  try {
    const firstUser = userMessage(
      `This is an automated test. Remember this secret code: ${secretCode}. ` +
        "Do not reply with the code yet -- just reply with exactly: ack",
      1,
    );
    const first = await run({ messages: [firstUser], tools: [] }, sessionId);
    expect(first.stopReason).toBe("stop");

    if (gapMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, gapMs);
      });
    }

    const second = await run(
      {
        messages: [
          firstUser,
          first,
          userMessage("What was the secret code I gave you? Reply with exactly that code.", 2),
        ],
        tools: [],
      },
      sessionId,
    );
    expect(second.stopReason).toBe("stop");
    const secondText = second.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    expect(secondText).toContain(secretCode);

    // Exactly two requests reached the real API -- a rejected
    // previous_response_id (the recovery path is a silent full-history
    // resend) would show up as a third.
    expect(capture.requests).toHaveLength(2);
    expect(capture.requests[0]).not.toHaveProperty("previous_response_id");
    expect(capture.requests[1]).toHaveProperty("previous_response_id");
    expect(typeof capture.requests[1]?.previous_response_id).toBe("string");
    expect(
      (capture.requests[1]?.previous_response_id as string | undefined)?.length,
    ).toBeGreaterThan(0);
    expect(capture.requests[1]?.input).toEqual([
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
    expect(JSON.stringify(capture.requests[1])).not.toContain(secretCode);
    return { requests: capture.requests };
  } finally {
    capture.restore();
  }
}

describeLive(
  "HTTP continuation default TTL and capacity/byte-budget cache (real native api.openai.com)",
  () => {
    afterEach(() => {
      cleanupSessionResources();
    });

    it(
      "still reuses previous_response_id and trims input on turn 2 with the new cache code in place",
      async () => {
        await runSecretRecallProof("live-continuation-cache-default", "GRANITE-COMET-4471", 0);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "survives a real gap past the former 5-minute idle TTL, proving the new 90-minute default actually matters",
      async () => {
        await runSecretRecallProof(
          "live-continuation-cache-past-former-ttl",
          "OBSIDIAN-FALCON-8823",
          PAST_FORMER_TTL_DELAY_MS,
        );
      },
      DELAYED_TIMEOUT_MS,
    );
  },
);
