// Telegram tests cover allowed updates plugin behavior.
import { API_CONSTANTS } from "grammy";
import { describe, expect, it } from "vitest";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";

describe("resolveTelegramAllowedUpdates", () => {
  it("keeps default updates and reactions without subscribing to unsupported draft stops", () => {
    const updates = resolveTelegramAllowedUpdates();
    const defaults = API_CONSTANTS.DEFAULT_UPDATE_TYPES.filter(
      (type) => type !== "stopped_message_generation",
    );

    expect(new Set(updates)).toEqual(new Set([...defaults, "message_reaction", "channel_post"]));
    expect(updates).toHaveLength(new Set(updates).size);
  });
});
