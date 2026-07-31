// @vitest-environment node
// Control UI tests cover message extract behavior.
import { describe, expect, it } from "vitest";
import {
  extractRawText,
  extractText,
  extractTextCached,
  extractThinkingCached,
} from "./message-extract.ts";

describe("extractTextCached", () => {
  it("matches extractText output", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Hello there" }],
    };
    expect(extractTextCached(message)).toBe(extractText(message));
  });

  it("returns consistent text output for repeated calls", () => {
    const message = {
      role: "user",
      content: "plain text",
    };
    expect(extractTextCached(message)).toBe("plain text");
    expect(extractTextCached(message)).toBe("plain text");
  });

  it("strips assistant relevant-memories scaffolding", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "<relevant-memories>",
            "Internal memory context",
            "</relevant-memories>",
            "Final user answer",
          ].join("\n"),
        },
      ],
    };
    expect(extractText(message)).toBe("Final user answer");
    expect(extractTextCached(message)).toBe("Final user answer");
  });

  it("extracts text from persisted Responses content blocks", () => {
    expect(
      extractText({
        role: "user",
        content: [{ type: "input_text", text: "Persisted user question" }],
      }),
    ).toBe("Persisted user question");
    expect(
      extractText({
        role: "assistant",
        content: [{ type: "output_text", text: "Persisted assistant answer" }],
      }),
    ).toBe("Persisted assistant answer");
  });

  it("accepts assistant Responses input blocks but ignores user output blocks", () => {
    expect(
      extractText({
        role: "user",
        content: [{ type: "output_text", text: "Assistant-only block" }],
      }),
    ).toBeNull();
    expect(
      extractText({
        role: "assistant",
        content: [{ type: "input_text", text: "User-only block" }],
      }),
    ).toBe("User-only block");
  });

  it("prefers final_answer assistant text over commentary text", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "thinking like caveman",
          textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Actual final answer",
          textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
        },
      ],
    };
    expect(extractText(message)).toBe("Actual final answer");
    expect(extractTextCached(message)).toBe("Actual final answer");
  });

  it("does not render commentary-only assistant text", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "thinking like caveman",
          textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
        },
      ],
    };
    expect(extractText(message)).toBeNull();
    expect(extractTextCached(message)).toBeNull();
  });

  it("strips internal runtime context blocks from user text", () => {
    const message = {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
            "internal subagent payload",
            "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
            "",
            "visible ask",
          ].join("\n"),
        },
      ],
    };

    expect(extractText(message)).toBe("visible ask");
    expect(extractTextCached(message)).toBe("visible ask");
  });
});

describe("extractThinkingCached", () => {
  it("returns consistent thinking output for repeated calls", () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Plan A" }],
    };
    expect(extractThinkingCached(message)).toBe("Plan A");
    expect(extractThinkingCached(message)).toBe("Plan A");
  });
});

describe("nullish messages", () => {
  // Chat events can arrive without a message (tool-only or heartbeat finals);
  // every unknown-typed extractor must read that as "no text", not throw.
  it("returns null instead of throwing for absent messages", () => {
    for (const message of [undefined, null]) {
      expect(extractText(message)).toBeNull();
      expect(extractTextCached(message)).toBeNull();
      expect(extractRawText(message)).toBeNull();
      expect(extractThinkingCached(message)).toBeNull();
    }
  });
});
