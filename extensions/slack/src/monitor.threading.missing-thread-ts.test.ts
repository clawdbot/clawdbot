import { describe, expect, it, vi } from "vitest";
import { createSlackThreadTsResolver } from "./monitor/thread-resolution.js";
import type { SlackMessageEvent } from "./types.js";

function makeThreadReplyMessage(): SlackMessageEvent {
  return {
    type: "message",
    user: "U1",
    text: "hello",
    ts: "456",
    parent_user_id: "U2",
    channel: "C1",
    channel_type: "channel",
  };
}

async function runMissingThreadScenario(params: {
  historyResponse?: { messages: Array<{ ts?: string; thread_ts?: string }> };
  historyError?: Error;
}) {
  const history = vi.fn();
  if (params.historyError) {
    history.mockRejectedValueOnce(params.historyError);
  } else {
    history.mockResolvedValueOnce(params.historyResponse ?? { messages: [{ ts: "456" }] });
  }

  const resolver = createSlackThreadTsResolver({
    client: { conversations: { history } } as never,
    cacheTtlMs: 60_000,
    maxSize: 5,
  });

  return await resolver.resolve({
    message: makeThreadReplyMessage(),
    source: "message",
  });
}

describe("Slack missing thread_ts recovery", () => {
  it("recovers missing thread_ts when parent_user_id is present", async () => {
    const message = await runMissingThreadScenario({
      historyResponse: { messages: [{ ts: "456", thread_ts: "111.222" }] },
    });
    expect(message).toMatchObject({ thread_ts: "111.222" });
  });

  it("continues without thread_ts when history lookup returns no thread result", async () => {
    const message = await runMissingThreadScenario({
      historyResponse: { messages: [{ ts: "456" }] },
    });
    expect(message.thread_ts).toBeUndefined();
  });

  it("continues without thread_ts when history lookup throws", async () => {
    const message = await runMissingThreadScenario({
      historyError: new Error("history failed"),
    });
    expect(message.thread_ts).toBeUndefined();
  });
});
