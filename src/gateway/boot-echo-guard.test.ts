// Boot echo guard tests protect session-scoped prompt tracking and outbound text
// stripping that prevents internal BOOT context from being sent back to users.
import { afterEach, describe, expect, it } from "vitest";
import {
  clearBootEchoContextForSession,
  containsSubstantialBootEcho,
  getBootEchoContextForSession,
  resetBootEchoContextForTests,
  setBootEchoContextForSession,
  stripBootEchoFromOutboundText,
} from "./boot-echo-guard.js";

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

describe("boot-echo-guard session map", () => {
  afterEach(() => {
    resetBootEchoContextForTests();
  });

  it("round-trips boot prompt by session key", () => {
    setBootEchoContextForSession("agent:main", LONG_BOOT_PROMPT);
    expect(getBootEchoContextForSession("agent:main")).toBe(LONG_BOOT_PROMPT);
  });

  it("clears the entry when requested", () => {
    setBootEchoContextForSession("agent:main", LONG_BOOT_PROMPT);
    clearBootEchoContextForSession("agent:main");
    expect(getBootEchoContextForSession("agent:main")).toBeUndefined();
  });

  it("returns undefined for an unknown session key without throwing", () => {
    expect(getBootEchoContextForSession(undefined)).toBeUndefined();
    expect(getBootEchoContextForSession("never-set")).toBeUndefined();
  });

  it("ignores empty inputs in setBootEchoContextForSession", () => {
    setBootEchoContextForSession("", LONG_BOOT_PROMPT);
    setBootEchoContextForSession("agent:main", "");
    expect(getBootEchoContextForSession("agent:main")).toBeUndefined();
  });
});

describe("containsSubstantialBootEcho", () => {
  it("detects an exact long-substring echo of the boot prompt", () => {
    const echoed = `Here is what I was told: ${LONG_BOOT_PROMPT}`;
    expect(containsSubstantialBootEcho(echoed, LONG_BOOT_PROMPT)).toBe(true);
  });

  it("detects an echoed BOOT.md content chunk that omits the wrapper markers", () => {
    const partial =
      "When you wake up each morning, send a thoughtful greeting to the operator over the configured channel";
    expect(containsSubstantialBootEcho(partial, LONG_BOOT_PROMPT)).toBe(true);
  });

  it("detects copied boot content when whitespace is collapsed", () => {
    const bootPrompt = [
      "BOOT.md:",
      "When you wake up each morning,",
      "send a thoughtful greeting to the operator",
      "over the configured channel and report status.",
    ].join("\n");
    const outbound =
      "When you wake up each morning, send a thoughtful greeting to the operator over the configured channel";

    expect(containsSubstantialBootEcho(outbound, bootPrompt)).toBe(true);
  });

  it("detects an unaligned exact minimum-length boot prompt chunk", () => {
    const bootPrompt = Array.from({ length: 120 }, (_, index) =>
      index.toString(36).padStart(2, "0"),
    ).join(":");
    const unalignedChunk = bootPrompt.slice(1, 81);

    expect(unalignedChunk).toHaveLength(80);
    expect(containsSubstantialBootEcho(unalignedChunk, bootPrompt)).toBe(true);
  });

  it("does not flag short legitimate sends like a brief good-morning message", () => {
    expect(containsSubstantialBootEcho("Good morning!", LONG_BOOT_PROMPT)).toBe(false);
    expect(
      containsSubstantialBootEcho("Operator, the project is on track.", LONG_BOOT_PROMPT),
    ).toBe(false);
  });

  it("does not flag paraphrased outputs that do not reproduce a long contiguous chunk", () => {
    const paraphrase =
      "Good morning. Project status: build green, two PRs in review, no blockers on the critical path right now.";
    expect(containsSubstantialBootEcho(paraphrase, LONG_BOOT_PROMPT)).toBe(false);
  });

  it("does not flag short boot prompts that fall below the minimum echo length", () => {
    const shortPrompt = "Hello.";
    expect(containsSubstantialBootEcho(shortPrompt, shortPrompt)).toBe(false);
  });

  it("detects a tail-boundary chunk that would otherwise miss the step grid", () => {
    // Construct a chunk that lives in the last 80 chars and is unlikely to land
    // exactly on the 20-char step grid.
    const tail = LONG_BOOT_PROMPT.slice(-90, -5);
    expect(tail.length).toBeGreaterThan(80);
    expect(containsSubstantialBootEcho(tail, LONG_BOOT_PROMPT)).toBe(true);
  });
});

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
});
