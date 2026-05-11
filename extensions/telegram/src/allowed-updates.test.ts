import { beforeAll, describe, expect, it } from "vitest";
let DEFAULT_TELEGRAM_UPDATE_TYPES: typeof import("./allowed-updates.js").DEFAULT_TELEGRAM_UPDATE_TYPES;
let resolveTelegramAllowedUpdates: typeof import("./allowed-updates.js").resolveTelegramAllowedUpdates;

beforeAll(async () => {
  ({ DEFAULT_TELEGRAM_UPDATE_TYPES, resolveTelegramAllowedUpdates } =
    await import("./allowed-updates.js"));
});

describe("resolveTelegramAllowedUpdates", () => {
  it("includes the default update types plus reaction and channel post support", () => {
    const updates = resolveTelegramAllowedUpdates();
    const expectedUpdates = [...DEFAULT_TELEGRAM_UPDATE_TYPES];
    if (!expectedUpdates.includes("message_reaction")) {
      expectedUpdates.push("message_reaction");
    }
    if (!expectedUpdates.includes("channel_post")) {
      expectedUpdates.push("channel_post");
    }

    expect(updates).toEqual(expectedUpdates);
    expect(updates).toContain("message_reaction");
    expect(updates).toContain("channel_post");
    expect(new Set(updates).size).toBe(updates.length);
  });
});
