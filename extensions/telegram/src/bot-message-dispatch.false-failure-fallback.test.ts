import { recordAgentRunTerminalOutcome } from "openclaw/plugin-sdk/channel-inbound";
import { expect, it } from "vitest";
import {
  allDeliveredReplyTexts,
  createContext,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
} from "./bot-message-dispatch.test-harness.js";

const FAILURE_FALLBACK_TEXT =
  "Something went wrong while processing your request. Please try again.";

// Bug A (beast-telegram-delivery-w0-sep7-1427): a message-tool-only final answer
// is delivered out-of-band, so this channel never sees a block/final delivery and
// finalAnswerDelivered stays false. When the same run is also stamped
// failed/errored, the terminal branch emits a false "something went wrong" notice
// even though the final answer WAS delivered. The dispatch result now carries a
// dedicated `sourceReplyFinalDelivered` signal; the turn tail adopts it into
// finalAnswerDelivered so the false notice is suppressed while genuine
// undelivered/errored accounting stays visible.
describeTelegramDispatch("dispatchTelegramMessage false-failure-fallback", () => {
  it("suppresses the false failure notice when a message-tool-only final was delivered on a failed-stamped run", async () => {
    // Reproduction: run stamped failed AND a message-tool-only final delivered
    // out-of-band, signalled via sourceReplyFinalDelivered.
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue(
      recordAgentRunTerminalOutcome(
        {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
          sourceReplyFinalDelivered: true,
        },
        "failed",
      ),
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
    });

    expect(allDeliveredReplyTexts()).not.toContain(FAILURE_FALLBACK_TEXT);
  });

  it("still emits the failure notice when a failed run delivered no final at all", async () => {
    // Control: same failed terminal outcome but NO delivered final and no
    // final-delivery signal. The genuine failure notice must still surface. This
    // is the case the fix must NOT suppress, guarding against over-broad silencing.
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue(
      recordAgentRunTerminalOutcome(
        {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        },
        "failed",
      ),
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
    });

    expect(allDeliveredReplyTexts()).toContain(FAILURE_FALLBACK_TEXT);
  });
});
