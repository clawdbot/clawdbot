/** Injected persistence boundary for the authoritative update transaction ledger. */
import { isDeepStrictEqual } from "node:util";
import type { UpdateGenerationConfinedFilesystem } from "./update-generation-confined-filesystem.js";
import {
  appendUpdateGenerationReceipt,
  projectUpdateGenerationTransaction,
  type UpdateGenerationTransactionReceipt,
  type UpdateGenerationTransactionRecord,
} from "./update-generation-contract.js";
import { brokerReceiptsInEvidence } from "./update-generation-evidence.js";

export type UpdateGenerationTransactionSnapshot = {
  /** Opaque revision owned by the authoritative update ledger. */
  revision: string;
  record: UpdateGenerationTransactionRecord;
};

export type UpdateGenerationLedgerCompareAndSwapResult =
  | {
      status: "stored" | "replayed";
      snapshot: UpdateGenerationTransactionSnapshot;
    }
  | {
      status: "conflict";
      snapshot: UpdateGenerationTransactionSnapshot | null;
    };

/**
 * Persistence boundary implemented by the authoritative update ledger.
 *
 * `compareAndSwap` must atomically validate the namespace revision, persist the
 * receipt and resulting record, and return the same snapshot when receiptId is
 * replayed. It must retain receipt replay identity across transaction rollover
 * and serialize all selector and cleanup work for namespaceKey. A new intent
 * replaces the current record only after its cleanup-completed receipt.
 */
export type UpdateGenerationLedgerHook = {
  read(namespaceKey: string): Promise<UpdateGenerationTransactionSnapshot | null>;
  compareAndSwap(params: {
    namespaceKey: string;
    expectedRevision: string | null;
    receipt: UpdateGenerationTransactionReceipt;
    nextRecord: UpdateGenerationTransactionRecord;
  }): Promise<UpdateGenerationLedgerCompareAndSwapResult>;
};

function assertUpdateGenerationTransactionRecordIsValid(
  record: UpdateGenerationTransactionRecord,
): void {
  let rebuilt: UpdateGenerationTransactionRecord | null = null;
  for (const receipt of record.receipts) {
    rebuilt = appendUpdateGenerationReceipt(rebuilt, receipt);
  }
  if (
    !rebuilt ||
    rebuilt.formatVersion !== record.formatVersion ||
    rebuilt.transactionId !== record.transactionId ||
    rebuilt.namespaceKey !== record.namespaceKey
  ) {
    throw new TypeError("Update generation transaction snapshot is invalid");
  }
}

export async function authenticateUpdateGenerationTransactionRecord(
  filesystem: UpdateGenerationConfinedFilesystem,
  record: UpdateGenerationTransactionRecord,
): Promise<void> {
  assertUpdateGenerationTransactionRecordIsValid(record);
  const intent = projectUpdateGenerationTransaction(record).intent;
  if (intent.brokerId !== filesystem.brokerId || intent.namespaceKey !== filesystem.namespaceKey) {
    throw new Error("Generation transaction is outside the confined provider scope");
  }
  for (const receipt of record.receipts) {
    if (!("evidence" in receipt)) {
      continue;
    }
    for (const brokerReceipt of brokerReceiptsInEvidence(receipt.evidence)) {
      await filesystem.authenticate(brokerReceipt);
    }
  }
}

export async function persistUpdateGenerationReceipt(params: {
  filesystem: UpdateGenerationConfinedFilesystem | null;
  ledger: UpdateGenerationLedgerHook;
  snapshot: UpdateGenerationTransactionSnapshot | null;
  receipt: UpdateGenerationTransactionReceipt;
}): Promise<UpdateGenerationTransactionSnapshot> {
  if (!params.filesystem) {
    throw new Error("Generation state machine requires a confined filesystem provider");
  }
  if (params.snapshot) {
    assertUpdateGenerationTransactionRecordIsValid(params.snapshot.record);
    await authenticateUpdateGenerationTransactionRecord(params.filesystem, params.snapshot.record);
  }
  if ("evidence" in params.receipt) {
    for (const brokerReceipt of brokerReceiptsInEvidence(params.receipt.evidence)) {
      await params.filesystem.authenticate(brokerReceipt);
    }
  }
  if (
    params.snapshot &&
    params.receipt.kind === "intent" &&
    params.snapshot.record.namespaceKey !== params.receipt.namespaceKey
  ) {
    throw new Error("Update generation ledger snapshot belongs to a different namespace");
  }
  const replay = params.snapshot?.record.receipts.find(
    (receipt) => receipt.receiptId === params.receipt.receiptId,
  );
  if (replay) {
    if (!isDeepStrictEqual(replay, params.receipt)) {
      throw new Error("Update generation receipt id was replayed with different content");
    }
    if (!params.snapshot) {
      throw new Error("Update generation receipt replay is missing its ledger snapshot");
    }
    return params.snapshot;
  }
  let priorRecord: UpdateGenerationTransactionRecord | null = params.snapshot?.record ?? null;
  if (params.receipt.kind === "intent" && priorRecord) {
    const priorProjection = projectUpdateGenerationTransaction(priorRecord);
    if (priorProjection.latest.kind !== "cleanup-completed") {
      throw new Error("A new update generation transaction requires completed prior cleanup");
    }
    if (params.receipt.transactionId === priorRecord.transactionId) {
      throw new Error("A new update generation transaction requires a unique transaction id");
    }
    if (
      params.receipt.brokerId !== priorProjection.intent.brokerId ||
      params.receipt.brokerRevision !== priorProjection.brokerRevision
    ) {
      throw new Error("A new generation transaction must continue its broker revision chain");
    }
    priorRecord = null;
  }
  const nextRecord = appendUpdateGenerationReceipt(priorRecord, params.receipt);
  await authenticateUpdateGenerationTransactionRecord(params.filesystem, nextRecord);
  const result = await params.ledger.compareAndSwap({
    namespaceKey: nextRecord.namespaceKey,
    expectedRevision: params.snapshot?.revision ?? null,
    receipt: params.receipt,
    nextRecord,
  });
  if (result.status === "conflict") {
    throw new Error("Authoritative update ledger revision changed during generation transaction");
  }
  if (!result.snapshot.revision) {
    throw new Error("Authoritative update ledger returned an invalid revision");
  }
  await authenticateUpdateGenerationTransactionRecord(params.filesystem, result.snapshot.record);
  if (
    result.snapshot.record.namespaceKey !== nextRecord.namespaceKey ||
    result.snapshot.record.transactionId !== nextRecord.transactionId
  ) {
    throw new Error("Authoritative update ledger returned a different transaction namespace");
  }
  const persistedReceipt = result.snapshot.record.receipts.find(
    (receipt) => receipt.receiptId === params.receipt.receiptId,
  );
  if (!persistedReceipt || !isDeepStrictEqual(persistedReceipt, params.receipt)) {
    throw new Error("Authoritative update ledger replayed different receipt content");
  }
  if (result.status === "stored" && !isDeepStrictEqual(result.snapshot.record, nextRecord)) {
    throw new Error("Authoritative update ledger stored an unexpected transaction record");
  }
  return result.snapshot;
}
