import { describe, expect, it } from "vitest";
import { getSlackQaMessageWriteCursor, readSlackQaMessageWrites } from "./slack-live.capture.js";

function buildMessageRequest(params: {
  channel?: string;
  flowId: string;
  method?: string;
  text: string;
  threadTs?: string;
  ts?: string;
}): Record<string, unknown> {
  return {
    dataText: new URLSearchParams({
      channel: params.channel ?? "C123",
      text: params.text,
      ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
      ...(params.ts ? { ts: params.ts } : {}),
    }).toString(),
    flowId: params.flowId,
    host: "slack.com",
    kind: "request",
    method: "POST",
    path: `/api/${params.method ?? "chat.postMessage"}`,
  };
}

function buildResponse(
  flowId: string,
  ok: boolean,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    dataText: JSON.stringify({ channel: "C123", ok, ts: "2.000000", ...overrides }),
    flowId,
    kind: "response",
    status: 200,
  };
}

describe("Slack QA debug capture", () => {
  it("preserves only successful Slack post and update snapshots", async () => {
    const postRequest = buildMessageRequest({
      flowId: "post",
      text: "fallback",
      threadTs: "1.000000",
    });
    postRequest.dataText = new URLSearchParams({
      channel: "C123",
      text: "fallback",
      blocks: JSON.stringify([
        { type: "header", text: { type: "plain_text", text: "Update" } },
        { type: "section", text: { type: "mrkdwn", text: "COMMENTARY" } },
      ]),
      thread_ts: "1.000000",
    }).toString();
    const events = [
      buildResponse("update", true),
      {
        id: 4,
        ...buildMessageRequest({
          flowId: "update",
          method: "chat.update",
          text: "receipt",
          ts: "2.000000",
        }),
      },
      buildResponse("post", true),
      { id: 3, ...postRequest },
      buildResponse("rejected", false),
      { id: 2, ...buildMessageRequest({ flowId: "rejected", text: "REJECTED" }) },
      buildResponse("non-write", true),
      {
        id: 1,
        ...buildMessageRequest({ flowId: "non-write", method: "auth.test", text: "IGNORED" }),
      },
    ];
    const store = {
      getSessionEvents: () => events,
      readBlob: () => null,
    };

    await expect(
      readSlackQaMessageWrites({
        afterRequestEventId: 0,
        sessionId: "qa-slack",
        store,
      }),
    ).resolves.toEqual([
      {
        blockText: ["Update", "COMMENTARY"],
        channelId: "C123",
        text: "fallback",
        threadTs: "1.000000",
        ts: "2.000000",
      },
      { channelId: "C123", text: "receipt", ts: "2.000000" },
    ]);
  });

  it("reads captured request and response blobs when previews are unavailable", async () => {
    const request = buildMessageRequest({ flowId: "blob", text: "BLOB-COMMENTARY" });
    const response = buildResponse("blob", true);
    const blobs = new Map([
      ["request", String(request.dataText)],
      ["response", String(response.dataText)],
    ]);
    delete request.dataText;
    delete response.dataText;
    request.id = 1;
    request.dataBlobId = "request";
    response.dataBlobId = "response";
    const store = {
      getSessionEvents: () => [response, request],
      readBlob: (blobId: string) => blobs.get(blobId) ?? null,
    };

    await expect(
      readSlackQaMessageWrites({
        afterRequestEventId: 0,
        sessionId: "qa-slack",
        store,
      }),
    ).resolves.toEqual([expect.objectContaining({ text: "BLOB-COMMENTARY" })]);
  });

  it("uses request ids as cursors and waits for late response capture", async () => {
    const oldRequest = { id: 4, ...buildMessageRequest({ flowId: "old", text: "OLD" }) };
    const nextRequest = { id: 5, ...buildMessageRequest({ flowId: "next", text: "NEXT" }) };
    let reads = 0;
    const store = {
      getSessionEvents: () => {
        reads += 1;
        return reads < 3 ? [nextRequest, oldRequest] : [buildResponse("next", true), nextRequest];
      },
      readBlob: () => null,
    };

    expect(getSlackQaMessageWriteCursor({ sessionId: "qa-slack", store })).toBe(5);
    await expect(
      readSlackQaMessageWrites({
        afterRequestEventId: 4,
        sessionId: "qa-slack",
        store,
      }),
    ).resolves.toEqual([expect.objectContaining({ text: "NEXT" })]);
  });
});
