import type { ReplyPayload } from "../reply-payload.js";

export function createBlockReplySettlementRegistry() {
  const settlements = new WeakMap<ReplyPayload, () => Promise<boolean>>();
  return {
    register(payload: ReplyPayload, resolve: () => Promise<boolean>): () => Promise<boolean> {
      let settlement: Promise<boolean> | undefined;
      const settle = () => (settlement ??= resolve());
      settlements.set(payload, settle);
      return settle;
    },
    settle(payload: ReplyPayload): Promise<boolean> {
      return settlements.get(payload)?.() ?? Promise.resolve(false);
    },
  };
}
