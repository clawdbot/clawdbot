/** Injected persistence boundary for the authoritative update transaction ledger. */
import { isDeepStrictEqual } from "node:util";
import type { UpdateGenerationConfinedFilesystem } from "./update-generation-confined-filesystem.js";
import {
  parseAuthenticatedUpdateGenerationTransactionRecord,
  parseUpdateGenerationTransactionReceipt,
  type AuthenticatedUpdateGenerationTransactionRecord,
} from "./update-generation-contract-parser.js";
import {
  appendUpdateGenerationReceipt,
  projectUpdateGenerationTransaction,
  type UpdateGenerationTransactionReceipt,
  type UpdateGenerationTransactionRecord,
} from "./update-generation-contract.js";

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

export async function authenticateUpdateGenerationTransactionRecord(
  filesystem: UpdateGenerationConfinedFilesystem,
  record: UpdateGenerationTransactionRecord,
): Promise<AuthenticatedUpdateGenerationTransactionRecord> {
  const authenticated = await parseAuthenticatedUpdateGenerationTransactionRecord(
    record,
    async (brokerReceipt) => {
      return await filesystem.authenticate(brokerReceipt);
    },
  );
  const intent = projectUpdateGenerationTransaction(authenticated).intent;
  if (intent.brokerId !== filesystem.brokerId || intent.namespaceKey !== filesystem.namespaceKey) {
    throw new Error("Generation transaction is outside the confined provider scope");
  }
  return authenticated;
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
  const receipt = parseUpdateGenerationTransactionReceipt(params.receipt);
  const expectedLedgerRevision = params.snapshot?.revision ?? null;
  const snapshot = params.snapshot
    ? Object.freeze({
        revision: params.snapshot.revision,
        record: await authenticateUpdateGenerationTransactionRecord(
          params.filesystem,
          params.snapshot.record,
        ),
      })
    : null;
  if (
    snapshot &&
    receipt.kind === "intent" &&
    snapshot.record.namespaceKey !== receipt.namespaceKey
  ) {
    throw new Error("Update generation ledger snapshot belongs to a different namespace");
  }
  const replay = snapshot?.record.receipts.find(
    (persisted) => persisted.receiptId === receipt.receiptId,
  );
  if (replay) {
    if (!isDeepStrictEqual(replay, receipt)) {
      throw new Error("Update generation receipt id was replayed with different content");
    }
    if (!snapshot) {
      throw new Error("Update generation receipt replay is missing its ledger snapshot");
    }
    return snapshot;
  }
  let priorRecord: UpdateGenerationTransactionRecord | null = snapshot?.record ?? null;
  if (receipt.kind === "intent" && priorRecord) {
    const priorProjection = projectUpdateGenerationTransaction(priorRecord);
    if (priorProjection.latest.kind !== "cleanup-completed") {
      throw new Error("A new update generation transaction requires completed prior cleanup");
    }
    if (receipt.transactionId === priorRecord.transactionId) {
      throw new Error("A new update generation transaction requires a unique transaction id");
    }
    if (
      receipt.brokerId !== priorProjection.intent.brokerId ||
      receipt.brokerRevision !== priorProjection.brokerRevision
    ) {
      throw new Error("A new generation transaction must continue its broker revision chain");
    }
    priorRecord = null;
  }
  const nextRecord = await authenticateUpdateGenerationTransactionRecord(
    params.filesystem,
    appendUpdateGenerationReceipt(priorRecord, receipt),
  );
  const canonicalReceipt = nextRecord.receipts.at(-1);
  if (!canonicalReceipt || canonicalReceipt.receiptId !== receipt.receiptId) {
    throw new Error("Authenticated update generation record lost its appended receipt");
  }
  const result = await params.ledger.compareAndSwap({
    namespaceKey: nextRecord.namespaceKey,
    expectedRevision: expectedLedgerRevision,
    receipt: canonicalReceipt,
    nextRecord,
  });
  if (result.status === "conflict") {
    throw new Error("Authoritative update ledger revision changed during generation transaction");
  }
  const resultStatus = result.status;
  const resultRevision = result.snapshot.revision;
  if (!resultRevision.trim()) {
    throw new Error("Authoritative update ledger returned an invalid revision");
  }
  const resultRecord = await authenticateUpdateGenerationTransactionRecord(
    params.filesystem,
    result.snapshot.record,
  );
  const authenticatedResult = Object.freeze({ revision: resultRevision, record: resultRecord });
  if (
    resultRecord.namespaceKey !== nextRecord.namespaceKey ||
    resultRecord.transactionId !== nextRecord.transactionId
  ) {
    throw new Error("Authoritative update ledger returned a different transaction namespace");
  }
  const persistedReceipt = resultRecord.receipts.find(
    (persisted) => persisted.receiptId === canonicalReceipt.receiptId,
  );
  if (!persistedReceipt || !isDeepStrictEqual(persistedReceipt, canonicalReceipt)) {
    throw new Error("Authoritative update ledger replayed different receipt content");
  }
  if (resultStatus === "stored" && !isDeepStrictEqual(resultRecord, nextRecord)) {
    throw new Error("Authoritative update ledger stored an unexpected transaction record");
  }
  return authenticatedResult;
}
