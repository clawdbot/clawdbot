/**
 * Channel message receive acknowledgement context.
 *
 * Models ack/nack policy and idempotent receive state transitions for inbound events.
 */
import type { ChannelMessageReceiveAckPolicy } from "./types.js";

/** Public alias for channel receive acknowledgement policy names. */
export type MessageAckPolicy = ChannelMessageReceiveAckPolicy;

/** Processing stage where a durable inbound message may be acknowledged. */
export type MessageAckStage = "receive_record" | "agent_dispatch" | "durable_send" | "manual";

/** Current acknowledgement state for one inbound message context. */
export type MessageAckState = "pending" | "acked" | "nacked";

/** Mutable receive context passed through durable inbound message processing. */
export type MessageReceiveContext<TMessage = unknown> = {
  id: string;
  channel: string;
  accountId?: string;
  message: TMessage;
  ackPolicy: MessageAckPolicy;
  ackState: MessageAckState;
  ackedAt?: number;
  nackErrorMessage?: string;
  receivedAt: number;
  signal: AbortSignal;
  shouldAckAfter(stage: MessageAckStage): boolean;
  ack(): Promise<void>;
  nack(error: unknown): Promise<void>;
};

const neverAbortedSignal = new AbortController().signal;

/** Returns whether an ack policy should acknowledge at the supplied processing stage. */
export function shouldAckMessageAfterStage(
  policy: MessageAckPolicy,
  stage: MessageAckStage,
): boolean {
  switch (policy) {
    case "after_receive_record":
      return stage === "receive_record";
    case "after_agent_dispatch":
      return stage === "agent_dispatch";
    case "after_durable_send":
      return stage === "durable_send";
    case "manual":
      return false;
  }
  return false;
}

function normalizeAckErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Creates a receive context with idempotent ack and explicit nack state transitions. */
export function createMessageReceiveContext<TMessage>(params: {
  id: string;
  channel: string;
  accountId?: string;
  message: TMessage;
  ackPolicy?: MessageAckPolicy;
  receivedAt?: number;
  signal?: AbortSignal;
  onAck?: () => Promise<void> | void;
  onNack?: (error: unknown) => Promise<void> | void;
}): MessageReceiveContext<TMessage> {
  const ctx: MessageReceiveContext<TMessage> = {
    id: params.id,
    channel: params.channel,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    message: params.message,
    ackPolicy: params.ackPolicy ?? "after_receive_record",
    ackState: "pending",
    receivedAt: params.receivedAt ?? Date.now(),
    signal: params.signal ?? neverAbortedSignal,
    shouldAckAfter: (stage) => shouldAckMessageAfterStage(ctx.ackPolicy, stage),
    ack: async () => {
      // Ack callbacks must be idempotent because receive pipelines may revisit completed stages.
      if (ctx.ackState === "acked") {
        return;
      }
      await params.onAck?.();
      ctx.ackState = "acked";
      ctx.ackedAt = Date.now();
      delete ctx.nackErrorMessage;
    },
    nack: async (error) => {
      await params.onNack?.(error);
      ctx.ackState = "nacked";
      ctx.nackErrorMessage = normalizeAckErrorMessage(error);
    },
  };
  return ctx;
}
