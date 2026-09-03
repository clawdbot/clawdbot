import type {
  UpdateGenerationTransactionReceipt,
  UpdateGenerationTransactionRecord,
} from "../../src/infra/update-generation-contract.js";
import type {
  UpdateGenerationLedgerCompareAndSwapResult,
  UpdateGenerationLedgerHook,
  UpdateGenerationTransactionSnapshot,
} from "../../src/infra/update-generation-ledger-hook.js";

export class TestUpdateGenerationMemoryLedger implements UpdateGenerationLedgerHook {
  #revision = 0;
  #snapshot: UpdateGenerationTransactionSnapshot | null = null;
  #receipts = new Map<string, UpdateGenerationTransactionSnapshot>();

  constructor(snapshot: UpdateGenerationTransactionSnapshot | null = null) {
    this.#snapshot = snapshot ? structuredClone(snapshot) : null;
    this.#revision = Number(snapshot?.revision ?? 0);
  }

  async read(namespaceKey: string): Promise<UpdateGenerationTransactionSnapshot | null> {
    return this.#snapshot?.record.namespaceKey === namespaceKey
      ? structuredClone(this.#snapshot)
      : null;
  }

  async compareAndSwap(params: {
    namespaceKey: string;
    expectedRevision: string | null;
    receipt: UpdateGenerationTransactionReceipt;
    nextRecord: UpdateGenerationTransactionRecord;
  }): Promise<UpdateGenerationLedgerCompareAndSwapResult> {
    const replay = this.#receipts.get(params.receipt.receiptId);
    if (replay) {
      return { status: "replayed", snapshot: structuredClone(replay) };
    }
    if ((this.#snapshot?.revision ?? null) !== params.expectedRevision) {
      return {
        status: "conflict",
        snapshot: this.#snapshot ? structuredClone(this.#snapshot) : null,
      };
    }
    this.#revision += 1;
    this.#snapshot = {
      revision: String(this.#revision),
      record: structuredClone(params.nextRecord),
    };
    this.#receipts.set(params.receipt.receiptId, this.#snapshot);
    return { status: "stored", snapshot: structuredClone(this.#snapshot) };
  }
}
