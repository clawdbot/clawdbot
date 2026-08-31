import type { Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  normalizeResponsesFailedEvent,
  ResponsesStreamFailure,
  summarizeResponsesPayload,
} from "./openai-responses-debug.js";

const failedEventModel = {
  provider: "openai",
  api: "openai-responses",
  id: "gpt-5.6-luna",
} as unknown as Model;

describe("OpenAI Responses payload debug summary", () => {
  it("reports compaction replay identities without exposing opaque content", () => {
    const summary = summarizeResponsesPayload({
      model: "gpt-5.6-sol",
      input: [
        { type: "message", role: "user", content: "hello" },
        {
          type: "compaction",
          id: "cmp-private-id",
          encrypted_content: "opaque-private-ciphertext",
        },
      ],
      context_management: [{ type: "compaction", compact_threshold: 700_000 }],
      service_tier: "priority",
      stream: true,
      store: true,
    });

    expect(summary).toContain("compactionItems=1");
    expect(summary).toContain("compactionInputIndexes=1");
    expect(summary).toContain("inputItems=2");
    expect(summary).toContain("inputItemShape=message:user,compaction");
    expect(summary).toMatch(/compactionIdHashes=[a-f0-9]{64}/u);
    expect(summary).toMatch(/compactionPayloadHashes=[a-f0-9]{64}/u);
    expect(summary).not.toContain("cmp-private-id");
    expect(summary).not.toContain("opaque-private-ciphertext");
  });

  it("reports an empty replay set for non-array input", () => {
    expect(summarizeResponsesPayload({ input: "hello" })).toContain(
      "compactionItems=0 compactionIdHashes=none compactionPayloadHashes=none compactionInputIndexes=none",
    );
  });
});

describe("normalizeResponsesFailedEvent", () => {
  it("preserves the structured provider error code on the failure and ResponsesStreamFailure (#117609)", () => {
    const summary = normalizeResponsesFailedEvent(
      {
        response: {
          id: "resp_failed",
          status: "failed",
          error: { code: "server_error", message: "provider failed" },
        },
      },
      failedEventModel,
    );
    // The prose message still embeds the code, but the structured code is now
    // preserved so downstream failover classification routes on it instead of
    // guessing from the prose.
    expect(summary.code).toBe("server_error");
    expect(summary.message).toBe("server_error: provider failed");
    expect(summary.responseId).toBe("resp_failed");

    const failure = new ResponsesStreamFailure(summary, undefined);
    expect(failure.code).toBe("server_error");
    expect(failure.message).toBe("server_error: provider failed");
    expect(failure.responseId).toBe("resp_failed");
  });

  it("omits code when the failed response has no error code", () => {
    const summary = normalizeResponsesFailedEvent(
      {
        response: {
          id: "resp_failed",
          status: "failed",
          error: { message: "provider failed" },
        },
      },
      failedEventModel,
    );
    expect(summary.code).toBeUndefined();
    expect(summary.message).toBe("unknown: provider failed");
  });
});
