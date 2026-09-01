import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../transports/transport-utils.js";
import type { Context, Model } from "../types.js";
import { streamOpenAICodexResponses } from "./openai-chatgpt-responses.js";

// Stands in for the payload class this path exposes: text that reached the SSE
// frame as ordinary stream content rather than as a provider error envelope.
const SENTINEL = "MODEL_EMITTED_SENTINEL_a1b2c3";

// V8 quotes the first ten characters of an unparseable document back in the
// SyntaxError message, so this prefix is what leaks when the raw parser text is
// forwarded instead of the shared marker.
const LEAKED_PREFIX = SENTINEL.slice(0, 10);

// A frame body that is not JSON from its first token. This is the malformed
// shape a proxy or gateway produces when it injects plain text into the event
// stream, and the only class whose SyntaxError message quotes frame content.
const MALFORMED_FRAME = `${SENTINEL} partial frame`;

const COMPLETED_FRAME = JSON.stringify({
  type: "response.completed",
  response: {
    id: "resp_control",
    status: "completed",
    output: [],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  },
});

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

function makeModel(baseUrl: string): Model<"openai-chatgpt-responses"> {
  return {
    id: "gpt-5.5",
    name: "GPT-5.5",
    api: "openai-chatgpt-responses",
    provider: "openai",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_000,
  } satisfies Model<"openai-chatgpt-responses">;
}

// Real loopback socket speaking the Codex event stream. Only the far end of the
// socket is ours; the SSE reader and the provider stream are production code.
async function streamCodexSseFrames(
  frames: readonly string[],
): Promise<{ stopReason: string; errorMessage?: string }> {
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    for (const data of frames) {
      response.write(`data: ${data}\n\n`);
    }
    response.end();
    void request.resume();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  try {
    const result = await streamOpenAICodexResponses(
      makeModel(`http://127.0.0.1:${address.port}`),
      context,
      {
        apiKey: createJwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-sse-parse" },
        }),
        transport: "sse",
      },
    ).result();
    return { stopReason: result.stopReason, errorMessage: result.errorMessage };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("Codex malformed SSE frames", () => {
  it("reports the shared malformed-fragment error without echoing parser text", async () => {
    const result = await streamCodexSseFrames([MALFORMED_FRAME]);

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE);
    expect(result.errorMessage).not.toContain(LEAKED_PREFIX);
  });

  it("still completes a well-formed stream", async () => {
    const result = await streamCodexSseFrames([COMPLETED_FRAME]);

    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
  });
});
