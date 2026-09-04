/**
 * Tests channel contract testing helpers exported by the plugin SDK.
 */
import { expectChannelTurnDispatchResultContract } from "openclaw/plugin-sdk/channel-contract-testing";
import { describe, it } from "vitest";

describe("channel contract testing helpers", () => {
  it("asserts shared channel turn dispatch visibility", () => {
    expectChannelTurnDispatchResultContract(
      {
        queuedFinal: false,
        counts: { tool: 0, block: 1, final: 0 },
        settledReceipt: {
          counts: {
            tool: {
              delivered: 0,
              failedAfterSend: 0,
            },
            block: {
              delivered: 1,
              failedAfterSend: 0,
            },
            final: {
              delivered: 0,
              failedAfterSend: 0,
            },
          },
          anyVisibleDelivered: true,
        },
      },
      {
        visible: true,
        final: false,
        counts: { block: 1 },
      },
    );
  });
});
