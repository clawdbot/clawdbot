import { describe, expect, it } from "vitest";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "./heartbeat-display.ts";

describe("heartbeat display", () => {
  it.each([
    { raw: "", shouldSkip: true, text: "" },
    { raw: "<b>HEARTBEAT_OK</b>", shouldSkip: true, text: "" },
    { raw: "**HEARTBEAT_OK**", shouldSkip: true, text: "" },
    { raw: "`HEARTBEAT_OK`", shouldSkip: true, text: "" },
    { raw: "~~HEARTBEAT_OK~~", shouldSkip: true, text: "" },
    { raw: "HEARTBEAT_OK All clear", shouldSkip: true, text: "All clear" },
    { raw: "All clear HEARTBEAT_OK!!!", shouldSkip: true, text: "All clear!!!" },
    { raw: "NO_REPLY", shouldSkip: false, text: "NO_REPLY" },
    { raw: "Keep <visible> text", shouldSkip: false, text: "Keep <visible> text" },
    {
      raw: "Keep HEARTBEAT_OK inside visible text",
      shouldSkip: false,
      text: "Keep HEARTBEAT_OK inside visible text",
    },
  ])("preserves visible text and suppression for $raw", ({ raw, shouldSkip, text }) => {
    expect(stripHeartbeatTokenForDisplay(raw)).toEqual({ shouldSkip, text });
  });

  it.each([
    { length: 300, shouldSkip: true },
    { length: 301, shouldSkip: false },
  ])(
    "applies the heartbeat acknowledgement limit at $length characters",
    ({ length, shouldSkip }) => {
      const text = "x".repeat(length);
      expect(stripHeartbeatTokenForDisplay(`${text} HEARTBEAT_OK`)).toEqual({ shouldSkip, text });
    },
  );

  it("keeps visible media and silent-reply markers while hiding acknowledgement-only turns", () => {
    expect(
      isAssistantHeartbeatAckForDisplay({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Checking scheduled work." },
          { type: "text", text: "HEARTBEAT_OK" },
        ],
      }),
    ).toBe(true);
    expect(
      isAssistantHeartbeatAckForDisplay({
        role: "assistant",
        content: [{ type: "text", text: "HEARTBEAT_OK" }, { type: "image" }],
      }),
    ).toBe(false);
    expect(isAssistantHeartbeatAckForDisplay({ role: "assistant", content: "NO_REPLY" })).toBe(
      false,
    );
  });
});
