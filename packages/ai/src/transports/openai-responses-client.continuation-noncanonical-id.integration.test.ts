import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import { normalizeOpenAIResponsesFunctionCallId } from "./openai-responses-tool-call-id-shape.js";

// Real loopback HTTP + SSE server, same harness as
// openai-responses-client.continuation.integration.test.ts, but this time the
// scripted backend returns a genuinely NON-canonical function_call.call_id/id
// pair -- like a real moonshotai/kimi-k2.5-via-openrouter connection would
// (see the "functions.gateway:0|fc_tmp_..." fixture in
// src/agents/embedded-agent-helpers/openai.test.ts). This is the only shape
// that can exercise this PR's raw-ID canonicalization/restoration branch at
// all: a real native api.openai.com connection always generates already-
// canonical call_*/fc_* ids itself, so canonicalizeCachedCallId's reshaping
// is a permanent no-op there (see the sibling unsafe-integer live test's own
// note on this). Only a compat/proxy backend with its own non-canonical ID
// scheme makes the reshape-then-restore path do real work.
//
// normalizeOpenAIResponsesFunctionCallId is called directly here (not the
// AgentMessage-walking normalizeOpenAIResponsesToolCallIds wrapper, which
// lives in src/agents and can't be imported into packages/ai) to reproduce
// exactly what that wrapper does to a single id: pair call_id|item_id, then
// reshape. Production always runs this before the transport ever sees the
// replayed message, mutating the stored tool-call id in place -- this test
// does the same mutation by hand to stay real without crossing the
// packages/ai -> src/agents import boundary.
//
// Skipped on this branch: httpContinuationEligible here only recognizes a
// genuine native api.openai.com connection (supportsNativeOpenAIResponsesEndpoint),
// so the customEndpointModel below never actually gets a continuation claim
// on origin/main today. The eligibility widening for compat/proxy endpoints
// is PR #128633 (compat.supportsResponsesContinuation), not part of this PR.
// Confirmed this test genuinely passes (not just theoretically) once stacked
// on #128633's branch: copied this file plus this PR's own production
// changes onto that branch's checkout, un-skipped, and ran it there --
// green. Un-skip for real once this branch lands on top of #128633 (or after
// it merges to main).
class ScriptedResponsesServer {
  readonly requests: Array<Record<string, unknown>> = [];
  private readonly script: Array<(request: Record<string, unknown>) => string>;
  private server: Server | undefined;

  constructor(script: Array<(request: Record<string, unknown>) => string>) {
    this.script = script;
  }

  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const index = this.requests.length;
        this.requests.push(parsed);
        const frame = this.script[index];
        if (!frame) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ error: { message: `no scripted response for request ${index}` } }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`data: ${frame(parsed)}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server?.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/v1`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL = Symbol.for(
  "openclaw.modelProviderRequestTransport",
);

function attachModelProviderRequestTransport<TModel extends object>(
  model: TModel,
  request: { allowPrivateNetwork?: boolean },
): TModel {
  return {
    ...model,
    [MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL]: request,
  };
}

// Matches the real fixture in openai.test.ts ("assigns distinct call ids to
// repeated native Kimi calls across turns"): a raw, non-canonical call_id
// (contains "." and ":", which call_*'s [A-Za-z0-9_-] shape rejects) paired
// with an already-fc_*-shaped item id.
const RAW_CALL_ID = "functions.gateway:0";
const RAW_ITEM_ID = "fc_tmp_kegospxl46";

function toolCallCompletedFrame(responseId: string): string {
  return JSON.stringify({
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: [
        {
          id: RAW_ITEM_ID,
          call_id: RAW_CALL_ID,
          type: "function_call",
          status: "completed",
          name: "gateway",
          arguments: "{}",
        },
      ],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  });
}

function textCompletedFrame(responseId: string, content: string): string {
  return JSON.stringify({
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: [
        {
          id: `msg_${responseId}`,
          type: "message",
          status: "completed",
          content: [{ type: "output_text", text: content, annotations: [] }],
          role: "assistant",
        },
      ],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  });
}

function userMessage(text: string, timestamp: number) {
  return { role: "user" as const, content: text, timestamp };
}

