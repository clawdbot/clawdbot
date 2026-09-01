import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import { cloneLlmInputHookMessages } from "./attempt-hook-messages.js";

function msg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 1,
  } as unknown as AgentMessage;
}

describe("cloneLlmInputHookMessages", () => {
  it("returns isolated clones that cannot mutate the session messages", () => {
    const source = [msg("a"), msg("b"), msg("c")];
    const cloned = cloneLlmInputHookMessages(source);
    expect(cloned).not.toBe(source);
    expect(cloned[0]).not.toBe(source[0]);
    expect(cloned).toEqual(source);
  });

  it("reuses one frozen clone per settled message across repeated passes", () => {
    const source = [msg("h1"), msg("h2"), msg("h3"), msg("tail1"), msg("tail2")];
    const first = cloneLlmInputHookMessages(source);
    const second = cloneLlmInputHookMessages(source);
    // Settled history (all but the trailing 2) is served from the cache…
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen((first[0] as { content: unknown[] }).content)).toBe(true);
    // …while the fresh tail is re-cloned every pass (mutable in-flight zone).
    expect(second[3]).not.toBe(first[3]);
    expect(second[4]).not.toBe(first[4]);
    expect(Object.isFrozen(first[4])).toBe(false);
  });

  it("keeps the cache correct when the array grows between iterations", () => {
    const grown = [msg("h1"), msg("h2")];
    const pass1 = cloneLlmInputHookMessages(grown);
    // Both entries were tail on pass 1 → fresh, uncached.
    grown.push(msg("h3"), msg("h4"));
    const pass2 = cloneLlmInputHookMessages(grown);
    // h1/h2 are now settled history: cached from THIS pass onward.
    const pass3 = cloneLlmInputHookMessages(grown);
    expect(pass2[0]).not.toBe(pass1[0]);
    expect(pass3[0]).toBe(pass2[0]);
    expect(pass3[1]).toBe(pass2[1]);
    expect(pass3[3]).not.toBe(pass2[3]);
    expect(pass3).toEqual(grown);
  });

  it("handles short arrays where everything is tail", () => {
    const source = [msg("only")];
    const a = cloneLlmInputHookMessages(source);
    const b = cloneLlmInputHookMessages(source);
    expect(a[0]).not.toBe(b[0]);
    expect(a).toEqual(source);
    expect(cloneLlmInputHookMessages([])).toEqual([]);
  });
});
