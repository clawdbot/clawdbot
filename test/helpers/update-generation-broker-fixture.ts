import type {
  UpdateGenerationAuthenticatedBrokerReceiptOf,
  UpdateGenerationBrokerReceipt,
  UpdateGenerationBrokerRequest,
  UpdateGenerationBrokerSignature,
  UpdateGenerationRetainedPair,
} from "../../src/infra/update-generation-confined-filesystem.js";
import {
  assertUpdateGenerationBrokerReceiptIsValid,
  buildUpdateGenerationBrokerOperationId,
  digestUpdateGenerationBrokerReceiptPayload,
  digestUpdateGenerationBrokerRequest,
  UpdateGenerationConfinedFilesystem,
} from "../../src/infra/update-generation-confined-filesystem.js";
import {
  projectUpdateGenerationTransaction,
  type UpdateGenerationSelection,
  type UpdateGenerationTransactionReceipt,
  type UpdateGenerationTransactionRecord,
} from "../../src/infra/update-generation-contract.js";

const TEST_SIGNATURE = Buffer.alloc(64, 7).toString("base64");
let recoveryOperationSequence = 0;

type WithoutSignature<Receipt> = Receipt extends unknown ? Omit<Receipt, "signature"> : never;
type ReceiptWithoutSignature = WithoutSignature<UpdateGenerationBrokerReceipt>;

function signedReceipt(receipt: object): UpdateGenerationBrokerReceipt {
  const signature = {
    algorithm: "ed25519" as const,
    keyId: "test-key",
    signedPayloadSha256: "0".repeat(64),
    valueBase64: TEST_SIGNATURE,
  } satisfies UpdateGenerationBrokerSignature;
  const placeholder = {
    ...receipt,
    signature,
  };
  const signed: unknown = {
    ...receipt,
    signature: {
      ...signature,
      signedPayloadSha256: digestUpdateGenerationBrokerReceiptPayload(placeholder),
    },
  };
  assertUpdateGenerationBrokerReceiptIsValid(signed);
  return signed;
}

function retainedPair(
  selected: UpdateGenerationSelection,
  rollback: UpdateGenerationSelection,
): UpdateGenerationRetainedPair {
  return {
    selected: selectionOnly(selected),
    rollback: selectionOnly(rollback),
    selectedManifestVerified: true,
    rollbackManifestVerified: true,
  };
}

function selectionOnly(selection: UpdateGenerationSelection): UpdateGenerationSelection {
  return {
    formatVersion: selection.formatVersion,
    generationId: selection.generationId,
    manifestSha256: selection.manifestSha256,
    entrypointRelativePath: selection.entrypointRelativePath,
  };
}

class TestConfinedFilesystem extends UpdateGenerationConfinedFilesystem {
  readonly brokerId: string;
  readonly namespaceKey: string;

  constructor(
    private readonly receipt: UpdateGenerationBrokerReceipt | null = null,
    private readonly signatureValid = true,
  ) {
    super();
    this.brokerId = receipt?.brokerId ?? "test-broker";
    this.namespaceKey = receipt?.namespaceKey ?? "openclaw-global-owner";
  }

  protected async invokeBroker(): Promise<UpdateGenerationBrokerReceipt> {
    if (!this.receipt) {
      throw new Error("test authentication-only provider cannot execute operations");
    }
    return this.receipt;
  }

  protected async verifyBrokerSignature(): Promise<boolean> {
    return this.signatureValid;
  }
}

export function createTestConfinedFilesystemForAuthentication(
  signatureValid = true,
): UpdateGenerationConfinedFilesystem {
  return new TestConfinedFilesystem(null, signatureValid);
}

class TestReplayableConfinedFilesystem extends UpdateGenerationConfinedFilesystem {
  readonly brokerId = "test-broker";
  readonly namespaceKey = "openclaw-global-owner";
  readonly #completed = new Map<
    string,
    { requestSha256: string; receipt: UpdateGenerationBrokerReceipt }
  >();
  #revision: string | null;
  #mutationCount: number;

  constructor() {
    super();
    this.#revision = null;
    this.#mutationCount = 0;
  }

  get mutationCount(): number {
    return this.#mutationCount;
  }

