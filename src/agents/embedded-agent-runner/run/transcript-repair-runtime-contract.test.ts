// Transcript repair contract tests ensure orphaned user leaves are merged into
// the next prompt consistently across runtime fixtures.
import {
  inlineDataUriOrphanLeaf,
  QUEUED_USER_MESSAGE_MARKER,
  structuredOrphanLeaf,
  textOrphanLeaf,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { describe, expect, it } from "vitest";
import { mergeOrphanedTrailingUserPrompt } from "./attempt-prompt-helpers.js";

describe("embedded agent transcript repair runtime contract", () => {
  it("merges text orphan leaves into the next prompt with the queued marker", () => {
    const result = mergeOrphanedTrailingUserPrompt({
      prompt: "newest inbound message",
      trigger: "user",
      leafMessage: textOrphanLeaf(),
    });

    expect(result).toEqual({
      merged: true,
      removeLeaf: true,
      prompt: `${QUEUED_USER_MESSAGE_MARKER}\nolder active-turn message\n\nnewest inbound message`,
    });
  });

  it("does not duplicate an orphan leaf that is already present in the next prompt", () => {
    const result = mergeOrphanedTrailingUserPrompt({
      prompt: "summary\nolder active-turn message\nnewest inbound message",
      trigger: "user",
      leafMessage: textOrphanLeaf(),
    });

    expect(result).toEqual({
      merged: false,
      removeLeaf: true,
      prompt: "summary\nolder active-turn message\nnewest inbound message",
    });
  });

  it("preserves structured text and media references before removing the leaf", () => {
    const result = mergeOrphanedTrailingUserPrompt({
      prompt: "newest inbound message",
      trigger: "user",
      leafMessage: structuredOrphanLeaf(),
    });

    expect(result).toEqual({
      merged: true,
      removeLeaf: true,
      prompt:
        `${QUEUED_USER_MESSAGE_MARKER}\n` +
        "please inspect this\n" +
        "[image_url] https://example.test/cat.png\n" +
        "[input_audio] https://example.test/cat.wav\n\n" +
        "newest inbound message",
    });
  });

  it("summarizes inline data URI media instead of embedding payload bytes", () => {
    // Inline data can be huge and provider-sensitive; repair keeps provenance
    // while avoiding byte replay in the merged prompt.
    const result = mergeOrphanedTrailingUserPrompt({
      prompt: "newest inbound message",
      trigger: "user",
      leafMessage: inlineDataUriOrphanLeaf(),
    });

    expect(result.merged).toBe(true);
    expect(result.removeLeaf).toBe(true);
    expect(result.prompt).toContain("please inspect this inline image");
    expect(result.prompt).toContain("[image_url] inline data URI (image/png, 4118 chars)");
    expect(result.prompt).not.toContain("data:");
    expect(result.prompt).not.toContain("data:image/png;base64,");
    expect(result.prompt).not.toContain("aaaa");
  });
});
