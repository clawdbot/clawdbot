import { describe, expect, it } from "vitest";
import { resolveTelegramDmHistoryLimit } from "./dm-history.js";

describe("resolveTelegramDmHistoryLimit", () => {
  it("uses the Telegram default when no limit is configured", () => {
    expect(resolveTelegramDmHistoryLimit({ config: {} })).toBe(10);
  });

  it("honors and clamps the account limit", () => {
    expect(resolveTelegramDmHistoryLimit({ config: { dmHistoryLimit: 4 } })).toBe(4);
    expect(resolveTelegramDmHistoryLimit({ config: { dmHistoryLimit: -1 } })).toBe(0);
  });

  it("prefers the sender override over the account limit", () => {
    expect(
      resolveTelegramDmHistoryLimit({
        config: {
          dmHistoryLimit: 5,
          dms: {
            "42": { historyLimit: 0 },
          },
        },
        senderId: 42,
      }),
    ).toBe(0);
    expect(
      resolveTelegramDmHistoryLimit({
        config: {
          dmHistoryLimit: 0,
          dms: {
            "42": { historyLimit: 2 },
          },
        },
        senderId: "42",
      }),
    ).toBe(2);
  });
});
