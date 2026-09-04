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
    if (this.#snapshot) {
      for (const receipt of this.#snapshot.record.receipts) {
        this.#receipts.set(
          this.#receiptKey(this.#snapshot.record.namespaceKey, receipt.receiptId),
          structuredClone(this.#snapshot),
        );
      }
    }
  }

  async read(namespaceKey: string): Promise<UpdateGenerationTransactionSnapshot | null> {
    return this.#snapshot?.record.namespaceKey === namespaceKey
      ? structuredClone(this.#snapshot)
      : null;
  }

  async readReceipt(params: {
    namespaceKey: string;
    receiptId: string;
  }): Promise<UpdateGenerationTransactionSnapshot | null> {
    const snapshot = this.#receipts.get(this.#receiptKey(params.namespaceKey, params.receiptId));
    return snapshot ? structuredClone(snapshot) : null;
  }

  async compareAndSwap(params: {
    namespaceKey: string;
    expectedRevision: string | null;
    receipt: UpdateGenerationTransactionReceipt;
    nextRecord: UpdateGenerationTransactionRecord;
  }): Promise<UpdateGenerationLedgerCompareAndSwapResult> {
    const receiptKey = this.#receiptKey(params.namespaceKey, params.receipt.receiptId);
    const replay = this.#receipts.get(receiptKey);
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
    this.#receipts.set(receiptKey, this.#snapshot);
    return { status: "stored", snapshot: structuredClone(this.#snapshot) };
  }

  #receiptKey(namespaceKey: string, receiptId: string): string {
    return `${namespaceKey}\0${receiptId}`;
  }
}