function customEndpointModel(baseUrl: string): Model<"openai-responses"> {
  const model = {
    id: "scripted-model",
    name: "Scripted Model",
    api: "openai-responses",
    provider: "omniroute",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    // compat.supportsResponsesContinuation doesn't exist in
    // OpenAIResponsesCompat on this branch yet -- it's #128633's own type,
    // not landed here. This whole test is describe.skip'd until this
    // branch stacks on #128633; the cast keeps that dependency's shape
    // without pulling its type in early.
    compat: { supportsResponsesContinuation: true } as Model<"openai-responses">["compat"],
  } satisfies Model<"openai-responses">;
  return attachModelProviderRequestTransport(model, { allowPrivateNetwork: true });
}

async function run(
  model: Model<"openai-responses">,
  context: Context,
  sessionId: string,
): Promise<AssistantMessage> {
  const stream = await createOpenAIResponsesTransportStreamFn()(model, context, {
    apiKey: "test-key",
    sessionId,
    transport: "sse",
    reasoningEffort: "low",
    onPayload: (payload: Record<string, unknown>) => ({ ...payload, store: true }),
  } as never);
  return stream.result();
}

describe.skip("HTTP continuation across a non-canonical replayed tool-call id (loopback server, no SDK mocking)", () => {
  afterEach(() => {
    cleanupSessionResources();
  });

  it("reshapes, matches, and restores a raw non-canonical call_id/id pair on continuation", async () => {
    const server = new ScriptedResponsesServer([
      () => toolCallCompletedFrame("resp_1"),
      () => textCompletedFrame("resp_2", "recorded"),
    ]);
    const baseUrl = await server.listen();
    try {
      const model = customEndpointModel(baseUrl);
      const sessionId = "real-sse-noncanonical-id";
      const firstUser = userMessage("call the gateway tool", 1);
      const callTurn = await run(model, { messages: [firstUser], tools: [] }, sessionId);

      const toolCall = callTurn.content.find((block) => block.type === "toolCall") as
        | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
        | undefined;
      if (!toolCall) {
        throw new Error("Expected a completed tool call");
      }
      // resolveResponsesToolCallId pairs the wire call_id/id verbatim,
      // unreshaped -- confirms the scripted server's raw ids really did
      // round-trip into OpenClaw's own internal representation unchanged.
      expect(toolCall.id).toBe(`${RAW_CALL_ID}|${RAW_ITEM_ID}`);

      // Production mutates the stored tool-call id to this same reshaped
      // form before ever replaying it (normalizeOpenAIResponsesToolCallIds,
      // src/agents/embedded-agent-helpers/openai.ts) -- reproduced by hand
      // here since packages/ai can't import that wrapper.
      const reshapedId = normalizeOpenAIResponsesFunctionCallId(toolCall.id);
      expect(reshapedId).not.toBe(toolCall.id);
      expect(reshapedId.endsWith(`|${RAW_ITEM_ID}`)).toBe(true);
      const reshapedToolCall = { ...callTurn, content: [{ ...toolCall, id: reshapedId }] };

      const toolResultMsg = {
        role: "toolResult" as const,
        toolCallId: reshapedId,
        toolName: "gateway",
        isError: false,
        content: [{ type: "text" as const, text: "recorded" }],
        timestamp: 2,
      };
      const round1Messages: Context["messages"] = [firstUser, reshapedToolCall, toolResultMsg];
      const afterToolResult = await run(model, { messages: round1Messages, tools: [] }, sessionId);
      expect(afterToolResult.stopReason).toBe("stop");

      // Exactly two requests reached the server: a fallback to full-history
      // resend (history_changed, the bug this PR fixes) would show up as a
      // third request with no previous_response_id.
      expect(server.requests).toHaveLength(2);
      const secondRequest = server.requests[1];
      expect(secondRequest).toHaveProperty("previous_response_id", "resp_1");
      // The wire delta must carry the RAW id the scripted backend actually
      // returned (RAW_CALL_ID), not the reshaped one and not the paired
      // internal id -- restoreRawCallIdsInDelta's whole job.
      expect(secondRequest?.input).toEqual([
        {
          type: "function_call_output",
          call_id: RAW_CALL_ID,
          output: "recorded",
        },
      ]);
    } finally {
      await server.close();
    }
  });
});
