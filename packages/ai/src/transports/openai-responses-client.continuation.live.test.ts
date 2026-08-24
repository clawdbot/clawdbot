import { createServer } from "node:http";
import https from "node:https";
import type { AddressInfo, Server } from "node:net";
import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

// Matches the identically-named symbol in src/agents/provider-request-config.ts
// (and the sibling local copy in openai-completions.test-support.ts) via the
// global symbol registry, without a packages/ai -> src/agents import.
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

// Live coverage for HTTP continuation against the *real* OpenAI Responses API.
// A unit/mocked test can only prove openclaw's own selection logic; it cannot
// prove the real API actually accepts and honors previous_response_id the way
// openclaw assumes. This test puts a transparent, capturing forward-proxy
// between openclaw and api.openai.com so the real request that leaves the
// process for the real API can be inspected directly.
const LIVE = process.env.OPENCLAW_LIVE_TEST === "1";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const describeLive = LIVE && OPENAI_KEY ? describe : describe.skip;
const LIVE_MODEL_ID = process.env.OPENCLAW_LIVE_RESPONSES_MODEL || "gpt-5.6-luna";
const LIVE_TIMEOUT_MS = 120_000;

// Forwards every request byte-for-byte to https://api.openai.com while
// recording the parsed JSON body, so assertions run against exactly what the
// real API received -- not a stand-in for it.
class CapturingOpenAIForwardProxy {
  readonly requests: Array<Record<string, unknown>> = [];
  private server: Server | undefined;

  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        this.requests.push(JSON.parse(body) as Record<string, unknown>);
        const { host: _host, ...forwardHeaders } = req.headers;
        const upstream = https.request(
          {
            hostname: "api.openai.com",
            path: req.url,
            method: req.method,
            headers: { ...forwardHeaders, host: "api.openai.com" },
          },
          (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
          },
        );
        upstream.on("error", (error) => {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: String(error) } }));
        });
        upstream.end(body);
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

function userMessage(text: string, timestamp: number) {
  return { role: "user" as const, content: text, timestamp };
}

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

describeLive("OpenAI Responses HTTP continuation (real api.openai.com)", () => {
  afterEach(() => {
    cleanupSessionResources();
  });

  it(
    "sends previous_response_id and only the new message to the real API on turn 2",
    async () => {
      const proxy = new CapturingOpenAIForwardProxy();
      const baseUrl = await proxy.listen();
      try {
        const model: Model<"openai-responses"> = attachModelProviderRequestTransport(
          {
            id: LIVE_MODEL_ID,
            name: LIVE_MODEL_ID,
            api: "openai-responses",
            provider: "openai",
            baseUrl,
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 8192,
            // The forward proxy's baseUrl is a loopback address, not the
            // official api.openai.com host, so it carries no native trust
            // signal on its own -- this test exercises the same explicit
            // opt-in path a real OmniRoute deployment needs, just fronting
            // the real API instead of a scripted one.
            compat: { supportsResponsesContinuation: true },
          } satisfies Model<"openai-responses">,
          { allowPrivateNetwork: true },
        );
        const sessionId = "live-http-continuation";
        // A structurally correct wire request (previous_response_id set,
        // input trimmed) is not proof the server actually used the omitted
        // history -- the model could get lucky on a self-contained prompt.
        // Give it a secret only turn 1 ever states, then ask turn 2 to recall
        // it without repeating it anywhere in the trimmed input: a correct
        // answer is only possible if the real API resolved server-side state
        // through previous_response_id.
        const secretCode = "QUARTZ-NEBULA-7719";
        const firstUser = userMessage(
          `This is an automated test. Remember this secret code: ${secretCode}. ` +
            "Do not reply with the code yet -- just reply with exactly: ack",
          1,
        );
        const first = await run(model, { messages: [firstUser], tools: [] }, sessionId);
        expect(first.stopReason).toBe("stop");

        const second = await run(
          model,
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

        // Exactly two requests reached the real API -- a silent full-history
        // fallback (the recovery path for a rejected previous_response_id)
        // would show up as a third captured request here.
        expect(proxy.requests).toHaveLength(2);
        expect(proxy.requests[0]).not.toHaveProperty("previous_response_id");
        expect(proxy.requests[1]).toHaveProperty("previous_response_id");
        expect(typeof proxy.requests[1]?.previous_response_id).toBe("string");
        expect(
          (proxy.requests[1]?.previous_response_id as string | undefined)?.length,
        ).toBeGreaterThan(0);
        expect(proxy.requests[1]?.input).toEqual([
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
        // The secret never leaves the process a second time -- confirms the
        // trimmed request genuinely omitted it rather than merely omitting
        // some other, less telling field.
        expect(JSON.stringify(proxy.requests[1])).not.toContain(secretCode);
      } finally {
        await proxy.close();
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
