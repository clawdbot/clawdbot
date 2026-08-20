import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../runtime/index.js";
import { invalidateComputerFrameIfMissing, TINY_PNG_BASE64 } from "./computer-tool.test-helpers.js";

function imageIdentity(data: string, mimeType = "image/png") {
  return createHash("sha256")
    .update(JSON.stringify([mimeType, data]))
    .digest("hex");
}

function computerToolResult(
  toolCallId: string,
  content: Extract<AgentMessage, { role: "toolResult" }>["content"],
) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName: "computer",
    content,
    details: {},
    isError: false,
    timestamp: 1,
  } satisfies AgentMessage;
}

function trackedContextEpoch(value: number) {
  return {
    value,
    frameToolCallId: "shot-1",
    frameImageIdentity: imageIdentity(TINY_PNG_BASE64),
  };
}

function screenshotToolResult(data = TINY_PNG_BASE64) {
  return computerToolResult("shot-1", [{ type: "image", data, mimeType: "image/png" }]);
}

describe("computer screenshot context binding", () => {
  it("keeps coordinates valid while the tracked tool result image remains visible", () => {
    const contextEpoch = trackedContextEpoch(0);

    expect(
      invalidateComputerFrameIfMissing({
        contextEpoch,
        messages: [screenshotToolResult()],
      }),
    ).toBe(false);
    expect(contextEpoch).toEqual(trackedContextEpoch(0));
  });

  it("expires coordinates once the final context drops the tracked image", () => {
    const contextEpoch = trackedContextEpoch(0);

    expect(
      invalidateComputerFrameIfMissing({
        contextEpoch,
        messages: [computerToolResult("shot-1", [{ type: "text", text: "compacted" }])],
      }),
    ).toBe(true);
    expect(contextEpoch).toEqual({ value: 1 });
    expect(invalidateComputerFrameIfMissing({ contextEpoch, messages: [] })).toBe(false);
    expect(contextEpoch.value).toBe(1);
  });

  it.each([
    [
      "expires coordinates when image input is disabled at the model boundary",
      trackedContextEpoch(3),
      [screenshotToolResult()],
      true,
      { value: 4 },
    ],
    [
      "expires coordinates when middleware swaps the tracked screenshot",
      trackedContextEpoch(5),
      [screenshotToolResult("AQ==")],
      undefined,
      { value: 6 },
    ],
    [
      "cleans up an orphaned image identity",
      { value: 8, frameImageIdentity: imageIdentity(TINY_PNG_BASE64) },
      [],
      undefined,
      { value: 9 },
    ],
  ])("%s", (_name, contextEpoch, messages, imagesBlocked, expected) => {
    expect(invalidateComputerFrameIfMissing({ contextEpoch, messages, imagesBlocked })).toBe(true);
    expect(contextEpoch).toEqual(expected);
  });
});
