import type { CompletedReplay, MessageBody, ReplayClaim, ReplayStore } from "./envelope.js";
import type { SignedReceipt } from "./receipts.js";

export type { CompletedReplay, ReplayClaim, ReplayStore } from "./envelope.js";

interface ReplayRecord {
  envelopeHash: string;
  state: "available" | "in_flight" | "completed" | "consumed";
  receipt?: SignedReceipt;
  body?: MessageBody;
}

export class MemoryReplayStore implements ReplayStore {
  readonly #bindings = new Map<string, ReplayRecord>();

  async claim(peer: string, id: string, envelopeHash: string): Promise<ReplayClaim> {
    const key = replayKey(peer, id);
    const existing = this.#bindings.get(key);
    if (existing === undefined) {
      this.#bindings.set(key, { envelopeHash, state: "in_flight" });
      return "new";
    }
    if (existing.envelopeHash !== envelopeHash) {
      return "mismatch";
    }
    if (existing.state === "completed" || existing.state === "consumed") {
      return "duplicate";
    }
    if (existing.state === "in_flight") {
      return "in_flight";
    }
    existing.state = "in_flight";
    return "new";
  }

  async refresh(_peer: string, _id: string): Promise<void> {}

  async complete(
    peer: string,
    id: string,
    receipt: SignedReceipt,
    body?: MessageBody,
  ): Promise<void> {
    const existing = this.#bindings.get(replayKey(peer, id));
    if (existing?.state !== "in_flight") {
      throw new Error("replay claim is not in flight");
    }
    if (receipt.id !== id) {
      throw new Error("receipt id does not match replay claim");
    }
    validateCompletion(receipt, body);
    existing.state = "completed";
    existing.receipt = structuredClone(receipt);
    if (body !== undefined) {
      existing.body = structuredClone(body);
    }
  }

  async consume(peer: string, id: string): Promise<void> {
    const existing = this.#bindings.get(replayKey(peer, id));
    if (existing?.state !== "in_flight") {
      throw new Error("replay claim is not in flight");
    }
    existing.state = "consumed";
    delete existing.receipt;
    delete existing.body;
  }

  async release(peer: string, id: string): Promise<void> {
    const existing = this.#bindings.get(replayKey(peer, id));
    if (existing?.state === "in_flight") {
      existing.state = "available";
    }
  }

  async completed(peer: string, id: string): Promise<CompletedReplay | undefined> {
    const existing = this.#bindings.get(replayKey(peer, id));
    if (existing?.state !== "completed" || existing.receipt === undefined) {
      return undefined;
    }
    return existing.body === undefined
      ? { receipt: structuredClone(existing.receipt) }
      : { receipt: structuredClone(existing.receipt), body: structuredClone(existing.body) };
  }
}

function replayKey(peer: string, id: string): string {
  return `${peer}\n${id}`;
}

function validateCompletion(receipt: SignedReceipt, body: MessageBody | undefined): void {
  if ((receipt.status === "accepted") !== (body !== undefined)) {
    throw new Error("accepted replay completion requires body; rejected completion forbids body");
  }
}
