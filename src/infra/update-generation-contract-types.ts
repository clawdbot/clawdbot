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

export type UpdateGenerationBrokerOperationKind =
  | "materialize-generation"
  | "sync-parent-directory"
  | "switch-selector"
  | "cleanup-generations"
  | "verify-retained-pair"
  | "observe-recovery";

type UpdateGenerationBrokerRequestBase<Kind extends UpdateGenerationBrokerOperationKind> = {
  formatVersion: 1;
  kind: Kind;
  brokerId: string;
  namespaceKey: string;
  transactionId: string;
  operationId: string;
  expectedRevision: string | null;
};

export type UpdateGenerationBrokerRequest =
  | (UpdateGenerationBrokerRequestBase<"materialize-generation"> & {
      role: "previous" | "candidate";
      sourceArtifactId: string;
      manifest: UpdateGenerationManifest;
      generation: UpdateGenerationDescriptor;
    })
  | (UpdateGenerationBrokerRequestBase<"sync-parent-directory"> & {
      parent: "generations" | "selector";
      afterOperationId: string;
    })
  | (UpdateGenerationBrokerRequestBase<"switch-selector"> & {
      expected: UpdateGenerationSelection | null;
      next: UpdateGenerationSelection;
    })
  | (UpdateGenerationBrokerRequestBase<"cleanup-generations"> & {
      generationIds: string[];
      protectedGenerationIds: string[];
    })
  | (UpdateGenerationBrokerRequestBase<"verify-retained-pair"> & {
      selected: UpdateGenerationSelection;
      rollback: UpdateGenerationSelection;
    })
  | UpdateGenerationBrokerRequestBase<"observe-recovery">;

export type UpdateGenerationBrokerSignature = {
  algorithm: "ed25519";
  keyId: string;
  signedPayloadSha256: string;
  valueBase64: string;
};

export type UpdateGenerationObservedGeneration = {
  generationId: string;
  manifestSha256: string;
  parentDirectoryDurable: boolean;
};

export type UpdateGenerationRetainedPair = {
  selected: UpdateGenerationSelection;
  rollback: UpdateGenerationSelection;
  selectedManifestVerified: true;
  rollbackManifestVerified: true;
};

type UpdateGenerationBrokerReceiptBase<Kind extends UpdateGenerationBrokerOperationKind> = {
  formatVersion: 1;
  kind: Kind;
  brokerId: string;
  namespaceKey: string;
  transactionId: string;
  operationId: string;
  requestSha256: string;
  previousRevision: string | null;
  revision: string | null;
  recordedAtMs: number;
  signature: UpdateGenerationBrokerSignature;
};

export type UpdateGenerationBrokerReceipt =
  | (UpdateGenerationBrokerReceiptBase<"materialize-generation"> & {
      role: "previous" | "candidate";
      sourceArtifactId: string;
      manifest: UpdateGenerationManifest;
      generation: UpdateGenerationDescriptor;
    })
  | (UpdateGenerationBrokerReceiptBase<"sync-parent-directory"> & {
      parent: "generations" | "selector";
      afterOperationId: string;
      durable: true;
    })
  | (UpdateGenerationBrokerReceiptBase<"switch-selector"> & {
      previous: UpdateGenerationSelection | null;
      selected: UpdateGenerationSelection;
    })
  | (UpdateGenerationBrokerReceiptBase<"cleanup-generations"> & {
      generationIds: string[];
      removedGenerationIds: string[];
      deferred: Array<{ generationId: string; reason: string }>;
      protectedGenerationIds: string[];
    })
  | (UpdateGenerationBrokerReceiptBase<"verify-retained-pair"> & {
      retainedPair: UpdateGenerationRetainedPair;
    })
  | (UpdateGenerationBrokerReceiptBase<"observe-recovery"> & {
      selector: UpdateGenerationSelection | null;
      selectorDurable: boolean;
      generations: UpdateGenerationObservedGeneration[];
      retainedPair: UpdateGenerationRetainedPair | null;
    });

export type UpdateGenerationBrokerReceiptOf<Kind extends UpdateGenerationBrokerOperationKind> =
  Extract<UpdateGenerationBrokerReceipt, { kind: Kind }>;

declare const authenticatedBrokerReceipt: unique symbol;
export type UpdateGenerationAuthenticatedBrokerReceiptOf<
  Kind extends UpdateGenerationBrokerOperationKind,
> = UpdateGenerationBrokerReceiptOf<Kind> & {
  readonly [authenticatedBrokerReceipt]: true;
};

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
