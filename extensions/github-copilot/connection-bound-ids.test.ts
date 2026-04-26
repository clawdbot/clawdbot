import { describe, expect, it } from "vitest";
import {
  rewriteCopilotConnectionBoundResponseIds,
  rewriteCopilotResponsePayloadConnectionBoundIds,
} from "./connection-bound-ids.js";

describe("github-copilot connection-bound response IDs", () => {
  it("rewrites opaque message response item IDs deterministically", () => {
    const originalId = Buffer.from(`message-${"x".repeat(24)}`).toString("base64");
    const first = [{ id: originalId, type: "message" }];
    const second = [{ id: originalId, type: "message" }];

    expect(rewriteCopilotConnectionBoundResponseIds(first)).toBe(true);
    expect(rewriteCopilotConnectionBoundResponseIds(second)).toBe(true);
    expect(first[0]?.id).toMatch(/^msg_[a-f0-9]{16}$/);
    expect(first[0]?.id).toBe(second[0]?.id);
  });

  it("uses response item type prefixes and preserves local IDs", () => {
    const functionCallId = Buffer.from(`function-call-${"y".repeat(20)}`).toString("base64");
    const messageId = Buffer.from(`message-${"z".repeat(24)}`).toString("base64");
    const input = [
      { id: "rs_existing", type: "reasoning" },
      { id: "msg_existing", type: "message" },
      { id: "fc_existing", type: "function_call" },
      { id: functionCallId, type: "function_call" },
      { id: messageId, type: "message" },
    ];

    expect(rewriteCopilotConnectionBoundResponseIds(input)).toBe(true);
    expect(input[0]?.id).toBe("rs_existing");
    expect(input[1]?.id).toBe("msg_existing");
    expect(input[2]?.id).toBe("fc_existing");
    expect(input[3]?.id).toMatch(/^fc_[a-f0-9]{16}$/);
    expect(input[4]?.id).toMatch(/^msg_[a-f0-9]{16}$/);
  });

  it("preserves reasoning IDs regardless of encrypted_content", () => {
    const withEncrypted = Buffer.from(`reasoning-${"e".repeat(24)}`).toString("base64");
    const withNull = Buffer.from(`reasoning-${"n".repeat(24)}`).toString("base64");
    const withoutField = Buffer.from(`reasoning-${"a".repeat(24)}`).toString("base64");
    const input = [
      { id: withEncrypted, type: "reasoning", encrypted_content: "opaque-encrypted-payload" },
      { id: withNull, type: "reasoning", encrypted_content: null },
      { id: withoutField, type: "reasoning" },
    ];

    expect(rewriteCopilotConnectionBoundResponseIds(input)).toBe(false);
    expect(input[0]?.id).toBe(withEncrypted);
    expect(input[1]?.id).toBe(withNull);
    expect(input[2]?.id).toBe(withoutField);
  });

  it("patches response payload input arrays only", () => {
    const messageId = Buffer.from(`message-${"m".repeat(24)}`).toString("base64");
    const payload = { input: [{ id: messageId, type: "message" }] };

    expect(rewriteCopilotResponsePayloadConnectionBoundIds(payload)).toBe(true);
    expect(payload.input[0]?.id).toMatch(/^msg_[a-f0-9]{16}$/);
    expect(rewriteCopilotResponsePayloadConnectionBoundIds(undefined)).toBe(false);
    expect(rewriteCopilotResponsePayloadConnectionBoundIds({ input: "text" })).toBe(false);
  });
});
