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
  type UpdateGenerationSelection,
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
  /** Read-only lookup retained across transaction rollover for idempotent receipt retries. */
  readReceipt(params: {
    namespaceKey: string;
    receiptId: string;
  }): Promise<UpdateGenerationTransactionSnapshot | null>;
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

async function authenticateLedgerSnapshot(
  filesystem: UpdateGenerationConfinedFilesystem,
  snapshot: UpdateGenerationTransactionSnapshot,
): Promise<UpdateGenerationTransactionSnapshot> {
  if (typeof snapshot.revision !== "string" || !snapshot.revision.trim()) {
    throw new Error("Authoritative update ledger returned an invalid revision");
  }
  return Object.freeze({
    revision: snapshot.revision,
    record: await authenticateUpdateGenerationTransactionRecord(filesystem, snapshot.record),
  });
}

function terminalGenerationBeforeRollover(record: UpdateGenerationTransactionRecord): {
  selection: UpdateGenerationSelection;
  packageVersion: string;
} {
  const projection = projectUpdateGenerationTransaction(record);
  const selection = projection.rolledBack
    ? (projection.baselineSelection ?? projection.intent.previousSelection)
    : projection.candidateSelection;
  const packageVersion = projection.rolledBack
    ? (projection.generations.previous?.packageVersion ?? projection.intent.previousPackageVersion)
    : projection.generations.candidate?.packageVersion;
  if (!selection || !packageVersion) {
    throw new Error("Completed update generation transaction has no terminal runtime");
  }
  return { selection, packageVersion };
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
  const snapshot = params.snapshot
    ? await authenticateLedgerSnapshot(params.filesystem, params.snapshot)
    : null;
  if (
    snapshot &&
    receipt.kind === "intent" &&
    snapshot.record.namespaceKey !== receipt.namespaceKey
  ) {
    throw new Error("Update generation ledger snapshot belongs to a different namespace");
  }
  const localReplay = snapshot?.record.receipts.find(
    (persisted) => persisted.receiptId === receipt.receiptId,
  );
  if (localReplay && !isDeepStrictEqual(localReplay, receipt)) {
    throw new Error("Update generation receipt id was replayed with different content");
  }
  const replayNamespace = snapshot?.record.namespaceKey ?? params.filesystem.namespaceKey;
  const authoritative = await params.ledger.readReceipt({
    namespaceKey: replayNamespace,
    receiptId: receipt.receiptId,
  });
  if (!authoritative && localReplay) {
    throw new Error("Update generation receipt replay is missing from the authoritative ledger");
  }
  if (authoritative) {
    const authenticatedAuthoritative = await authenticateLedgerSnapshot(
      params.filesystem,
      authoritative,
    );
    const authoritativeReceipt = authenticatedAuthoritative.record.receipts.find(
      (persisted) => persisted.receiptId === receipt.receiptId,
    );
    if (!authoritativeReceipt || !isDeepStrictEqual(authoritativeReceipt, receipt)) {
      throw new Error("Authoritative update ledger replayed different receipt content");
    }
    return authenticatedAuthoritative;
  }
  const stored = await params.ledger.read(replayNamespace);
  const authoritativeSnapshot = stored
    ? await authenticateLedgerSnapshot(params.filesystem, stored)
    : null;
  if (
    Boolean(snapshot) !== Boolean(authoritativeSnapshot) ||
    (snapshot &&
      authoritativeSnapshot &&
      (snapshot.revision !== authoritativeSnapshot.revision ||
        !isDeepStrictEqual(snapshot.record, authoritativeSnapshot.record)))
  ) {
    throw new Error("Authoritative update ledger revision changed or snapshot changed");
  }
  let priorRecord: UpdateGenerationTransactionRecord | null = authoritativeSnapshot?.record ?? null;
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
    const terminal = terminalGenerationBeforeRollover(priorRecord);
    if (
      !receipt.stableBindingAlreadyVerified ||
      !isDeepStrictEqual(receipt.previousSelection, terminal.selection) ||
      receipt.previousPackageVersion !== terminal.packageVersion
    ) {
      throw new Error("A new generation transaction must continue the terminal runtime");
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
    expectedRevision: authoritativeSnapshot?.revision ?? null,
    receipt: canonicalReceipt,
    nextRecord,
  });
  if (result.status === "conflict") {
    throw new Error("Authoritative update ledger revision changed during generation transaction");
  }
  const resultStatus = result.status;
  const authenticatedResult = await authenticateLedgerSnapshot(params.filesystem, result.snapshot);
  const resultRecord = authenticatedResult.record;
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
