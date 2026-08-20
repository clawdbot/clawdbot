// Covers the operator-visible recovery path for rejected iMessage aliases.
import { describe, expect, it } from "vitest";
import { imessagePlugin } from "../../../extensions/imessage/channel-plugin-api.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveChannelTarget } from "./target-resolver.js";

describe("iMessage target recovery guidance", () => {
  it("tells operators how to qualify an otherwise ambiguous contact alias", async () => {
    const result = await resolveChannelTarget({
      cfg: {} as OpenClawConfig,
      channel: "imessage",
      input: "C0AG22RN7L3",
      plugin: imessagePlugin,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(
        'Unknown target "C0AG22RN7L3" for iMessage. Hint: <phone|email|chat_id:ID|auto:contact|imessage:contact|sms:contact>',
      );
    }
  });
});
