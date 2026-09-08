import { describe, expect, it } from "vitest";
import { buildOpenAIQuicksilverSession } from "./realtime-quicksilver-wire.js";

describe("GPT-Live session shaping", () => {
  it("maps initial roles and normalizes voices without an id field", () => {
    expect(
      buildOpenAIQuicksilverSession({
        model: "gpt-live-1-codex",
        instructions: " Speak briefly. ",
        voice: "SPRUCE",
        initialItems: [
          { role: "user", text: "Question" },
          { role: "assistant", text: "Answer" },
        ],
      }),
    ).toEqual({
      model: "gpt-live-1-codex",
      instructions: "Speak briefly.",
      audio: { output: { voice: "spruce" } },
      delegation: { type: "client" },
      initial_items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Question" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Answer" }],
        },
      ],
    });
    expect(
      buildOpenAIQuicksilverSession({
        model: "gpt-live-test-canary",
        voice: "not-a-live-voice",
        initialItems: [],
      }),
    ).toEqual({
      model: "gpt-live-test-canary",
      instructions: "",
      audio: { output: { voice: "marin" } },
      delegation: { type: "client" },
    });
  });

  it.each(["marin", "cedar"])("accepts the unlisted realtime %s voice", (voice) => {
    expect(buildOpenAIQuicksilverSession({ model: "gpt-live-test-canary", voice }).audio).toEqual({
      output: { voice },
    });
  });

  it.each([
    "alloy",
    "arbor",
    "ash",
    "ballad",
    "breeze",
    "coral",
    "cove",
    "echo",
    "ember",
    "juniper",
    "maple",
    "sage",
    "shimmer",
    "sol",
    "spruce",
    "vale",
    "verse",
  ])("defaults an unsupported %s voice to Marin for GPT-Live", (voice) => {
    expect(buildOpenAIQuicksilverSession({ model: "gpt-live-test-canary", voice }).audio).toEqual({
      output: { voice: "marin" },
    });
  });

  it.each(["arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale"])(
    "accepts the released route %s voice",
    (voice) => {
      expect(buildOpenAIQuicksilverSession({ model: "gpt-live-1-codex", voice }).audio).toEqual({
        output: { voice },
      });
    },
  );

  it("defaults the released route to Cove", () => {
    expect(buildOpenAIQuicksilverSession({ model: "gpt-live-1-codex" }).audio).toEqual({
      output: { voice: "cove" },
    });
  });

  it("bounds initial items to the newest context", () => {
    const session = buildOpenAIQuicksilverSession({
      model: "gpt-live-test-canary",
      initialItems: Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `${index}:${"x".repeat(1_000)}`,
      })),
    });

    expect(session.initial_items).toHaveLength(10);
    expect(session.initial_items?.[0]?.content[0]?.text).toMatch(/^10:/);
    expect(session.initial_items?.at(-1)?.content[0]?.text).toMatch(/^19:/);
    expect(session.initial_items?.every((item) => item.content[0]?.text.length === 800)).toBe(true);
  });
});
