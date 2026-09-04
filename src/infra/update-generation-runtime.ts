/** Canonical operation bundle consumed by generation-aware package executors. */
import {
  digestUpdateGenerationBrokerReceiptPayload,
  digestUpdateGenerationBrokerRequest,
  performUpdateGenerationBrokerOperation,
  UpdateGenerationConfinedFilesystem,
  type UpdateGenerationBrokerSignature,
  type UpdateGenerationObservedGeneration,
  type UpdateGenerationRetainedPair,
} from "./update-generation-confined-filesystem.js";
import { parseUpdateGenerationTransactionRecord } from "./update-generation-contract-parser.js";
import { updateGenerationSelectionSchema } from "./update-generation-contract-schema.js";
import {
  buildUpdateGenerationReceiptId,
  pendingUpdateGenerationBrokerMutationKind,
  type UpdateGenerationDescriptor,
  type UpdateGenerationManifest,
  type UpdateGenerationRole,
  type UpdateGenerationServiceIntent,
} from "./update-generation-contract.js";
import {
  authenticateUpdateGenerationTransactionRecord,
  persistUpdateGenerationReceipt,
  type UpdateGenerationLedgerCompareAndSwapResult,
  type UpdateGenerationTransactionSnapshot,
} from "./update-generation-ledger-hook.js";
import {
  adjudicateUpdateGenerationTransaction,
  reconcilePendingUpdateGenerationBrokerMutation,
  type UpdateGenerationReconciledBrokerMutation,
  type UpdateGenerationRecoveryAction,
  type UpdateGenerationRecoveryDecision,
  type UpdateGenerationRuntimeObservation,
} from "./update-generation-recovery.js";

type UpdateGenerationRuntimeTypes = Readonly<{
  brokerSignature: UpdateGenerationBrokerSignature;
  observedGeneration: UpdateGenerationObservedGeneration;
  retainedPair: UpdateGenerationRetainedPair;
  descriptor: UpdateGenerationDescriptor;
  manifest: UpdateGenerationManifest;
  role: UpdateGenerationRole;
  serviceIntent: UpdateGenerationServiceIntent;
  compareAndSwapResult: UpdateGenerationLedgerCompareAndSwapResult;
  snapshot: UpdateGenerationTransactionSnapshot;
  reconciledBrokerMutation: UpdateGenerationReconciledBrokerMutation;
  recoveryAction: UpdateGenerationRecoveryAction;
  recoveryDecision: UpdateGenerationRecoveryDecision;
  runtimeObservation: UpdateGenerationRuntimeObservation;
}>;

declare const updateGenerationRuntimeTypes: unique symbol;

export type UpdateGenerationRuntime = Readonly<{
  ConfinedFilesystem: typeof UpdateGenerationConfinedFilesystem;
  digestBrokerReceiptPayload: typeof digestUpdateGenerationBrokerReceiptPayload;
  digestBrokerRequest: typeof digestUpdateGenerationBrokerRequest;
  performBrokerOperation: typeof performUpdateGenerationBrokerOperation;
  parseTransactionRecord: typeof parseUpdateGenerationTransactionRecord;
  selectionSchema: typeof updateGenerationSelectionSchema;
  buildReceiptId: typeof buildUpdateGenerationReceiptId;
  pendingBrokerMutationKind: typeof pendingUpdateGenerationBrokerMutationKind;
  authenticateTransactionRecord: typeof authenticateUpdateGenerationTransactionRecord;
  persistReceipt: typeof persistUpdateGenerationReceipt;
  adjudicateTransaction: typeof adjudicateUpdateGenerationTransaction;
  reconcilePendingBrokerMutation: typeof reconcilePendingUpdateGenerationBrokerMutation;
  readonly [updateGenerationRuntimeTypes]?: UpdateGenerationRuntimeTypes;
}>;

export const UPDATE_GENERATION_RUNTIME: UpdateGenerationRuntime = Object.freeze({
  ConfinedFilesystem: UpdateGenerationConfinedFilesystem,
  digestBrokerReceiptPayload: digestUpdateGenerationBrokerReceiptPayload,
  digestBrokerRequest: digestUpdateGenerationBrokerRequest,
  performBrokerOperation: performUpdateGenerationBrokerOperation,
  parseTransactionRecord: parseUpdateGenerationTransactionRecord,
  selectionSchema: updateGenerationSelectionSchema,
  buildReceiptId: buildUpdateGenerationReceiptId,
  pendingBrokerMutationKind: pendingUpdateGenerationBrokerMutationKind,
  authenticateTransactionRecord: authenticateUpdateGenerationTransactionRecord,
  persistReceipt: persistUpdateGenerationReceipt,
  adjudicateTransaction: adjudicateUpdateGenerationTransaction,
  reconcilePendingBrokerMutation: reconcilePendingUpdateGenerationBrokerMutation,
});
