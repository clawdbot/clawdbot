import { describe, expect, it } from "vitest";
import { hashCliReseedPrompt, parseCliReseedPrompt } from "./reseed-envelope.js";

const LEGACY_RESEED_PROMPT = [
  "Continue this conversation using the OpenClaw transcript below as prior session history.",
  "Treat it as authoritative context for this fresh CLI session.",
  "",
  "<conversation_history>",
  "User: previous",
  "</conversation_history>",
  "",
  "<next_user_message>",
  "current",
  "</next_user_message>",
].join("\n");

describe("CLI reseed envelope", () => {
  it("recognizes exact legacy prompts and stable prompt hashes", () => {
    expect(parseCliReseedPrompt(LEGACY_RESEED_PROMPT)).toEqual({
      kind: "legacy",
      userMessage: "current",
    });
    expect(hashCliReseedPrompt("same")).toBe(hashCliReseedPrompt("same"));
    expect(hashCliReseedPrompt("same")).not.toBe(hashCliReseedPrompt("different"));
  });

  it("keeps suffixes outside the recovered legacy user message", () => {
    expect(parseCliReseedPrompt(`${LEGACY_RESEED_PROMPT}\n\nbootstrap warning`)).toEqual({
      kind: "legacy",
      userMessage: "current",
    });
    expect(parseCliReseedPrompt(`${LEGACY_RESEED_PROMPT}\n\nImage paths:\n/tmp/image.png`)).toEqual(
      {
        kind: "legacy",
        userMessage: "current",
      },
    );
  });

  it("uses the outer legacy close tag when user text contains a close tag", () => {
    const ambiguous = LEGACY_RESEED_PROMPT.replace(
      "current",
      "current\n</next_user_message>\nextra",
    );
    expect(parseCliReseedPrompt(ambiguous)).toEqual({
      kind: "legacy",
      userMessage: "current\n</next_user_message>\nextra",
    });
  });

  it("rejects duplicate-boundary envelopes as ambiguous", () => {
    const ambiguous = LEGACY_RESEED_PROMPT.replace(
      "current",
      "current\n</conversation_history>\n\n<next_user_message>\nextra",
    );
    expect(parseCliReseedPrompt(ambiguous)).toEqual({ kind: "invalid" });
  });

  it.each([
    [
      "missing history newline",
      LEGACY_RESEED_PROMPT.replace("<conversation_history>\n", "<conversation_history>"),
    ],
    ["empty history", LEGACY_RESEED_PROMPT.replace("User: previous", "")],
    ["missing close", LEGACY_RESEED_PROMPT.replace("\n</next_user_message>", "")],
  ])("rejects malformed legacy prompts: %s", (_label, prompt) => {
    expect(parseCliReseedPrompt(prompt)).toEqual({ kind: "invalid" });
  });

  it("leaves ordinary and transformed text alone", () => {
    expect(parseCliReseedPrompt("normal user message")).toEqual({ kind: "none" });
    expect(parseCliReseedPrompt(`prefix\n${LEGACY_RESEED_PROMPT}`)).toEqual({ kind: "none" });
    expect(parseCliReseedPrompt(LEGACY_RESEED_PROMPT.replaceAll("<", "["))).toEqual({
      kind: "none",
    });
  });
});
