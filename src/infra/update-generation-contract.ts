/** Durable transaction vocabulary for generation-addressed package updates. */
import { isDeepStrictEqual } from "node:util";

export type UpdateGenerationManager = "npm" | "pnpm" | "bun";
export type UpdateGenerationRole = "previous" | "candidate";

export type UpdateGenerationManifest = {
  algorithm: "sha256";
  digest: string;
  entryCount: number;
  totalBytes: number;
};

export type UpdateGenerationSelection = {
  formatVersion: 1;
  generationId: string;
  manifestSha256: string;
  entrypointRelativePath: string;
};

export type UpdateGenerationDescriptor = UpdateGenerationSelection & {
  packageVersion: string;
};

export type UpdateGenerationServiceIntent = {
  managed: boolean;
  running: boolean;
  enabled?: boolean;
};

export type UpdateGenerationBinding = {
  kind: "launcher" | "service";
  identity: string;
  priorFingerprint: string | null;
};

type UpdateGenerationReceiptBase = {
  formatVersion: 1;
  transactionId: string;
  sequence: number;
  receiptId: string;
  recordedAtMs: number;
};

export type UpdateGenerationTransactionReceipt =
  | (UpdateGenerationReceiptBase & {
      kind: "intent";
      manager: UpdateGenerationManager;
      namespaceKey: string;
      namespaceRoot: string;
      selectorPath: string;
      stagingRoot: string;
      serviceBefore: UpdateGenerationServiceIntent;
      previousSelection: UpdateGenerationSelection | null;
      stableBindingAlreadyVerified: boolean;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "generation-materialization-intent";
      role: UpdateGenerationRole;
      sourceRoot: string;
      generationId: string;
      manifest: UpdateGenerationManifest;
      packageVersion: string;
      entrypointRelativePath: string;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "generation-materialized";
      role: UpdateGenerationRole;
      generation: UpdateGenerationDescriptor;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "baseline-selection-intent";
      selection: UpdateGenerationSelection;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "baseline-selected";
      selection: UpdateGenerationSelection;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "binding-intent";
      bindings: UpdateGenerationBinding[];
    })
  | (UpdateGenerationReceiptBase & {
      kind: "binding-completed";
      bindings: Array<UpdateGenerationBinding & { fingerprint: string }>;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "candidate-selection-intent";
      from: UpdateGenerationSelection;
      to: UpdateGenerationSelection;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "candidate-selected";
      selection: UpdateGenerationSelection;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "completion";
      packageVersion: string;
      launcherVersion: string;
      serviceRunning: boolean;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "rollback-intent";
      from: UpdateGenerationSelection;
      to: UpdateGenerationSelection;
      reason: string;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "rolled-back";
      selection: UpdateGenerationSelection;
      launcherVersion: string;
      serviceRunning: boolean;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "cleanup-intent";
      generationIds: string[];
      protectedGenerationIds: string[];
    })
  | (UpdateGenerationReceiptBase & {
      kind: "cleanup-completed";
      removedGenerationIds: string[];
      deferred: Array<{ generationId: string; reason: string }>;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "failure";
      operation: string;
      reason: string;
      serviceRestored: boolean;
    });

export type UpdateGenerationTransactionRecord = {
  formatVersion: 1;
  transactionId: string;
  namespaceKey: string;
  receipts: UpdateGenerationTransactionReceipt[];
};

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
 * replayed. It must serialize all selector and cleanup work for namespaceKey.
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

export type UpdateGenerationProjection = {
  intent: Extract<UpdateGenerationTransactionReceipt, { kind: "intent" }>;
  latest: UpdateGenerationTransactionReceipt;
  latestTransition: Exclude<UpdateGenerationTransactionReceipt, { kind: "failure" }>;
  materializationIntents: Partial<
    Record<
      UpdateGenerationRole,
      Extract<UpdateGenerationTransactionReceipt, { kind: "generation-materialization-intent" }>
    >
  >;
  generations: Partial<Record<UpdateGenerationRole, UpdateGenerationDescriptor>>;
  baselineSelection: UpdateGenerationSelection | null;
  bindingCompleted: boolean;
  candidateSelection: UpdateGenerationSelection | null;
  completed: boolean;
  rolledBack: boolean;
  cleanupCompleted: boolean;
};

const RECEIPT_ID_SAFE = /^[A-Za-z0-9._:@/-]+$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export function buildUpdateGenerationReceiptId(params: {
  transactionId: string;
  sequence: number;
  kind: UpdateGenerationTransactionReceipt["kind"];
}): string {
  return `${params.transactionId}:${params.sequence}:${params.kind}`;
}