  protected async invokeBroker(
    request: UpdateGenerationBrokerRequest,
  ): Promise<UpdateGenerationBrokerReceipt> {
    const requestSha256 = digestUpdateGenerationBrokerRequest(request);
    const completed = this.#completed.get(request.operationId);
    if (completed) {
      if (completed.requestSha256 !== requestSha256) {
        throw new Error("broker operation id was replayed with a different request");
      }
      return structuredClone(completed.receipt);
    }
    if (request.expectedRevision !== this.#revision) {
      throw new Error("broker namespace revision changed before new work");
    }
    const nextRevision = `${request.operationId}:revision`;
    let unsigned: ReceiptWithoutSignature;
    if (request.kind === "materialize-generation") {
      unsigned = {
        formatVersion: 1,
        kind: request.kind,
        brokerId: request.brokerId,
        namespaceKey: request.namespaceKey,
        transactionId: request.transactionId,
        operationId: request.operationId,
        requestSha256,
        previousRevision: request.expectedRevision,
        revision: nextRevision,
        recordedAtMs: 1_788_300_800_000 + this.#mutationCount,
        role: request.role,
        sourceArtifactId: request.sourceArtifactId,
        manifest: request.manifest,
        generation: request.generation,
      };
    } else if (request.kind === "sync-parent-directory") {
      unsigned = {
        formatVersion: 1,
        kind: request.kind,
        brokerId: request.brokerId,
        namespaceKey: request.namespaceKey,
        transactionId: request.transactionId,
        operationId: request.operationId,
        requestSha256,
        previousRevision: request.expectedRevision,
        revision: nextRevision,
        recordedAtMs: 1_788_300_800_000 + this.#mutationCount,
        parent: request.parent,
        afterOperationId: request.afterOperationId,
        durable: true,
      };
    } else {
      throw new Error(`test replay broker does not implement ${request.kind}`);
    }
    const receipt = signedReceipt(unsigned);
    this.#revision = nextRevision;
    this.#mutationCount += 1;
    this.#completed.set(request.operationId, { requestSha256, receipt });
    return structuredClone(receipt);
  }

  protected async verifyBrokerSignature(): Promise<boolean> {
    return true;
  }
}

export function createTestReplayableConfinedFilesystem(): {
  filesystem: UpdateGenerationConfinedFilesystem;
  mutationCount: () => number;
} {
  const filesystem = new TestReplayableConfinedFilesystem();
  return {
    filesystem,
    mutationCount: () => filesystem.mutationCount,
  };
}

export type TestUpdateGenerationRecoveryState = {
  selector: UpdateGenerationSelection | null;
  selectorDurable: boolean;
  generations: Array<{
    generationId: string;
    manifestSha256: string;
    parentDirectoryDurable?: boolean;
  }>;
  bindingConverged: boolean;
  serviceState?: { running: boolean; enabled?: boolean } | null;
};

export async function authenticateTestRecoveryObservation(params: {
  record: UpdateGenerationTransactionRecord;
  physical: TestUpdateGenerationRecoveryState;
  identityOverrides?: Partial<
    Pick<
      Extract<UpdateGenerationBrokerRequest, { kind: "observe-recovery" }>,
      "brokerId" | "namespaceKey" | "transactionId" | "operationId" | "expectedRevision"
    >
  >;
}): Promise<{
  filesystem: UpdateGenerationConfinedFilesystem;
  observation: UpdateGenerationAuthenticatedBrokerReceiptOf<"observe-recovery">;
  runtime: {
    bindingConverged: boolean;
    serviceState: { running: boolean; enabled?: boolean } | null;
  };
}> {
  const state = projectUpdateGenerationTransaction(params.record);
  const operationId = `test-recovery-observation:${recoveryOperationSequence++}`;
  const request: Extract<UpdateGenerationBrokerRequest, { kind: "observe-recovery" }> = {
    formatVersion: 1,
    kind: "observe-recovery",
    brokerId: state.intent.brokerId,
    namespaceKey: state.intent.namespaceKey,
    transactionId: state.intent.transactionId,
    operationId,
    expectedRevision: state.brokerRevision,
    ...params.identityOverrides,
  };
  const baseline = state.baselineSelection ?? state.intent.previousSelection;
  const candidate = state.candidateSelection ?? state.generations.candidate;
  const selected = params.physical.selector ? selectionOnly(params.physical.selector) : null;
  const rollback =
    selected && candidate && selected.generationId === candidate.generationId
      ? baseline
      : selected && baseline && selected.generationId === baseline.generationId
        ? candidate
        : null;
  const pair =
    selected &&
    rollback &&
    params.physical.selectorDurable &&
    params.physical.generations.some(
      (generation) =>
        generation.generationId === selected.generationId &&
        generation.parentDirectoryDurable !== false,
    ) &&
    params.physical.generations.some(
      (generation) =>
        generation.generationId === rollback.generationId &&
        generation.parentDirectoryDurable !== false,
    )
      ? retainedPair(selected, rollback)
      : null;
  const unsigned = {
    formatVersion: 1,
    kind: "observe-recovery",
    brokerId: request.brokerId,
    namespaceKey: request.namespaceKey,
    transactionId: request.transactionId,
    operationId,
    requestSha256: digestUpdateGenerationBrokerRequest(request),
    previousRevision: request.expectedRevision,
    revision: request.expectedRevision,
    recordedAtMs: 1_788_300_900_000 + recoveryOperationSequence,
    selector: selected,
    selectorDurable: params.physical.selectorDurable,
    generations: params.physical.generations.map((generation) => ({
      ...generation,
      parentDirectoryDurable: generation.parentDirectoryDurable ?? true,
    })),
    retainedPair: pair,
  } satisfies ReceiptWithoutSignature;
  const receipt = signedReceipt(unsigned);
  if (receipt.kind !== "observe-recovery") {
    throw new Error("test recovery fixture created the wrong receipt kind");
  }
  const filesystem = new TestConfinedFilesystem(receipt);
  return {
    filesystem,
    observation: await filesystem.authenticate(receipt),
    runtime: {
      bindingConverged: params.physical.bindingConverged,
      serviceState: params.physical.serviceState ?? null,
    },
  };
}

