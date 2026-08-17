import { describe, expect, it } from "vitest";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { boundInFlightRunSnapshotForChatHistory } from "./chat-abort.js";

describe("boundInFlightRunSnapshotForChatHistory phase priority", () => {
  it("keeps recorded progress ahead of a startup phase under a tight byte cap", () => {
    const event = {
      runId: "run-1",
      seq: 2,
      stream: "tool" as const,
      ts: 1_000,
      data: { phase: "start", name: "read", toolCallId: "tool-1", args: {} },
    };
    const expected = {
      runId: "run-1",
      text: "",
      events: [event],
    };
    const messages: unknown[] = [];
    const maxBytes = jsonUtf8Bytes(messages) + jsonUtf8Bytes(expected);

    const result = boundInFlightRunSnapshotForChatHistory({
      snapshot: {
        runId: "run-1",
        text: "x".repeat(1_000),
        phase: "waiting_for_response",
        events: [event],
      },
      messages,
      maxBytes,
    });

    expect(result).toEqual(expected);
    expect(result).not.toHaveProperty("phase");
    expect(jsonUtf8Bytes(messages) + jsonUtf8Bytes(result)).toBeLessThanOrEqual(maxBytes);
  });
});