function assertReceiptIdentity(receipt: UpdateGenerationTransactionReceipt): void {
  if (
    receipt.formatVersion !== 1 ||
    !receipt.transactionId ||
    !RECEIPT_ID_SAFE.test(receipt.transactionId) ||
    !Number.isSafeInteger(receipt.sequence) ||
    receipt.sequence < 0 ||
    !Number.isSafeInteger(receipt.recordedAtMs) ||
    receipt.recordedAtMs < 0
  ) {
    throw new TypeError("Invalid update generation receipt identity");
  }
  const expected = buildUpdateGenerationReceiptId(receipt);
  if (receipt.receiptId !== expected) {
    throw new TypeError(`Invalid update generation receipt id: expected ${expected}`);
  }
}

function selectionsEqual(
  left: UpdateGenerationSelection | null,
  right: UpdateGenerationSelection | null,
): boolean {
  return (
    left?.formatVersion === right?.formatVersion &&
    left?.generationId === right?.generationId &&
    left?.manifestSha256 === right?.manifestSha256 &&
    left?.entrypointRelativePath === right?.entrypointRelativePath
  );
}

function assertSelection(selection: UpdateGenerationSelection): void {
  if (
    selection.formatVersion !== 1 ||
    !/^[a-f0-9]{32}$/u.test(selection.generationId) ||
    !SHA256.test(selection.manifestSha256) ||
    !selection.entrypointRelativePath
  ) {
    throw new TypeError("Invalid update generation selection");
  }
}

function assertReceiptFollowsLatest(
  projection: UpdateGenerationProjection,
  receipt: UpdateGenerationTransactionReceipt,
): void {
  if (receipt.kind === "failure") {
    if (["completion", "rolled-back", "cleanup-completed"].includes(projection.latest.kind)) {
      throw new Error(`Failure cannot follow terminal ${projection.latest.kind} receipt`);
    }
    return;
  }
  const latest = projection.latestTransition;
  const follows =
    (latest.kind === "intent" &&
      receipt.kind === "generation-materialization-intent" &&
      receipt.role === (latest.stableBindingAlreadyVerified ? "candidate" : "previous")) ||
    (latest.kind === "generation-materialization-intent" &&
      receipt.kind === "generation-materialized" &&
      receipt.role === latest.role) ||
    (latest.kind === "generation-materialized" &&
      ((latest.role === "previous" && receipt.kind === "baseline-selection-intent") ||
        (latest.role === "candidate" && receipt.kind === "candidate-selection-intent"))) ||
    (latest.kind === "baseline-selection-intent" && receipt.kind === "baseline-selected") ||
    (latest.kind === "baseline-selected" && receipt.kind === "binding-intent") ||
    (latest.kind === "binding-intent" && receipt.kind === "binding-completed") ||
    (latest.kind === "binding-completed" &&
      receipt.kind === "generation-materialization-intent" &&
      receipt.role === "candidate") ||
    (latest.kind === "candidate-selection-intent" && receipt.kind === "candidate-selected") ||
    (latest.kind === "candidate-selected" &&
      (receipt.kind === "completion" || receipt.kind === "rollback-intent")) ||
    (latest.kind === "rollback-intent" && receipt.kind === "rolled-back") ||
    ((latest.kind === "completion" || latest.kind === "rolled-back") &&
      receipt.kind === "cleanup-intent") ||
    (latest.kind === "cleanup-intent" && receipt.kind === "cleanup-completed");
  if (!follows) {
    throw new Error(`Update generation ${receipt.kind} cannot follow ${latest.kind}`);
  }
}

