import type { CliBackendParsedJsonlEvent } from "openclaw/plugin-sdk/cli-backend";
import { describe, expect, it } from "vitest";

function describeLegacyCliBackendEvent(event: CliBackendParsedJsonlEvent): string {
  switch (event.kind) {
    case "text":
    case "thinking":
      return event.text;
    case "toolStart":
      return event.name;
    case "toolResult":
      return event.toolCallId;
    case "result":
      return event.text ?? "result";
    case "sessionId":
      return event.sessionId;
  }
  const exhaustive: never = event;
  return exhaustive;
}

describe("CLI backend Plugin SDK compatibility", () => {
  it("keeps existing parser events exhaustively matchable when lifecycle events are added", () => {
    expect(describeLegacyCliBackendEvent({ kind: "text", text: "ready" })).toBe("ready");
  });
});
