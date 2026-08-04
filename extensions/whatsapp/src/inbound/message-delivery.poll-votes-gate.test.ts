import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { shouldEmitWhatsAppPollVoteHooks } from "./poll-votes.js";

function cfgWith(whatsapp: NonNullable<OpenClawConfig["channels"]>["whatsapp"]): OpenClawConfig {
  return { channels: { whatsapp } } as OpenClawConfig;
}

describe("shouldEmitWhatsAppPollVoteHooks", () => {
  it("defaults to disabled when pluginHooks is unset", () => {
    expect(shouldEmitWhatsAppPollVoteHooks({ cfg: cfgWith({}) })).toBe(false);
  });

  it("defaults to disabled when pollVoteReceived is unset", () => {
    expect(shouldEmitWhatsAppPollVoteHooks({ cfg: cfgWith({ pluginHooks: {} }) })).toBe(false);
  });

  it("enables when channel-level pollVoteReceived is true", () => {
    expect(
      shouldEmitWhatsAppPollVoteHooks({
        cfg: cfgWith({ pluginHooks: { pollVoteReceived: true } }),
      }),
    ).toBe(true);
  });

  it("account-level true overrides channel-level false", () => {
    expect(
      shouldEmitWhatsAppPollVoteHooks({
        cfg: cfgWith({
          pluginHooks: { pollVoteReceived: false },
          accounts: { work: { pluginHooks: { pollVoteReceived: true } } },
        }),
        accountId: "work",
      }),
    ).toBe(true);
  });

  it("account-level false overrides channel-level true", () => {
    expect(
      shouldEmitWhatsAppPollVoteHooks({
        cfg: cfgWith({
          pluginHooks: { pollVoteReceived: true },
          accounts: { work: { pluginHooks: { pollVoteReceived: false } } },
        }),
        accountId: "work",
      }),
    ).toBe(false);
  });

  it("falls back to channel-level when the account has no override", () => {
    expect(
      shouldEmitWhatsAppPollVoteHooks({
        cfg: cfgWith({
          pluginHooks: { pollVoteReceived: true },
          accounts: { work: {} },
        }),
        accountId: "work",
      }),
    ).toBe(true);
  });
});
