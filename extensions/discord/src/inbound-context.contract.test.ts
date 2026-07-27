// Discord tests cover inbound context.contract plugin behavior.
import { expectChannelInboundContextContract } from "openclaw/plugin-sdk/channel-contract-testing";
import { describe, it } from "vitest";
import { buildFinalizedDiscordDirectInboundContext } from "./monitor/inbound-context.test-helpers.js";

describe("Discord inbound context contract", () => {
  it("keeps inbound context finalized", () => {
    const ctx = buildFinalizedDiscordDirectInboundContext();

    expectChannelInboundContextContract(ctx);
  });
});
