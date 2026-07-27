import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract.js";

describe("slack doctor contract", () => {
  it("moves direct DM reply mode to the chat-type map", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          slack: {
            dm: { replyToMode: "all" },
            accounts: { work: { dm: { replyToMode: "first" } } },
          },
        },
      } as never,
    });
    expect(result.config.channels?.slack).toEqual({
      dm: {},
      replyToModeByChatType: { direct: "all" },
      accounts: {
        work: { dm: {}, replyToModeByChatType: { direct: "first" } },
      },
    });
  });
});
