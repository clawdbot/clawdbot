import { describe, expect, it } from "vitest";
import {
  describeSessionsSendTool,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
} from "./tool-description-presets.js";

describe("sessions_send tool description", () => {
  it("distinguishes local context selection from exact external addressing", () => {
    expect(SESSIONS_SEND_TOOL_DISPLAY_SUMMARY).toContain("same-Gateway");
    expect(describeSessionsSendTool()).toContain("on this Gateway");
    expect(describeSessionsSendTool()).toContain("not an external address");
    expect(describeSessionsSendTool()).toContain("`conversations_send`/`conversations_turn`");
    expect(describeSessionsSendTool()).toContain("reply may still announce");
  });
});
