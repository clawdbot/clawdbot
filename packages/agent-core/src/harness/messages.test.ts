// Agent Core tests cover messages behavior.
import { describe, expect, it } from "vitest";
import { convertToLlm, createCustomMessage } from "./messages.js";

describe("harness message timestamps", () => {
  it("rejects invalid timestamps before creating context messages", () => {
    expect(() => createCustomMessage("note", "content", true, {}, "not-a-date")).toThrow(
      "custom message timestamp must be a valid timestamp",
    );
  });
  it("normalizes persisted compaction summary timestamp strings", () => {
    const timestamp = "2026-05-30T17:00:00.000Z";
    const persistedMessages: Parameters<typeof convertToLlm>[0] = [
      {
        role: "compactionSummary",
        summary: "older context",
        tokensBefore: 123,
        timestamp,
      },
    ];

    const [message] = convertToLlm(persistedMessages);

    expect(message?.timestamp).toBe(Date.parse(timestamp));
  });

  it("keeps corrupt persisted compaction timestamps non-fatal", () => {
    const persistedMessages: Parameters<typeof convertToLlm>[0] = [
      {
        role: "compactionSummary",
        summary: "older context",
        tokensBefore: 123,
        timestamp: "not a timestamp",
      },
    ];

    const [message] = convertToLlm(persistedMessages);

    expect(message?.timestamp).toBe(0);
  });
});

describe("convertToLlm runtime-context carrier marking", () => {
  const timestamp = "2026-05-30T17:00:00.000Z";

  it("marks a runtime-context carrier custom message so providers skip cache anchoring", () => {
    const [message] = convertToLlm([
      createCustomMessage(
        "openclaw.runtime-context",
        "current-turn metadata",
        false,
        { source: "openclaw-runtime-context", runtimeContextCarrier: true },
        timestamp,
      ),
    ]);

    expect(message?.role).toBe("user");
    expect((message as { runtimeContextCarrier?: boolean }).runtimeContextCarrier).toBe(true);
  });

  it("does not mark ordinary custom messages", () => {
    const [message] = convertToLlm([
      createCustomMessage("note", "some note", false, { source: "other" }, timestamp),
    ]);

    expect(message?.role).toBe("user");
    expect((message as { runtimeContextCarrier?: boolean }).runtimeContextCarrier).toBeUndefined();
  });
});
