import type { UpdateGenerationBrokerReceiptOf } from "./update-generation-confined-filesystem.js";

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

export type UpdateGenerationDescriptor = UpdateGenerationSelection & { packageVersion: string };

export type UpdateGenerationServiceIntent = {
  managed: boolean;
  running: boolean;
  enabled?: boolean;
};

type UpdateGenerationBinding = {
  kind: "launcher" | "service";
  identity: string;
  priorFingerprint: string | null;
};

export type UpdateGenerationMaterializationEvidence = {
  materialization: UpdateGenerationBrokerReceiptOf<"materialize-generation">;
  parentDirectorySync: UpdateGenerationBrokerReceiptOf<"sync-parent-directory">;
};

export type UpdateGenerationSelectionEvidence = {
  selectorSwitch: UpdateGenerationBrokerReceiptOf<"switch-selector">;
  parentDirectorySync: UpdateGenerationBrokerReceiptOf<"sync-parent-directory">;
};

export type UpdateGenerationRetainedPairEvidence = {
  retainedPair: UpdateGenerationBrokerReceiptOf<"verify-retained-pair">;
  recoveryObservation: UpdateGenerationBrokerReceiptOf<"observe-recovery">;
};

export type UpdateGenerationFailureAdjudicationEvidence = {
  recoveryObservation: UpdateGenerationBrokerReceiptOf<"observe-recovery">;
};

export type UpdateGenerationCleanupEvidence = {
  cleanup: UpdateGenerationBrokerReceiptOf<"cleanup-generations">;
  parentDirectorySync: UpdateGenerationBrokerReceiptOf<"sync-parent-directory">;
  retainedPair: UpdateGenerationBrokerReceiptOf<"verify-retained-pair">;
  recoveryObservation: UpdateGenerationBrokerReceiptOf<"observe-recovery">;
};

type UpdateGenerationReceiptBase = {
  formatVersion: 2;
  transactionId: string;
  sequence: number;
  receiptId: string;
  recordedAtMs: number;
};

export type UpdateGenerationTransactionReceipt =
  | (UpdateGenerationReceiptBase & {
      kind: "intent";
      namespaceKey: string;
      serviceBefore: UpdateGenerationServiceIntent;
      previousSelection: UpdateGenerationSelection | null;
      previousPackageVersion: string | null;
      stableBindingAlreadyVerified: boolean;
      brokerId: string;
      brokerRevision: string | null;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "generation-materialization-intent";
      role: UpdateGenerationRole;
      sourceArtifactId: string;
      generationId: string;
      manifest: UpdateGenerationManifest;
      packageVersion: string;
      entrypointRelativePath: string;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "generation-materialized";
      role: UpdateGenerationRole;
      generation: UpdateGenerationDescriptor;
      evidence: UpdateGenerationMaterializationEvidence;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "baseline-selection-intent";
      selection: UpdateGenerationSelection;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "baseline-selected";
      selection: UpdateGenerationSelection;
      evidence: UpdateGenerationSelectionEvidence;
    })
  | (UpdateGenerationReceiptBase & { kind: "binding-intent"; bindings: UpdateGenerationBinding[] })
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
      evidence: UpdateGenerationSelectionEvidence & UpdateGenerationRetainedPairEvidence;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "completion";
      packageVersion: string;
      launcherVersion: string;
      serviceRunning: boolean;
      serviceEnabled?: boolean;
      evidence: UpdateGenerationRetainedPairEvidence;
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
      serviceEnabled?: boolean;
      evidence: UpdateGenerationSelectionEvidence & UpdateGenerationRetainedPairEvidence;
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
      evidence: UpdateGenerationCleanupEvidence;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "failure";
      operation: string;
      reason: string;
      serviceRestored: boolean;
    })
  | (UpdateGenerationReceiptBase & {
      kind: "failure-adjudicated";
      failedReceiptId: string;
      resumeFromReceiptId: string;
      evidence: UpdateGenerationFailureAdjudicationEvidence;
    });

export type UpdateGenerationTransactionRecord = {
  formatVersion: 2;
  transactionId: string;
  namespaceKey: string;
  receipts: UpdateGenerationTransactionReceipt[];
};

export type UpdateGenerationProjection = {
  intent: Extract<UpdateGenerationTransactionReceipt, { kind: "intent" }>;
  latest: UpdateGenerationTransactionReceipt;
  latestTransition: Exclude<
    UpdateGenerationTransactionReceipt,
    { kind: "failure" | "failure-adjudicated" }
  >;
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
  terminalServiceState: { running: boolean; enabled?: boolean } | null;
  brokerOperationIds: Set<string>;
  brokerRevision: string | null;
};
