import { describe, expect, it } from "vitest";

import { extractTextFromMessage } from "./tui-formatters.js";

describe("extractTextFromMessage", () => {
  it("renders errorMessage when assistant content is empty", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage:
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\\u0027s rate limit. Please try again later."},"request_id":"req_123"}',
    });

    expect(text).toContain("HTTP 429");
    expect(text).toContain("rate_limit_error");
    expect(text).toContain("req_123");
  });

  it("falls back to a generic message when errorMessage is missing", () => {
    const text = extractTextFromMessage({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "",
    });

    expect(text).toContain("unknown error");
  });
});
