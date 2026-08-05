import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../transports/transport-utils.js";
import type { Context, Model } from "../types.js";
import { streamAnthropic } from "./anthropic.js";

// Stands in for the payload class this path exposes: text the model emitted, which
// reaches the SSE frame as ordinary assistant content.
const SENTINEL = "MODEL_EMITTED_SENTINEL_a1b2c3";

// A truncated frame. repairJson only escapes control characters inside string
// literals, so an unterminated object still reaches JSON.parse as a SyntaxError.
const MALFORMED_FRAME = `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${SENTINEL}"`;

const WELL_FORMED_FRAMES = [
  [
    "message_start",
    '{"type":"message_start","message":{"id":"msg_control","type":"message","role":"assistant",' +
      '"model":"claude-sonnet-4-6","content":[],"stop_reason":null,"stop_sequence":null,' +
      '"usage":{"input_tokens":3,"output_tokens":1}}}',
  ],
  [
    "content_block_start",
    '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  ],
  [
    "content_block_delta",
    '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  ],
  ["content_block_stop", '{"type":"content_block_stop","index":0}'],
  [
    "message_delta",
    '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},' +
      '"usage":{"output_tokens":1}}',
  ],
  ["message_stop", '{"type":"message_stop"}'],
] as const;

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;

function makeModel(baseUrl: string): Model<"anthropic-messages"> {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_096,
  } satisfies Model<"anthropic-messages">;
}

// Real loopback socket speaking Anthropic's event stream. Only the far end of the
// socket is ours; the SDK, its SSE reader, and the provider stream are production code.
async function streamAnthropicSseFrames(
  frames: readonly (readonly [string, string])[],
): Promise<{ stopReason: string; errorMessage?: string }> {
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    for (const [event, data] of frames) {
      response.write(`event: ${event}\ndata: ${data}\n\n`);
    }
    response.end();
    void request.resume();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  try {
    const result = await streamAnthropic(makeModel(`http://127.0.0.1:${address.port}`), context, {
      apiKey: "test-api-key",
      maxRetries: 0,
    }).result();
    return { stopReason: result.stopReason, errorMessage: result.errorMessage };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("Anthropic malformed SSE frames", () => {
  it("reports the shared malformed-fragment error without echoing the frame payload", async () => {
    const result = await streamAnthropicSseFrames([["content_block_delta", MALFORMED_FRAME]]);

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE);
    expect(result.errorMessage).not.toContain(SENTINEL);
  });

  it("still completes a well-formed stream", async () => {
    const result = await streamAnthropicSseFrames(WELL_FORMED_FRAMES);

    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
  });
});
