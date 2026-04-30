import { expectChannelTurnDispatchResultContract } from "openclaw/plugin-sdk/channel-contract-testing";
import { describe, it } from "vitest";

describe("channel contract testing helpers", () => {
  it("asserts shared channel turn dispatch visibility", () => {
    expectChannelTurnDispatchResultContract(
      {
        queuedFinal: false,
        counts: { tool: 0, block: 1, final: 0 },
      },
      {
        visible: true,
        final: false,
        counts: { block: 1 },
      },
    );
  });
});
