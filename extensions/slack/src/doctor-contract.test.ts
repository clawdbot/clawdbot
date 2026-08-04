import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract.js";

describe("slack doctor contract", () => {
  it("removes retired interactive reply capabilities from root and account config", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          slack: {
            capabilities: { interactiveReplies: true },
            accounts: {
              work: { capabilities: ["threads", " interactiveReplies "] },
            },
          },
        },
      } as never,
    });

    expect(result.config.channels?.slack).toEqual({
      accounts: { work: { capabilities: ["threads"] } },
    });
    expect(result.changes).toEqual([
      "Removed retired channels.slack.capabilities.interactiveReplies; use typed presentation actions instead.",
      "Removed retired channels.slack.accounts.work.capabilities.interactiveReplies; use typed presentation actions instead.",
    ]);
  });

  it("removes empty object-form capabilities accepted by the retired schema", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          slack: {
            capabilities: {},
            accounts: { work: { capabilities: {} } },
          },
        },
      } as never,
    });

    expect(result.config.channels?.slack).toEqual({ accounts: { work: {} } });
    expect(result.changes).toEqual([
      "Removed retired empty channels.slack.capabilities object; use typed presentation actions instead.",
      "Removed retired empty channels.slack.accounts.work.capabilities object; use typed presentation actions instead.",
    ]);
  });

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
