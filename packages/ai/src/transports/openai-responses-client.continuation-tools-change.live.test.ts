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
// provider accepts that combination instead of rejecting it. Four distinct
// shapes of "changed", since the provider could plausibly treat them
// differently: tool added, tool removed, an existing tool's schema mutated,
// and a tools change on the turn right after a completed tool-calling round
// (the shape closest to real dynamic tool-gating in production).
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

const readFile: Tool = {
  name: "read_file",
  description: "Read the contents of a file by path.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const webFetch: Tool = {
  name: "web_fetch",
  description: "Fetch the contents of a URL.",
  parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
};
// Same name as readFile, deliberately different schema -- proves a mutated
// tool definition (not just list membership) is also covered.
const readFileV2: Tool = {
  name: "read_file",
  description: "Read a UTF-8 text file and return its contents plus byte length.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, encoding: { type: "string" } },
    required: ["path"],
  },
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

/**
 * Runs the shared secret-recall proof: turn 1 states a secret under
 * `turn1Tools`, turn 2 asks for it back under `turn2Tools`. A structurally
 * correct `previous_response_id` is not proof the server actually used the
 * omitted history -- the model could get lucky on a self-contained prompt --
 * so only a correct recall of a fact stated solely in the omitted turn-1
 * history, from a trimmed turn-2 request that never repeats it, proves real
 * server-side continuation.
 */
async function runSecretRecallToolsChangeScenario(params: {
  sessionId: string;
  turn1Tools: Tool[];
  turn2Tools: Tool[];
}): Promise<{ secondRequest: Record<string, unknown> }> {
  const capture = new GlobalFetchRequestCapture();
  capture.install();
  try {
    const secretCode = `SECRET-${params.sessionId.toUpperCase()}-9137`;
    const firstUser = userMessage(
      `This is an automated test. Remember this secret code: ${secretCode}. ` +
        "Do not reply with the code yet -- just reply with exactly: ack",
      1,
    );
    const first = await run({ messages: [firstUser], tools: params.turn1Tools }, params.sessionId);
    expect(first.stopReason).toBe("stop");

    const second = await run(
      {
        messages: [
          firstUser,
          first,
          userMessage("What was the secret code I gave you? Reply with exactly that code.", 2),
        ],
        tools: params.turn2Tools,
      },
      params.sessionId,
    );
    expect(second.stopReason).toBe("stop");
    const secondText = second.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    expect(secondText).toContain(secretCode);

    // Exactly two requests reached the real API -- a silent full-history
    // fallback (the recovery path for a rejected previous_response_id) would
    // show up as a third captured request here.
    expect(capture.requests).toHaveLength(2);
    expect(capture.requests[0]).not.toHaveProperty("previous_response_id");
    const secondRequest = capture.requests[1];
    expect(secondRequest).toHaveProperty("previous_response_id");
    expect(typeof secondRequest?.previous_response_id).toBe("string");
    expect((secondRequest?.previous_response_id as string).length).toBeGreaterThan(0);
    // Trimmed input -- only the new user message, not the full replayed
    // history -- confirms this was a real continuation, not the full-history
    // fallback succeeding to coincidentally produce the right answer.
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
    return { secondRequest };
  } finally {
    capture.restore();
  }
}

