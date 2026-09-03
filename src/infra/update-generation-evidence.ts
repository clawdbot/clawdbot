/** Validation shared by durable transaction receipts that embed broker evidence. */
import {
  assertUpdateGenerationBrokerReceiptIsValid,
  buildUpdateGenerationBrokerOperationId,
  type UpdateGenerationBrokerReceipt,
  type UpdateGenerationBrokerReceiptOf,
} from "./update-generation-confined-filesystem.js";
import type {
  UpdateGenerationCleanupEvidence,
  UpdateGenerationFailureAdjudicationEvidence,
  UpdateGenerationMaterializationEvidence,
  UpdateGenerationProjection,
  UpdateGenerationRetainedPairEvidence,
  UpdateGenerationSelection,
  UpdateGenerationSelectionEvidence,
} from "./update-generation-contract.js";

type BrokerEvidence =
  | UpdateGenerationMaterializationEvidence
  | UpdateGenerationSelectionEvidence
  | UpdateGenerationRetainedPairEvidence
  | UpdateGenerationCleanupEvidence
  | UpdateGenerationFailureAdjudicationEvidence;

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

function hasRetainedPairEvidence(
  evidence: BrokerEvidence,
): evidence is UpdateGenerationSelectionEvidence & UpdateGenerationRetainedPairEvidence {
  return "retainedPair" in evidence && "recoveryObservation" in evidence;
}

export function brokerReceiptsInEvidence(evidence: BrokerEvidence) {
  if (!("retainedPair" in evidence) && "recoveryObservation" in evidence) {
    return [evidence.recoveryObservation];
  }
  if ("cleanup" in evidence) {
    return [
      evidence.cleanup,
      evidence.parentDirectorySync,
      evidence.retainedPair,
      evidence.recoveryObservation,
    ];
  }
  if ("selectorSwitch" in evidence) {
    const receipts: UpdateGenerationBrokerReceipt[] = [
      evidence.selectorSwitch,
      evidence.parentDirectorySync,
    ];
    if (hasRetainedPairEvidence(evidence)) {
      receipts.push(evidence.retainedPair, evidence.recoveryObservation);
    }
    return receipts;
  }
  if ("materialization" in evidence) {
    return [evidence.materialization, evidence.parentDirectorySync];
  }
  return [evidence.retainedPair, evidence.recoveryObservation];
}

export function assertBrokerEvidenceChain(
  projection: UpdateGenerationProjection,
  evidence: BrokerEvidence,
): void {
  const receipts = brokerReceiptsInEvidence(evidence);
  let expectedRevision = projection.brokerRevision;
  const operationIds = new Set(projection.brokerOperationIds);
  for (const brokerReceipt of receipts) {
    assertUpdateGenerationBrokerReceiptIsValid(brokerReceipt);
    if (
      brokerReceipt.brokerId !== projection.intent.brokerId ||
      brokerReceipt.namespaceKey !== projection.intent.namespaceKey ||
      brokerReceipt.transactionId !== projection.intent.transactionId
    ) {
      throw new Error("Broker evidence belongs to a different generation transaction");
    }
    if (operationIds.has(brokerReceipt.operationId)) {
      throw new Error("Broker operation id was replayed in this generation transaction");
    }
    operationIds.add(brokerReceipt.operationId);
    if (brokerReceipt.previousRevision !== expectedRevision) {
      throw new Error("Broker evidence does not continue the namespace revision chain");
    }
    expectedRevision = brokerReceipt.revision;
  }
}

export function assertBrokerEvidenceOperationIds(
  evidence: BrokerEvidence,
  intentReceiptId: string,
): void {
  for (const brokerReceipt of brokerReceiptsInEvidence(evidence)) {
    const expected = buildUpdateGenerationBrokerOperationId({
      intentReceiptId,
      kind: brokerReceipt.kind,
    });
    if (brokerReceipt.operationId !== expected) {
      throw new Error("Broker evidence operation id differs from its durable intent");
    }
  }
}

export function assertParentSyncFollows(
  sync: UpdateGenerationBrokerReceiptOf<"sync-parent-directory">,
  operation: UpdateGenerationBrokerReceiptOf<
    "materialize-generation" | "switch-selector" | "cleanup-generations"
  >,
  expectedParent: "generations" | "selector",
): void {
  if (
    sync.parent !== expectedParent ||
    sync.afterOperationId !== operation.operationId ||
    !sync.durable
  ) {
    throw new Error(`Broker evidence is missing durable ${expectedParent} parent synchronization`);
  }
}

export function assertRetainedPairEvidence(params: {
  evidence: UpdateGenerationRetainedPairEvidence;
  selected: UpdateGenerationSelection;
  rollback: UpdateGenerationSelection;
}): void {
  const pair = params.evidence.retainedPair.retainedPair;
  if (
    !selectionsEqual(pair.selected, params.selected) ||
    !selectionsEqual(pair.rollback, params.rollback)
  ) {
    throw new Error("Broker retained-pair evidence differs from the transaction generations");
  }
  const observation = params.evidence.recoveryObservation;
  if (
    !observation.selectorDurable ||
    !selectionsEqual(observation.selector, params.selected) ||
    !observation.retainedPair ||
    !selectionsEqual(observation.retainedPair.selected, params.selected) ||
    !selectionsEqual(observation.retainedPair.rollback, params.rollback)
  ) {
    throw new Error("Broker recovery observation does not prove the selected retained pair");
  }
  for (const selection of [params.selected, params.rollback]) {
    const observed = observation.generations.find(
      (generation) => generation.generationId === selection.generationId,
    );
    if (
      !observed ||
      observed.manifestSha256 !== selection.manifestSha256 ||
      !observed.parentDirectoryDurable
    ) {
      throw new Error("Broker recovery observation is missing a durable retained generation");
    }
  }
}
