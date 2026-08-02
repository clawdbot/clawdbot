// Qa Lab tests cover memory-unavailable fallback evaluation.
import { describe, expect, it } from "vitest";
import { hasUnavailableMemoryBoundary } from "./memory-fallback-eval.js";

describe("hasUnavailableMemoryBoundary", () => {
  it.each([
    "I don't have access to the memory-backed note, so I can't verify the hidden fact.",
    "The hidden information is unavailable from my current context.",
    "Memory access is disabled, so I’m unable to determine the hidden value and won’t guess.",
    "I can only confirm that a hidden fact exists; I cannot disclose its value.",
  ])("accepts a semantic access or disclosure boundary: %s", (reply) => {
    expect(hasUnavailableMemoryBoundary(reply)).toBe(true);
  });

  it.each([
    "I refuse to help with that unrelated request.",
    "A hidden fact exists.",
    "Memory is working and the hidden fact is accessible.",
    "The answer is ORBIT-9.",
    "",
  ])("rejects a reply without the required memory boundary: %s", (reply) => {
    expect(hasUnavailableMemoryBoundary(reply)).toBe(false);
  });
});