describeLive(
  "OpenAI Responses HTTP continuation across a tools-list change (real api.openai.com)",
  () => {
    afterEach(() => {
      cleanupSessionResources();
    });

    it(
      "tool added: accepts previous_response_id and carries the current (grown) tool list",
      async () => {
        const { secondRequest } = await runSecretRecallToolsChangeScenario({
          sessionId: "live-http-continuation-tools-added",
          turn1Tools: [readFile],
          turn2Tools: [readFile, webFetch],
        });
        expect(secondRequest?.tools).toHaveLength(2);
        expect((secondRequest?.tools as Array<{ name: string }>).map((t) => t.name).sort()).toEqual(
          ["read_file", "web_fetch"],
        );
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "tool removed: accepts previous_response_id and carries the current (shrunk) tool list",
      async () => {
        const { secondRequest } = await runSecretRecallToolsChangeScenario({
          sessionId: "live-http-continuation-tools-removed",
          turn1Tools: [readFile, webFetch],
          turn2Tools: [readFile],
        });
        expect(secondRequest?.tools).toHaveLength(1);
        expect((secondRequest?.tools as Array<{ name: string }>).map((t) => t.name)).toEqual([
          "read_file",
        ]);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "tool schema mutated: accepts previous_response_id with the same tool name but a changed definition",
      async () => {
        const { secondRequest } = await runSecretRecallToolsChangeScenario({
          sessionId: "live-http-continuation-tools-schema-changed",
          turn1Tools: [readFile],
          turn2Tools: [readFileV2],
        });
        const tools = secondRequest?.tools as Array<{
          name: string;
          description?: string;
          parameters?: unknown;
        }>;
        expect(tools).toHaveLength(1);
        expect(tools[0]?.name).toBe("read_file");
        expect(tools[0]?.description).toBe(readFileV2.description);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "tools change immediately after a completed tool-calling round: accepts previous_response_id on the next turn",
      async () => {
        // The shape closest to real production dynamic tool-gating: a tool
        // actually gets called (not just offered), then the turn right after
        // that round changes what's available -- proving the exclusion holds
        // across the request/response/reasoning-replay machinery a
        // tool-calling round exercises, not just a plain text round.
        const capture = new GlobalFetchRequestCapture();
        capture.install();
        try {
          const sessionId = "live-http-continuation-tools-after-tool-call";
          const secretCode = "SECRET-AFTER-TOOL-CALL-2286";
          const firstUser = userMessage(
            `This is an automated test. Remember this secret code: ${secretCode}. ` +
              "Then call read_file on path /tmp/x.txt.",
            1,
          );
          const callTurn = await run({ messages: [firstUser], tools: [readFile] }, sessionId);
          const toolCall = callTurn.content.find((block) => block.type === "toolCall");
          expect(toolCall).toBeDefined();
          const toolResultMsg = {
            role: "toolResult" as const,
            toolCallId: (toolCall as { id: string }).id,
            content: [{ type: "text" as const, text: "file contents: hello world" }],
            timestamp: 2,
          };
          const round1Messages: Context["messages"] = [firstUser, callTurn, toolResultMsg];
          const afterToolResult = await run(
            { messages: round1Messages, tools: [readFile] },
            sessionId,
          );
          expect(afterToolResult.stopReason).toBe("stop");

          // New turn, tools now include webFetch too -- the tool list changed
          // since the round that just completed.
          const round2 = await run(
            {
              messages: [
                ...round1Messages,
                afterToolResult,
                userMessage(
                  "What was the secret code I gave you? Reply with exactly that code.",
                  3,
                ),
              ],
              tools: [readFile, webFetch],
            },
            sessionId,
          );
          expect(round2.stopReason).toBe("stop");
          const round2Text = round2.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
          expect(round2Text).toContain(secretCode);

          // Three requests: force-tool-call turn, post-tool-result turn, and
          // the tools-changed turn. Only the last one is expected to carry
          // previous_response_id -- a silent full-history fallback there
          // would show up as a fourth captured request.
          expect(capture.requests).toHaveLength(3);
          const finalRequest = capture.requests[2];
          expect(finalRequest).toHaveProperty("previous_response_id");
          expect((finalRequest?.previous_response_id as string).length).toBeGreaterThan(0);
          expect(finalRequest?.tools).toHaveLength(2);
          expect(JSON.stringify(finalRequest)).not.toContain(secretCode);
        } finally {
          capture.restore();
        }
      },
      LIVE_TIMEOUT_MS,
    );
  },
);
