// Github Copilot tests cover connection bound ids plugin behavior.
import { describe, expect, it } from "vitest";
import { sanitizeCopilotReplayResponsePayload } from "./connection-bound-ids.js";

function rewriteInputIds(input: unknown): boolean {
  return sanitizeCopilotReplayResponsePayload({ input });
}

describe("github-copilot connection-bound response IDs", () => {
  it("rewrites opaque message response item IDs deterministically", () => {
    const originalId = Buffer.from(`message-${"x".repeat(24)}`).toString("base64");
    const first = [{ id: originalId, type: "message" }];
    const second = [{ id: originalId, type: "message" }];

    expect(rewriteInputIds(first)).toBe(true);
    expect(rewriteInputIds(second)).toBe(true);
    expect(first[0]?.id).toMatch(/^msg_[a-f0-9]{16}$/);
    expect(first[0]?.id).toBe(second[0]?.id);
  });

  it("uses response item type prefixes and preserves local IDs", () => {
    const functionCallId = Buffer.from(`function-call-${"y".repeat(20)}`).toString("base64");
    const messageId = Buffer.from(`message-${"z".repeat(24)}`).toString("base64");
    const input = [
      { id: "rs_existing", type: "reasoning", encrypted_content: "active" },
      { id: "msg_existing", type: "message" },
      { id: "fc_existing", type: "function_call" },
      { id: functionCallId, type: "function_call" },
      { id: messageId, type: "message" },
    ];

    expect(rewriteInputIds(input)).toBe(true);
    expect(input[0]?.id).toBe("rs_existing");
    expect(input[1]?.id).toBe("msg_existing");
    expect(input[2]?.id).toBe("fc_existing");
    expect(input[3]?.id).toMatch(/^fc_[a-f0-9]{16}$/);
    expect(input[4]?.id).toMatch(/^msg_[a-f0-9]{16}$/);
  });

  it("preserves complete active reasoning and omits connection-bound IDs", () => {
    const connectionBoundId = Buffer.from(`reasoning-${"e".repeat(24)}`).toString("base64");
    const input = [
      { id: "rs_active", type: "reasoning", encrypted_content: "native", summary: [] },
      { type: "reasoning", status: "completed", encrypted_content: "idless" },
      { id: connectionBoundId, type: "reasoning", status: null, encrypted_content: "connection" },
    ];

    expect(rewriteInputIds(input)).toBe(true);
    expect(input).toEqual([
      { id: "rs_active", type: "reasoning", encrypted_content: "native", summary: [] },
      { type: "reasoning", status: "completed", encrypted_content: "idless" },
      { type: "reasoning", encrypted_content: "connection" },
    ]);
    expect(rewriteInputIds(input)).toBe(false);
  });

  it("drops adjacent incomplete or foreign reasoning and only clears dependent assistant IDs", () => {
    const invalidReasoning = [
      { id: "thinking_0", type: "reasoning", encrypted_content: "foreign" },
      { id: `rs_${"r".repeat(64)}`, type: "reasoning", encrypted_content: "oversized" },
      { id: "rs_missing", type: "reasoning" },
      { id: "rs_empty", type: "reasoning", encrypted_content: "" },
      { id: "rs_i", type: "reasoning", status: "incomplete", encrypted_content: "partial" },
      { id: 123, type: "reasoning", encrypted_content: "malformed" },
    ];
    const input: Array<Record<string, unknown>> = [
      ...invalidReasoning,
      { id: "msg_signed", type: "message", role: "assistant" },
      { id: "msg_user", type: "message", role: "user" },
    ];

    expect(rewriteInputIds(input)).toBe(true);
    expect(input).toEqual([
      { type: "message", role: "assistant" },
      { id: "msg_user", type: "message", role: "user" },
    ]);
  });

  it("patches response payload input arrays only", () => {
    const messageId = Buffer.from(`message-${"m".repeat(24)}`).toString("base64");
    const payload = { input: [{ id: messageId, type: "message" }] };

    expect(sanitizeCopilotReplayResponsePayload(payload)).toBe(true);
    expect(payload.input[0]?.id).toMatch(/^msg_[a-f0-9]{16}$/);
    expect(sanitizeCopilotReplayResponsePayload(undefined)).toBe(false);
    expect(sanitizeCopilotReplayResponsePayload({ input: "text" })).toBe(false);
  });
});
