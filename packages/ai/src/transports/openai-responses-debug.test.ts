import { describe, expect, it } from "vitest";
import { summarizeResponsesPayload } from "./openai-responses-debug.js";

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
