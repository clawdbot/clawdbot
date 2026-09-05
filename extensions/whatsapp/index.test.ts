// Whatsapp tests cover index plugin behavior.
import { describe, expect, it } from "vitest";
import { whatsappPlugin } from "./channel-plugin-api.js";

describe("whatsapp bundled entries", () => {
  it("declares account config as channel-restart reload metadata", () => {
    expect(whatsappPlugin.reload).toEqual({
      configPrefixes: [
        "channels.whatsapp.enabled",
        "channels.whatsapp.accounts",
        "channels.whatsapp.selfChatMode",
      ],
      noopPrefixes: ["channels.whatsapp", "messages.inbound", "messages.ackReactionScope"],
    });
  });
});