function assertReceiptTransition(
  record: UpdateGenerationTransactionRecord | null,
  receipt: UpdateGenerationTransactionReceipt,
): void {
  assertReceiptIdentity(receipt);
  if (!record) {
    if (receipt.kind !== "intent" || receipt.sequence !== 0) {
      throw new Error("An update generation transaction must start with intent sequence 0");
    }
    if (receipt.stableBindingAlreadyVerified && !receipt.previousSelection) {
      throw new Error("A verified stable binding requires a previous generation selection");
    }
    if (receipt.previousSelection) {
      assertSelection(receipt.previousSelection);
    }
    return;
  }
  if (
    record.transactionId !== receipt.transactionId ||
    record.namespaceKey !== projectUpdateGenerationTransaction(record).intent.namespaceKey
  ) {
    throw new Error("Update generation receipt does not belong to this transaction");
  }
  if (receipt.sequence !== record.receipts.length) {
    throw new Error(`Expected update generation receipt sequence ${record.receipts.length}`);
  }
  if (receipt.kind === "intent") {
    throw new Error("Update generation intent cannot be appended twice");
  }
  const projection = projectUpdateGenerationTransaction(record);
  assertReceiptFollowsLatest(projection, receipt);
  if (projection.cleanupCompleted) {
    throw new Error("Cannot append to a cleaned update generation transaction");
  }
  if (receipt.kind === "generation-materialized") {
    const planned = projection.materializationIntents[receipt.role];
    if (!planned || planned.generationId !== receipt.generation.generationId) {
      throw new Error(`No matching ${receipt.role} generation materialization intent`);
    }
    assertSelection(receipt.generation);
    if (
      planned.manifest.digest !== receipt.generation.manifestSha256 ||
      planned.entrypointRelativePath !== receipt.generation.entrypointRelativePath ||
      planned.packageVersion !== receipt.generation.packageVersion
    ) {
      throw new Error(`${receipt.role} generation descriptor does not match its intent`);
    }
  }
  if (receipt.kind === "baseline-selection-intent") {
    const previous = projection.generations.previous;
    if (!previous || !selectionsEqual(previous, receipt.selection)) {
      throw new Error("Baseline selection must select the materialized previous generation");
    }
  }
  if (receipt.kind === "baseline-selected") {
    const pending = [...record.receipts]
      .toReversed()
      .find((entry) => entry.kind === "baseline-selection-intent");
    if (!pending || pending.kind !== "baseline-selection-intent") {
      throw new Error("Baseline selection has no durable intent");
    }
    if (!selectionsEqual(pending.selection, receipt.selection)) {
      throw new Error("Baseline selection receipt differs from its intent");
    }
  }
  if (receipt.kind === "binding-completed") {
    const pending = [...record.receipts]
      .toReversed()
      .find((entry) => entry.kind === "binding-intent");
    const completedBindings = receipt.bindings.map(
      ({ fingerprint: _fingerprint, ...binding }) => binding,
    );
    if (
      !pending ||
      pending.kind !== "binding-intent" ||
      !isDeepStrictEqual(pending.bindings, completedBindings)
    ) {
      throw new Error("Binding completion differs from its durable intent");
    }
  }
  if (receipt.kind === "binding-intent") {
    const identities = receipt.bindings.map((binding) => `${binding.kind}:${binding.identity}`);
    if (identities.length === 0 || new Set(identities).size !== identities.length) {
      throw new Error("Binding intent must name distinct managed bindings");
    }
  }
  if (receipt.kind === "candidate-selection-intent") {
    const candidate = projection.generations.candidate;
    const baseline = projection.baselineSelection ?? projection.intent.previousSelection;
    if (!candidate || !baseline || !selectionsEqual(candidate, receipt.to)) {
      throw new Error("Candidate selection requires durable previous and candidate generations");
    }
    if (!selectionsEqual(baseline, receipt.from) || !projection.bindingCompleted) {
      throw new Error("Candidate selection requires a verified stable binding");
    }
  }
  if (receipt.kind === "candidate-selected") {
    const pending = [...record.receipts]
      .toReversed()
      .find((entry) => entry.kind === "candidate-selection-intent");
    if (
      !pending ||
      pending.kind !== "candidate-selection-intent" ||
      !selectionsEqual(pending.to, receipt.selection)
    ) {
      throw new Error("Candidate selection receipt differs from its intent");
    }
  }
  if (receipt.kind === "completion") {
    const candidate = projection.generations.candidate;
    if (!projection.candidateSelection || !candidate) {
      throw new Error("Completion requires a selected candidate generation");
    }
    if (
      receipt.packageVersion !== candidate.packageVersion ||
      receipt.launcherVersion !== candidate.packageVersion ||
      receipt.serviceRunning !== projection.intent.serviceBefore.running
    ) {
      throw new Error("Completion does not prove candidate and service convergence");
    }
  }
  if (receipt.kind === "rollback-intent") {
    const previous = projection.baselineSelection ?? projection.intent.previousSelection;
    const candidate = projection.candidateSelection ?? projection.generations.candidate;
    if (!previous || !candidate) {
      throw new Error("Rollback requires durable previous and candidate generations");
    }
    if (!selectionsEqual(candidate, receipt.from) || !selectionsEqual(previous, receipt.to)) {
      throw new Error("Rollback intent does not match the durable generation pair");
    }
  }
  if (receipt.kind === "rolled-back") {
    const pending = [...record.receipts]
      .toReversed()
      .find((entry) => entry.kind === "rollback-intent");
    if (!pending || pending.kind !== "rollback-intent") {
      throw new Error("Rollback completion has no durable intent");
    }
    if (!selectionsEqual(pending.to, receipt.selection)) {
      throw new Error("Rollback completion differs from its intent");
    }
    if (receipt.serviceRunning !== projection.intent.serviceBefore.running) {
      throw new Error("Rollback completion does not restore the prior service intent");
    }
  }
  if (receipt.kind === "cleanup-intent") {
    const protectedIds = new Set(receipt.protectedGenerationIds);
    if (
      protectedIds.size !== receipt.protectedGenerationIds.length ||
      new Set(receipt.generationIds).size !== receipt.generationIds.length
    ) {
      throw new Error("Cleanup intent contains duplicate generation ids");
    }
    const requiredProtectedIds = [
      projection.baselineSelection?.generationId,
      projection.candidateSelection?.generationId ?? projection.generations.candidate?.generationId,
    ].filter((generationId): generationId is string => Boolean(generationId));
    if (requiredProtectedIds.some((generationId) => !protectedIds.has(generationId))) {
      throw new Error("Cleanup must protect the durable active and rollback generations");
    }
    if (receipt.generationIds.some((generationId) => protectedIds.has(generationId))) {
      throw new Error("Cleanup cannot include a protected generation");
    }
  }
  if (receipt.kind === "cleanup-completed") {
    const pending = [...record.receipts]
      .toReversed()
      .find((entry) => entry.kind === "cleanup-intent");
    const removedIds = receipt.removedGenerationIds;
    const deferredIds = receipt.deferred.map((entry) => entry.generationId);
    const completedIds = [...removedIds, ...deferredIds];
    if (
      !pending ||
      pending.kind !== "cleanup-intent" ||
      new Set(completedIds).size !== completedIds.length ||
      !isDeepStrictEqual(completedIds.toSorted(), pending.generationIds.toSorted())
    ) {
      throw new Error("Cleanup completion differs from its durable intent");
    }
  }
}

