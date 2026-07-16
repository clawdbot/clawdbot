import { beforeAll, describe, expect, it } from "vitest";
let API_CONSTANTS: typeof import("grammy").API_CONSTANTS;
let DEFAULT_TELEGRAM_UPDATE_TYPES: typeof import("./allowed-updates.js").DEFAULT_TELEGRAM_UPDATE_TYPES;
let resolveTelegramAllowedUpdates: typeof import("./allowed-updates.js").resolveTelegramAllowedUpdates;

beforeAll(async () => {
  ({ API_CONSTANTS } = await import("grammy"));
  ({ DEFAULT_TELEGRAM_UPDATE_TYPES, resolveTelegramAllowedUpdates } =
    await import("./allowed-updates.js"));
});

describe("resolveTelegramAllowedUpdates", () => {
  it("includes the default update types plus reaction and channel post support", () => {
    const updates = resolveTelegramAllowedUpdates();

    expect(updates).toEqual(
      expect.arrayContaining([
        ...DEFAULT_TELEGRAM_UPDATE_TYPES,
        ...(API_CONSTANTS?.DEFAULT_UPDATE_TYPES ?? []),
      ]),
    );
    expect(updates).toContain("message_reaction");
    expect(updates).toContain("channel_post");
    expect(new Set(updates).size).toBe(updates.length);
  });
});