export function attachTestBrokerEvidence(
  record: UpdateGenerationTransactionRecord | null,
  receipt: UpdateGenerationTransactionReceipt,
): UpdateGenerationTransactionReceipt {
  if (!record || receipt.kind === "intent") {
    return receipt;
  }
  if ("evidence" in receipt && receipt.evidence) {
    return receipt;
  }
  const state = projectUpdateGenerationTransaction(record);
  let revision = state.brokerRevision;
  const operationIntentReceiptId = (() => {
    if (receipt.kind === "generation-materialized") {
      return state.materializationIntents[receipt.role]?.receiptId ?? receipt.receiptId;
    }
    if (
      receipt.kind === "baseline-selected" ||
      receipt.kind === "candidate-selected" ||
      receipt.kind === "rolled-back" ||
      receipt.kind === "cleanup-completed"
    ) {
      return state.latestTransition.receiptId;
    }
    return receipt.receiptId;
  })();
  const perform = <Request extends UpdateGenerationBrokerRequest>(
    requestFields: Omit<
      Request,
      | "formatVersion"
      | "brokerId"
      | "namespaceKey"
      | "transactionId"
      | "operationId"
      | "expectedRevision"
    >,
    resultFields: Omit<
      Extract<UpdateGenerationBrokerReceipt, { kind: Request["kind"] }>,
      | "formatVersion"
      | "brokerId"
      | "namespaceKey"
      | "transactionId"
      | "operationId"
      | "requestSha256"
      | "previousRevision"
      | "revision"
      | "recordedAtMs"
      | "signature"
    >,
  ): Extract<UpdateGenerationBrokerReceipt, { kind: Request["kind"] }> => {
    const operationId = buildUpdateGenerationBrokerOperationId({
      intentReceiptId: operationIntentReceiptId,
      kind: requestFields.kind,
    });
    const request = {
      formatVersion: 1,
      brokerId: state.intent.brokerId,
      namespaceKey: state.intent.namespaceKey,
      transactionId: state.intent.transactionId,
      operationId,
      expectedRevision: revision,
      ...requestFields,
    } as Request;
    const nextRevision =
      request.kind === "observe-recovery" || request.kind === "verify-retained-pair"
        ? revision
        : `${operationId}:revision`;
    const unsigned = {
      formatVersion: 1,
      brokerId: request.brokerId,
      namespaceKey: request.namespaceKey,
      transactionId: request.transactionId,
      operationId,
      requestSha256: digestUpdateGenerationBrokerRequest(request),
      previousRevision: revision,
      revision: nextRevision,
      recordedAtMs: receipt.recordedAtMs,
      ...resultFields,
    };
    revision = nextRevision;
    const signed = signedReceipt(unsigned);
    if (signed.kind !== request.kind) {
      throw new Error("test broker fixture created the wrong receipt kind");
    }
    return signed as Extract<UpdateGenerationBrokerReceipt, { kind: Request["kind"] }>;
  };

  const syncParent = (parent: "generations" | "selector", afterOperationId: string) =>
    perform<Extract<UpdateGenerationBrokerRequest, { kind: "sync-parent-directory" }>>(
      { kind: "sync-parent-directory", parent, afterOperationId },
      { kind: "sync-parent-directory", parent, afterOperationId, durable: true },
    );
  const pairEvidence = (
    selected: UpdateGenerationSelection,
    rollback: UpdateGenerationSelection,
  ) => {
    const selectedSelection = selectionOnly(selected);
    const rollbackSelection = selectionOnly(rollback);
    const pair = retainedPair(selectedSelection, rollbackSelection);
    const retained = perform<
      Extract<UpdateGenerationBrokerRequest, { kind: "verify-retained-pair" }>
    >(
      {
        kind: "verify-retained-pair",
        selected: selectedSelection,
        rollback: rollbackSelection,
      },
      { kind: "verify-retained-pair", retainedPair: pair },
    );
    const recoveryObservation = perform<
      Extract<UpdateGenerationBrokerRequest, { kind: "observe-recovery" }>
    >(
      { kind: "observe-recovery" },
      {
        kind: "observe-recovery",
        selector: selectedSelection,
        selectorDurable: true,
        generations: [selectedSelection, rollbackSelection].map((selection) => ({
          generationId: selection.generationId,
          manifestSha256: selection.manifestSha256,
          parentDirectoryDurable: true,
        })),
        retainedPair: pair,
      },
    );
    return { retainedPair: retained, recoveryObservation };
  };

  if (receipt.kind === "generation-materialized") {
    const planned = state.materializationIntents[receipt.role];
    if (!planned) {
      return receipt;
    }
    const materialization = perform<
      Extract<UpdateGenerationBrokerRequest, { kind: "materialize-generation" }>
    >(
      {
        kind: "materialize-generation",
        role: receipt.role,
        sourceArtifactId: planned.sourceArtifactId,
        manifest: planned.manifest,
        generation: receipt.generation,
      },
      {
        kind: "materialize-generation",
        role: receipt.role,
        sourceArtifactId: planned.sourceArtifactId,
        manifest: planned.manifest,
        generation: receipt.generation,
      },
    );
    return {
      ...receipt,
      evidence: {
        materialization,
        parentDirectorySync: syncParent("generations", materialization.operationId),
      },
    };
  }
  if (receipt.kind === "baseline-selected") {
    const selectorSwitch = perform<
      Extract<UpdateGenerationBrokerRequest, { kind: "switch-selector" }>
    >(
      {
        kind: "switch-selector",
        expected: state.intent.previousSelection,
        next: receipt.selection,
      },
      {
        kind: "switch-selector",
        previous: state.intent.previousSelection,
        selected: receipt.selection,
      },
    );
    return {
      ...receipt,
      evidence: {
        selectorSwitch,
        parentDirectorySync: syncParent("selector", selectorSwitch.operationId),
      },
    };
  }
  if (receipt.kind === "candidate-selected") {
    const pending = state.latestTransition;
    if (pending.kind !== "candidate-selection-intent") {
      return receipt;
    }
    const selectorSwitch = perform<
      Extract<UpdateGenerationBrokerRequest, { kind: "switch-selector" }>
    >(
      { kind: "switch-selector", expected: pending.from, next: pending.to },
      { kind: "switch-selector", previous: pending.from, selected: pending.to },
    );
    return {
      ...receipt,
      evidence: {
        selectorSwitch,
        parentDirectorySync: syncParent("selector", selectorSwitch.operationId),
        ...pairEvidence(pending.to, pending.from),
      },
    };
  }
  if (receipt.kind === "completion") {
    const selected = state.candidateSelection;
    const rollback = state.baselineSelection ?? state.intent.previousSelection;
    return selected && rollback
      ? { ...receipt, evidence: pairEvidence(selected, rollback) }
      : receipt;
  }
  if (receipt.kind === "rolled-back") {
    const pending = state.latestTransition;
    if (pending.kind !== "rollback-intent") {
      return receipt;
    }
    const selectorSwitch = perform<
      Extract<UpdateGenerationBrokerRequest, { kind: "switch-selector" }>
    >(
      { kind: "switch-selector", expected: pending.from, next: pending.to },
      { kind: "switch-selector", previous: pending.from, selected: pending.to },
    );
    return {
      ...receipt,
      evidence: {
        selectorSwitch,
        parentDirectorySync: syncParent("selector", selectorSwitch.operationId),
        ...pairEvidence(pending.to, pending.from),
      },
    };
  }
  if (receipt.kind === "cleanup-completed") {
    const pending = state.latestTransition;
    const selected = state.rolledBack
      ? (state.baselineSelection ?? state.intent.previousSelection)
      : state.candidateSelection;
    const rollback = state.rolledBack
      ? state.candidateSelection
      : (state.baselineSelection ?? state.intent.previousSelection);
    if (pending.kind !== "cleanup-intent" || !selected || !rollback) {
      return receipt;
    }
    const cleanup = perform<
      Extract<UpdateGenerationBrokerRequest, { kind: "cleanup-generations" }>
    >(
      {
        kind: "cleanup-generations",
        generationIds: pending.generationIds,
        protectedGenerationIds: pending.protectedGenerationIds,
      },
      {
        kind: "cleanup-generations",
        generationIds: pending.generationIds,
        removedGenerationIds: receipt.removedGenerationIds,
        deferred: receipt.deferred,
        protectedGenerationIds: pending.protectedGenerationIds,
      },
    );
    return {
      ...receipt,
      evidence: {
        cleanup,
        parentDirectorySync: syncParent("generations", cleanup.operationId),
        ...pairEvidence(selected, rollback),
      },
    };
  }
  return receipt;
}