export function appendUpdateGenerationReceipt(
  record: UpdateGenerationTransactionRecord | null,
  receipt: UpdateGenerationTransactionReceipt,
): UpdateGenerationTransactionRecord {
  assertReceiptTransition(record, receipt);
  if (!record) {
    if (receipt.kind !== "intent") {
      throw new Error("Unreachable update generation receipt state");
    }
    return {
      formatVersion: 1,
      transactionId: receipt.transactionId,
      namespaceKey: receipt.namespaceKey,
      receipts: [structuredClone(receipt)],
    };
  }
  return {
    ...record,
    receipts: [...record.receipts, structuredClone(receipt)],
  };
}

export async function persistUpdateGenerationReceipt(params: {
  ledger: UpdateGenerationLedgerHook;
  snapshot: UpdateGenerationTransactionSnapshot | null;
  receipt: UpdateGenerationTransactionReceipt;
}): Promise<UpdateGenerationTransactionSnapshot> {
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
  const nextRecord = appendUpdateGenerationReceipt(params.snapshot?.record ?? null, params.receipt);
  const result = await params.ledger.compareAndSwap({
    namespaceKey: nextRecord.namespaceKey,
    expectedRevision: params.snapshot?.revision ?? null,
    receipt: params.receipt,
    nextRecord,
  });
  if (result.status === "conflict") {
    throw new Error("Authoritative update ledger revision changed during generation transaction");
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

export function projectUpdateGenerationTransaction(
  record: UpdateGenerationTransactionRecord,
): UpdateGenerationProjection {
  const intent = record.receipts[0];
  if (!intent || intent.kind !== "intent") {
    throw new TypeError("Update generation transaction is missing its intent receipt");
  }
  const projection: UpdateGenerationProjection = {
    intent,
    latest: intent,
    latestTransition: intent,
    materializationIntents: {},
    generations: {},
    baselineSelection: intent.previousSelection,
    bindingCompleted: intent.stableBindingAlreadyVerified,
    candidateSelection: null,
    completed: false,
    rolledBack: false,
    cleanupCompleted: false,
  };
  for (const receipt of record.receipts.slice(1)) {
    projection.latest = receipt;
    if (receipt.kind !== "failure") {
      projection.latestTransition = receipt;
    }
    if (receipt.kind === "generation-materialization-intent") {
      projection.materializationIntents[receipt.role] = receipt;
    } else if (receipt.kind === "generation-materialized") {
      projection.generations[receipt.role] = receipt.generation;
    } else if (receipt.kind === "baseline-selected") {
      projection.baselineSelection = receipt.selection;
    } else if (receipt.kind === "binding-completed") {
      projection.bindingCompleted = true;
    } else if (receipt.kind === "candidate-selected") {
      projection.candidateSelection = receipt.selection;
    } else if (receipt.kind === "completion") {
      projection.completed = true;
    } else if (receipt.kind === "rolled-back") {
      projection.rolledBack = true;
    } else if (receipt.kind === "cleanup-completed") {
      projection.cleanupCompleted = true;
    }
  }
  return projection;
}
