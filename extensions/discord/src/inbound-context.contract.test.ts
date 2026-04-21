import { expectChannelInboundContextContract } from "openclaw/plugin-sdk/testing";
import { describe, it } from "vitest";
import { buildFinalizedDiscordDirectInboundContext } from "./monitor/inbound-context.test-helpers.js";

describe("Discord inbound context contract", () => {
  it("keeps inbound context finalized", () => {
    const ctx = buildFinalizedDiscordDirectInboundContext();

    expectChannelInboundContextContract(ctx);
  });
});
