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

export type UpdateGenerationPhysicalState = {
  selector: UpdateGenerationSelection | null;
  generations: Array<{ generationId: string; manifestSha256: string }>;
  bindingConverged: boolean;
};

export type UpdateGenerationRecoveryAction =
  | "resume-materialization"
  | "record-materialized"
  | "persist-baseline-selection-intent"
  | "select-baseline"
  | "record-baseline-selected"
  | "persist-binding-intent"
  | "resume-binding"
  | "record-binding-completed"
  | "persist-candidate-selection-intent"
  | "select-candidate"
  | "record-candidate-selected"
  | "verify-completion"
  | "select-previous"
  | "record-rolled-back"
  | "resume-cleanup"
  | "complete"
  | "adjudicate-failure"
  | "inconsistent";

export type UpdateGenerationRecoveryDecision = {
  action: UpdateGenerationRecoveryAction;
  reason: string;
  role?: UpdateGenerationRole;
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

function assertReceiptTransition(
  record: UpdateGenerationTransactionRecord | null,
  receipt: UpdateGenerationTransactionReceipt,
): void {
  assertReceiptIdentity(receipt);
  if (!record) {
    if (receipt.kind !== "intent" || receipt.sequence !== 0) {
      throw new Error("An update generation transaction must start with intent sequence 0");
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
  if (projection.cleanupCompleted) {
    throw new Error("Cannot append to a cleaned update generation transaction");
  }
  if (receipt.kind === "generation-materialized") {
    const planned = projection.materializationIntents[receipt.role];
    if (!planned || planned.generationId !== receipt.generation.generationId) {
      throw new Error(`No matching ${receipt.role} generation materialization intent`);
    }
    assertSelection(receipt.generation);
    if (planned.manifest.digest !== receipt.generation.manifestSha256) {
      throw new Error(`${receipt.role} generation manifest does not match its intent`);
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
    if (!projection.candidateSelection) {
      throw new Error("Completion requires a selected candidate generation");
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
  }
  if (receipt.kind === "cleanup-intent") {
    const protectedIds = new Set(receipt.protectedGenerationIds);
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

function observedGenerationMatches(
  state: UpdateGenerationPhysicalState,
  generationId: string,
  manifestSha256: string,
): boolean {
  return state.generations.some(
    (generation) =>
      generation.generationId === generationId && generation.manifestSha256 === manifestSha256,
  );
}

export function adjudicateUpdateGenerationTransaction(
  record: UpdateGenerationTransactionRecord,
  physical: UpdateGenerationPhysicalState,
): UpdateGenerationRecoveryDecision {
  const state = projectUpdateGenerationTransaction(record);
  const latest = state.latest;
  if (latest.kind === "cleanup-completed") {
    return { action: "complete", reason: "cleanup receipt is durable" };
  }
  if (latest.kind === "cleanup-intent") {
    const active = physical.selector?.generationId;
    if (active && latest.generationIds.includes(active)) {
      return { action: "inconsistent", reason: "cleanup intent includes the active selector" };
    }
    return { action: "resume-cleanup", reason: "cleanup intent is durable but incomplete" };
  }
  if (latest.kind === "rollback-intent") {
    if (selectionsEqual(physical.selector, latest.to)) {
      return {
        action: "record-rolled-back",
        reason: "selector already names the prior generation",
      };
    }
    if (selectionsEqual(physical.selector, latest.from)) {
      return { action: "select-previous", reason: "rollback intent precedes selector replacement" };
    }
    return { action: "inconsistent", reason: "selector matches neither rollback generation" };
  }
  if (latest.kind === "rolled-back") {
    return selectionsEqual(physical.selector, latest.selection)
      ? { action: "complete", reason: "rollback selection and receipt agree" }
      : { action: "inconsistent", reason: "rolled-back receipt disagrees with selector" };
  }
  if (latest.kind === "failure") {
    return { action: "adjudicate-failure", reason: latest.reason };
  }
  if (latest.kind === "generation-materialization-intent") {
    return observedGenerationMatches(physical, latest.generationId, latest.manifest.digest)
      ? {
          action: "record-materialized",
          role: latest.role,
          reason: "generation exists with the durable intended manifest",
        }
      : {
          action: "resume-materialization",
          role: latest.role,
          reason: "generation materialization intent has no matching generation",
        };
  }
  if (latest.kind === "baseline-selection-intent") {
    return selectionsEqual(physical.selector, latest.selection)
      ? { action: "record-baseline-selected", reason: "baseline selector replacement completed" }
      : { action: "select-baseline", reason: "baseline selector replacement is pending" };
  }
  if (latest.kind === "baseline-selected") {
    return physical.bindingConverged
      ? { action: "record-binding-completed", reason: "stable bindings already converge" }
      : {
          action: "persist-binding-intent",
          reason: "baseline is selected before binding migration",
        };
  }
  if (latest.kind === "binding-intent") {
    return physical.bindingConverged
      ? { action: "record-binding-completed", reason: "stable binding migration completed" }
      : { action: "resume-binding", reason: "stable binding intent is durable but incomplete" };
  }
  if (latest.kind === "candidate-selection-intent") {
    if (selectionsEqual(physical.selector, latest.to)) {
      return {
        action: "record-candidate-selected",
        reason: "candidate selector replacement completed",
      };
    }
    if (selectionsEqual(physical.selector, latest.from)) {
      return { action: "select-candidate", reason: "candidate selector replacement is pending" };
    }
    return { action: "inconsistent", reason: "selector matches neither activation generation" };
  }
  if (latest.kind === "candidate-selected") {
    return selectionsEqual(physical.selector, latest.selection)
      ? {
          action: "verify-completion",
          reason: "candidate is selected but completion is not proven",
        }
      : { action: "inconsistent", reason: "candidate selection receipt disagrees with selector" };
  }
  if (latest.kind === "completion") {
    return state.candidateSelection && selectionsEqual(physical.selector, state.candidateSelection)
      ? { action: "complete", reason: "completion receipt and selector agree" }
      : { action: "inconsistent", reason: "completion receipt disagrees with selector" };
  }
  if (latest.kind === "generation-materialized") {
    return latest.role === "previous"
      ? {
          action: "persist-baseline-selection-intent",
          role: "previous",
          reason: "previous generation is durable and ready for baseline selection",
        }
      : {
          action: "persist-candidate-selection-intent",
          role: "candidate",
          reason: "candidate generation is durable and ready for selection",
        };
  }
  if (latest.kind === "binding-completed") {
    return {
      action: "resume-materialization",
      role: "candidate",
      reason: "candidate is not ready",
    };
  }
  return {
    action: "resume-materialization",
    role: "previous",
    reason: "transaction intent is durable",
  };
}
