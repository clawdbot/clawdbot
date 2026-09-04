import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { QueuedFollowupReplyBatch } from "../../auto-reply/reply/queue/types.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import type { GatewayRequestContext } from "./types.js";

type TerminalDisposition = "pending" | "deliver" | "delivering" | "drop" | "settled";
type DropReason =
  | "non-webchat-origin"
  | "origin-mismatch"
  | "terminal-not-recorded"
  | "already-settled"
  | "delivery-in-flight"
  | "no-visible-content"
  | "delivery-failed";

/** One Gateway admission owns the outcome of its queued reply, including concurrent duplicates. */
export function createChatSendLateFollowupDisposition(params: {
  runId: string;
  originatingChannel: string;
  logGateway: GatewayRequestContext["logGateway"];
  deliver: (params: {
    runId: string;
    payloads: ReplyPayload[];
  }) => Promise<{ kind: "delivered" } | { kind: "dropped"; reason: "no-visible-content" }>;
}) {
  let terminal: TerminalDisposition = "pending";
  const recordDrop = (batch: QueuedFollowupReplyBatch, reason: DropReason, settle = true) => {
    if (settle) {
      terminal = "settled";
    }
    params.logGateway.info("webchat late reply disposition", {
      runId: params.runId,
      followupRunId: batch.runId,
      outcome: "late-and-dropped",
      reason,
    });
  };
  return {
    recordQueued: () => {
      if (terminal === "pending") {
        terminal = isInternalMessageChannel(params.originatingChannel) ? "deliver" : "drop";
      }
    },
    deliver: async (batch: QueuedFollowupReplyBatch) => {
      if (terminal === "delivering") {
        return recordDrop(batch, "delivery-in-flight", false);
      }
      if (terminal !== "deliver") {
        return recordDrop(
          batch,
          terminal === "pending"
            ? "terminal-not-recorded"
            : terminal === "drop"
              ? "non-webchat-origin"
              : "already-settled",
        );
      }
      if (!isInternalMessageChannel(batch.originatingChannel)) {
        return recordDrop(batch, "origin-mismatch");
      }
      terminal = "delivering";
      try {
        const result = await params.deliver({ runId: batch.runId, payloads: batch.payloads });
        if (result.kind === "dropped") {
          return recordDrop(batch, result.reason);
        }
        terminal = "settled";
      } catch (error) {
        recordDrop(batch, "delivery-failed");
        throw error;
      }
    },
  };
}
