import { describe, expect, it } from "vitest";
import {
  getSlackQaNativeTaskUpdateCursor,
  readSlackQaNativeTaskUpdates,
} from "./slack-live.capture.js";

function buildTaskRequest(params: {
  flowId: string;
  method?: string;
  title: string;
}): Record<string, unknown> {
  return {
    dataText: new URLSearchParams({
      chunks: JSON.stringify([
        { type: "plan_update", title: "Working" },
        {
          id: `${params.flowId}_task`,
          status: "in_progress",
          title: params.title,
          type: "task_update",
        },
      ]),
    }).toString(),
    flowId: params.flowId,
    kind: "request",
    method: "POST",
    path: `/api/${params.method ?? "chat.startStream"}`,
  };
}

function buildResponse(flowId: string, ok: boolean): Record<string, unknown> {
  return {
    dataText: JSON.stringify({ ok }),
    flowId,
    kind: "response",
    status: 200,
  };
}

describe("Slack QA debug capture", () => {
  it("reads task updates only from successful Slack stream calls", async () => {
    const events = [
      buildResponse("accepted", true),
      { id: 3, ...buildTaskRequest({ flowId: "accepted", title: "COMMENTARY" }) },
      buildResponse("rejected", false),
      { id: 2, ...buildTaskRequest({ flowId: "rejected", title: "REJECTED" }) },
      buildResponse("non-stream", true),
      {
        id: 1,
        ...buildTaskRequest({ flowId: "non-stream", method: "auth.test", title: "IGNORED" }),
      },
    ];
    const store = {
      getSessionEvents: () => events,
      readBlob: () => null,
    };

    await expect(
      readSlackQaNativeTaskUpdates({
        afterRequestEventId: 0,
        sessionId: "qa-slack",
        store,
      }),
    ).resolves.toEqual([
      {
        id: "accepted_task",
        method: "chat.startStream",
        status: "in_progress",
        title: "COMMENTARY",
      },
    ]);
  });

  it("reads captured request and response blobs when previews are unavailable", async () => {
    const request = buildTaskRequest({ flowId: "blob", title: "BLOB-COMMENTARY" });
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
      readSlackQaNativeTaskUpdates({
        afterRequestEventId: 0,
        sessionId: "qa-slack",
        store,
      }),
    ).resolves.toEqual([expect.objectContaining({ title: "BLOB-COMMENTARY" })]);
  });

  it("uses request ids as cursors and waits for late response capture", async () => {
    const oldRequest = { id: 4, ...buildTaskRequest({ flowId: "old", title: "OLD" }) };
    const nextRequest = { id: 5, ...buildTaskRequest({ flowId: "next", title: "NEXT" }) };
    let reads = 0;
    const store = {
      getSessionEvents: () => {
        reads += 1;
        return reads < 3 ? [nextRequest, oldRequest] : [buildResponse("next", true), nextRequest];
      },
      readBlob: () => null,
    };

    expect(getSlackQaNativeTaskUpdateCursor({ sessionId: "qa-slack", store })).toBe(5);
    await expect(
      readSlackQaNativeTaskUpdates({
        afterRequestEventId: 4,
        sessionId: "qa-slack",
        store,
      }),
    ).resolves.toEqual([expect.objectContaining({ title: "NEXT" })]);
  });
});
