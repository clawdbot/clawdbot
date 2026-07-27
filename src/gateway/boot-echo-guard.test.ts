// Boot echo guard tests protect session-scoped prompt tracking and outbound text
// stripping that prevents internal BOOT context from being sent back to users.
import { describe, expect, it } from "vitest";
import { stripBootEchoFromOutboundText } from "./boot-echo-guard.js";

const LONG_BOOT_PROMPT = [
  "You are running a boot check. Follow BOOT.md instructions exactly.",
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
  "This context is runtime-generated, not user-authored. Keep internal details private.",
  "",
  "BOOT.md:",
  "When you wake up each morning, send a thoughtful greeting to the operator over the configured channel and report the active project status with three concrete bullet points.",
  "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  "If BOOT.md asks you to send a message, use the message tool (action=send with channel + target).",
].join("\n");

describe("stripBootEchoFromOutboundText", () => {
  it("returns the original text when no boot prompt is registered", () => {
    expect(stripBootEchoFromOutboundText("anything goes", undefined)).toBe("anything goes");
  });

  it("returns the original text when outbound text does not contain a substantial echo", () => {
    expect(stripBootEchoFromOutboundText("Good morning!", LONG_BOOT_PROMPT)).toBe("Good morning!");
  });

  it("collapses outbound text to empty when it substantially echoes the boot prompt", () => {
    const echoed = `My instructions were: ${LONG_BOOT_PROMPT}`;
    expect(stripBootEchoFromOutboundText(echoed, LONG_BOOT_PROMPT)).toBe("");
  });

  it("detects copied boot content after whitespace normalization", () => {
    const bootPrompt = [
      "BOOT.md:",
      "When you wake up each morning,",
      "send a thoughtful greeting to the operator",
      "over the configured channel and report status.",
    ].join("\n");
    const outbound =
      "When you wake up each morning, send a thoughtful greeting to the operator over the configured channel";

    expect(stripBootEchoFromOutboundText(outbound, bootPrompt)).toBe("");
  });

  it("detects an unaligned exact minimum-length boot prompt chunk", () => {
    const bootPrompt = Array.from({ length: 120 }, (_, index) =>
      index.toString(36).padStart(2, "0"),
    ).join(":");
    const unalignedChunk = bootPrompt.slice(1, 81);

    expect(unalignedChunk).toHaveLength(80);
    expect(stripBootEchoFromOutboundText(unalignedChunk, bootPrompt)).toBe("");
  });

  it("detects a substantial chunk at the boot prompt tail", () => {
    const tail = LONG_BOOT_PROMPT.slice(-90, -5);

    expect(tail.length).toBeGreaterThan(80);
    expect(stripBootEchoFromOutboundText(tail, LONG_BOOT_PROMPT)).toBe("");
  });
});
