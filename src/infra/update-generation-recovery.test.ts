import { describe, expect, it } from "vitest";
import {
  attachTestBrokerEvidence,
  authenticateTestRecoveryObservation,
  createTestReplayableConfinedFilesystem,
  type TestUpdateGenerationRecoveryState,
} from "../../test/helpers/update-generation-broker-fixture.js";
import {
  buildUpdateGenerationBrokerOperationId,
  type UpdateGenerationBrokerRequest,
} from "./update-generation-confined-filesystem.js";
import {
  appendUpdateGenerationReceipt,
  buildUpdateGenerationReceiptId,
  projectUpdateGenerationTransaction,
  type UpdateGenerationManifest,
  type UpdateGenerationSelection,
  type UpdateGenerationTransactionReceipt,
  type UpdateGenerationTransactionRecord,
} from "./update-generation-contract.js";
import {
  adjudicateUpdateGenerationTransaction as adjudicateAuthenticatedUpdateGenerationTransaction,
  reconcilePendingUpdateGenerationBrokerMutation,
  type UpdateGenerationRecoveryAction,
} from "./update-generation-recovery.js";

const TRANSACTION_ID = "recovery-transition-matrix";

type ReceiptKind = UpdateGenerationTransactionReceipt["kind"];
type ReceiptOf<Kind extends ReceiptKind> = Extract<
  UpdateGenerationTransactionReceipt,
  { kind: Kind }
>;
type ReceiptFields<Kind extends ReceiptKind> = Omit<
  ReceiptOf<Kind>,
  | "formatVersion"
  | "transactionId"
  | "sequence"
  | "receiptId"
  | "recordedAtMs"
  | "kind"
  | "evidence"
>;

function receipt<Kind extends ReceiptKind>(
  kind: Kind,
  sequence: number,
  fields: ReceiptFields<Kind>,
): ReceiptOf<Kind> {
  return {
    formatVersion: 2,
    transactionId: TRANSACTION_ID,
    sequence,
    receiptId: buildUpdateGenerationReceiptId({
      transactionId: TRANSACTION_ID,
      sequence,
      kind,
    }),
    recordedAtMs: 1_788_300_100_000 + sequence,
    kind,
    ...fields,
  } as ReceiptOf<Kind>;
}

function failureReceipt(sequence: number, operation: string, serviceRestored: boolean) {
  return receipt("failure", sequence, {
    operation,
    reason: `${operation} failed`,
    serviceRestored,
  });
}

function selection(character: string): UpdateGenerationSelection {
  return {
    formatVersion: 1,
    generationId: character.repeat(32),
    manifestSha256: character.repeat(64),
    entrypointRelativePath: "openclaw.mjs",
  };
}

function manifest(character: string): UpdateGenerationManifest {
  return {
    algorithm: "sha256",
    digest: character.repeat(64),
    entryCount: 2,
    totalBytes: 100,
  };
}

function append(
  record: UpdateGenerationTransactionRecord | null,
  next: UpdateGenerationTransactionReceipt,
): UpdateGenerationTransactionRecord {
  return appendUpdateGenerationReceipt(record, attachTestBrokerEvidence(record, next));
}

function physical(params: {
  selector: UpdateGenerationSelection | null;
  selectorDurable?: boolean;
  generations: UpdateGenerationSelection[];
  parentDirectoryDurable?: boolean;
  bindingConverged?: boolean;
  serviceState?: { running: boolean; enabled?: boolean } | null;
}): TestUpdateGenerationRecoveryState {
  return {
    selector: params.selector,
    selectorDurable: params.selectorDurable ?? true,
    generations: params.generations.map(({ generationId, manifestSha256 }) => ({
      generationId,
      manifestSha256,
      parentDirectoryDurable: params.parentDirectoryDurable ?? true,
    })),
    bindingConverged: params.bindingConverged ?? false,
    serviceState: params.serviceState ?? null,
  };
}

async function adjudicateUpdateGenerationTransaction(
  record: UpdateGenerationTransactionRecord,
  state: TestUpdateGenerationRecoveryState,
) {
  const { filesystem, observation, runtime } = await authenticateTestRecoveryObservation({
    record,
    physical: state,
  });
  return await adjudicateAuthenticatedUpdateGenerationTransaction(
    record,
    filesystem,
    observation,
    runtime,
  );
}

async function expectRecovery(params: {
  record: UpdateGenerationTransactionRecord;
  physical: TestUpdateGenerationRecoveryState;
  action: UpdateGenerationRecoveryAction;
  nextReceipt?: UpdateGenerationTransactionReceipt;
}): Promise<void> {
  const decision = await adjudicateUpdateGenerationTransaction(params.record, params.physical);
  expect(decision).toMatchObject({ action: params.action });
  if (params.nextReceipt) {
    expect(() => append(params.record, params.nextReceipt!)).not.toThrow();
  }
}

async function expectInconsistent(
  record: UpdateGenerationTransactionRecord,
  state: TestUpdateGenerationRecoveryState,
): Promise<void> {
  await expectRecovery({ record, physical: state, action: "inconsistent" });
}

describe("update generation recovery transition matrix", () => {
  it("keeps every receipt-producing recovery decision appendable", async () => {
    const previous = selection("a");
    const candidate = selection("b");
    const intent = receipt("intent", 0, {
      namespaceKey: "openclaw-global-owner",
      serviceBefore: { managed: true, running: true },
      previousSelection: null,
      previousPackageVersion: null,
      stableBindingAlreadyVerified: false,
      brokerId: "test-broker",
      brokerRevision: null,
    });
    const previousIntent = receipt("generation-materialization-intent", 1, {
      role: "previous",
      sourceArtifactId: "manager:live",
      generationId: previous.generationId,
      manifest: manifest("a"),
      packageVersion: "1.0.0",
      entrypointRelativePath: previous.entrypointRelativePath,
    });
    const previousMaterialized = receipt("generation-materialized", 2, {
      role: "previous",
      generation: { ...previous, packageVersion: "1.0.0" },
    });
    const baselineIntent = receipt("baseline-selection-intent", 3, { selection: previous });
    const baselineSelected = receipt("baseline-selected", 4, { selection: previous });
    const bindingIntent = receipt("binding-intent", 5, {
      bindings: [{ kind: "launcher", identity: "/manager/bin/openclaw", priorFingerprint: "old" }],
    });
    const bindingCompleted = receipt("binding-completed", 6, {
      bindings: [
        {
          kind: "launcher",
          identity: "/manager/bin/openclaw",
          priorFingerprint: "old",
          fingerprint: "stable",
        },
      ],
    });
    const candidateIntent = receipt("generation-materialization-intent", 7, {
      role: "candidate",
      sourceArtifactId: "manager:stage",
      generationId: candidate.generationId,
      manifest: manifest("b"),
      packageVersion: "2.0.0",
      entrypointRelativePath: candidate.entrypointRelativePath,
    });
    const candidateMaterialized = receipt("generation-materialized", 8, {
      role: "candidate",
      generation: { ...candidate, packageVersion: "2.0.0" },
    });
    const candidateIntentSelection = receipt("candidate-selection-intent", 9, {
      from: previous,
      to: candidate,
    });
    const candidateSelected = receipt("candidate-selected", 10, { selection: candidate });
    const failure = failureReceipt(11, "doctor", false);
    const rollbackIntent = receipt("rollback-intent", 12, {
      from: candidate,
      to: previous,
      reason: "Doctor failed",
    });
    const rolledBack = receipt("rolled-back", 13, {
      selection: previous,
      launcherVersion: "1.0.0",
      serviceRunning: true,
    });
    const cleanupIntent = receipt("cleanup-intent", 14, {
      generationIds: [],
      protectedGenerationIds: [previous.generationId, candidate.generationId],
    });
    const cleanupCompleted = receipt("cleanup-completed", 15, {
      removedGenerationIds: [],
      deferred: [],
    });

    let record = append(null, intent);
    await expectRecovery({
      record,
      physical: physical({ selector: null, generations: [] }),
      action: "resume-materialization",
      nextReceipt: previousIntent,
    });
    record = append(record, previousIntent);
    await expectRecovery({
      record,
      physical: physical({
        selector: null,
        generations: [previous],
        parentDirectoryDurable: false,
      }),
      action: "resume-materialization",
    });
    await expectRecovery({
      record,
      physical: physical({ selector: null, generations: [previous] }),
      action: "record-materialized",
      nextReceipt: previousMaterialized,
    });
    record = append(record, previousMaterialized);
    await expectInconsistent(
      record,
      physical({
        selector: null,
        generations: [previous],
        parentDirectoryDurable: false,
      }),
    );
    await expectRecovery({
      record,
      physical: physical({ selector: null, generations: [previous] }),
      action: "persist-baseline-selection-intent",
      nextReceipt: baselineIntent,
    });
    record = append(record, baselineIntent);
    await expectInconsistent(record, physical({ selector: null, generations: [] }));
    await expectInconsistent(
      record,
      physical({
        selector: previous,
        selectorDurable: false,
        generations: [previous],
        parentDirectoryDurable: false,
      }),
    );
    await expectRecovery({
      record,
      physical: physical({ selector: null, generations: [previous] }),
      action: "select-baseline",
    });
    await expectRecovery({
      record,
      physical: physical({
        selector: previous,
        selectorDurable: false,
        generations: [previous],
      }),
      action: "stabilize-selector",
    });
    await expectRecovery({
      record,
      physical: physical({ selector: previous, generations: [previous] }),
      action: "record-baseline-selected",
      nextReceipt: baselineSelected,
    });
    record = append(record, baselineSelected);
    await expectRecovery({
      record,
      physical: physical({ selector: previous, generations: [previous] }),
      action: "persist-binding-intent",
      nextReceipt: bindingIntent,
    });
    record = append(record, bindingIntent);
    await expectRecovery({
      record,
      physical: physical({
        selector: previous,
        generations: [previous],
        bindingConverged: true,
      }),
      action: "record-binding-completed",
      nextReceipt: bindingCompleted,
    });
    record = append(record, bindingCompleted);
    await expectRecovery({
      record,
      physical: physical({
        selector: previous,
        generations: [previous],
        bindingConverged: true,
      }),
      action: "resume-materialization",
      nextReceipt: candidateIntent,
    });
    record = append(record, candidateIntent);
    await expectRecovery({
      record,
      physical: physical({
        selector: previous,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "record-materialized",
      nextReceipt: candidateMaterialized,
    });
    record = append(record, candidateMaterialized);
    await expectRecovery({
      record,
      physical: physical({
        selector: previous,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "persist-candidate-selection-intent",
      nextReceipt: candidateIntentSelection,
    });
    record = append(record, candidateIntentSelection);
    await expectInconsistent(
      record,
      physical({
        selector: candidate,
        selectorDurable: false,
        generations: [candidate],
        bindingConverged: true,
      }),
    );
    await expectInconsistent(
      record,
      physical({
        selector: previous,
        generations: [previous, candidate],
        parentDirectoryDurable: false,
        bindingConverged: true,
      }),
    );
    await expectRecovery({
      record,
      physical: physical({
        selector: previous,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "select-candidate",
    });
    await expectRecovery({
      record,
      physical: physical({
        selector: candidate,
        selectorDurable: false,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "stabilize-selector",
    });
    await expectInconsistent(
      record,
      physical({
        selector: candidate,
        generations: [candidate],
        bindingConverged: true,
      }),
    );
    await expectInconsistent(
      record,
      physical({
        selector: candidate,
        generations: [previous, candidate],
        parentDirectoryDurable: false,
        bindingConverged: true,
      }),
    );
    await expectRecovery({
      record,
      physical: physical({
        selector: candidate,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "record-candidate-selected",
      nextReceipt: candidateSelected,
    });
    record = append(record, candidateSelected);
    await expectInconsistent(
      record,
      physical({
        selector: candidate,
        generations: [candidate],
        bindingConverged: true,
      }),
    );
    await expectInconsistent(
      record,
      physical({
        selector: candidate,
        generations: [previous, candidate],
        parentDirectoryDurable: false,
        bindingConverged: true,
      }),
    );
    await expectRecovery({
      record,
      physical: physical({
        selector: candidate,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "verify-completion",
      nextReceipt: failure,
    });
    record = append(record, failure);
    await expectRecovery({
      record,
      physical: physical({
        selector: candidate,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "adjudicate-failure",
      nextReceipt: rollbackIntent,
    });
    record = append(record, rollbackIntent);
    await expectInconsistent(
      record,
      physical({
        selector: previous,
        selectorDurable: false,
        generations: [previous],
        bindingConverged: true,
      }),
    );
    await expectRecovery({
      record,
      physical: physical({
        selector: candidate,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "select-previous",
    });
    await expectRecovery({
      record,
      physical: physical({
        selector: previous,
        selectorDurable: false,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "stabilize-selector",
    });
    await expectInconsistent(
      record,
      physical({
        selector: previous,
        generations: [previous, candidate],
        parentDirectoryDurable: false,
        bindingConverged: true,
      }),
    );
    await expectRecovery({
      record,
      physical: physical({
        selector: previous,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "record-rolled-back",
      nextReceipt: rolledBack,
    });
    record = append(record, rolledBack);
    await expectRecovery({
      record,
      physical: physical({
        selector: previous,
        generations: [previous, candidate],
        bindingConverged: true,
        serviceState: { running: true },
      }),
      action: "complete",
      nextReceipt: cleanupIntent,
    });
    record = append(record, cleanupIntent);
    await expectRecovery({
      record,
      physical: physical({
        selector: previous,
        generations: [previous, candidate],
        bindingConverged: true,
        serviceState: { running: true },
      }),
      action: "resume-cleanup",
      nextReceipt: cleanupCompleted,
    });
    record = append(record, cleanupCompleted);
    await expectRecovery({
      record,
      physical: physical({
        selector: previous,
        generations: [previous, candidate],
        bindingConverged: true,
        serviceState: { running: true },
      }),
      action: "complete",
    });
  });

  it("requires selector durability and baseline presence before dependent transitions", async () => {
    const previous = selection("a");
    const candidate = selection("b");
    let record = append(
      null,
      receipt("intent", 0, {
        namespaceKey: "bun-global-owner",
        serviceBefore: { managed: true, running: false },
        previousSelection: previous,
        previousPackageVersion: "1.0.0",
        stableBindingAlreadyVerified: true,
        brokerId: "test-broker",
        brokerRevision: null,
      }),
    );
    record = append(
      record,
      receipt("generation-materialization-intent", 1, {
        role: "candidate",
        sourceArtifactId: "manager:stage",
        generationId: candidate.generationId,
        manifest: manifest("b"),
        packageVersion: "2.0.0",
        entrypointRelativePath: candidate.entrypointRelativePath,
      }),
    );
    await expectRecovery({
      record,
      physical: physical({
        selector: previous,
        selectorDurable: false,
        generations: [previous, candidate],
      }),
      action: "inconsistent",
    });

    let bootstrap = append(
      null,
      receipt("intent", 0, {
        namespaceKey: "pnpm-global-owner",
        serviceBefore: { managed: true, running: true },
        previousSelection: null,
        previousPackageVersion: null,
        stableBindingAlreadyVerified: false,
        brokerId: "test-broker",
        brokerRevision: null,
      }),
    );
    bootstrap = append(
      bootstrap,
      receipt("generation-materialization-intent", 1, {
        role: "previous",
        sourceArtifactId: "manager:live",
        generationId: previous.generationId,
        manifest: manifest("a"),
        packageVersion: "1.0.0",
        entrypointRelativePath: previous.entrypointRelativePath,
      }),
    );
    bootstrap = append(
      bootstrap,
      receipt("generation-materialized", 2, {
        role: "previous",
        generation: { ...previous, packageVersion: "1.0.0" },
      }),
    );
    bootstrap = append(bootstrap, receipt("baseline-selection-intent", 3, { selection: previous }));
    await expectRecovery({
      record: bootstrap,
      physical: physical({
        selector: previous,
        selectorDurable: false,
        generations: [previous],
      }),
      action: "stabilize-selector",
    });
    bootstrap = append(bootstrap, receipt("baseline-selected", 4, { selection: previous }));
    bootstrap = append(
      bootstrap,
      receipt("binding-intent", 5, {
        bindings: [
          { kind: "launcher", identity: "/manager/bin/openclaw", priorFingerprint: "old" },
        ],
      }),
    );
    await expectInconsistent(
      bootstrap,
      physical({ selector: previous, generations: [], bindingConverged: true }),
    );
  });

  it("never resumes a durable pre-activation failure implicitly", async () => {
    const [previous, candidate] = [selection("a"), selection("b")] as const;
    let materialization = append(
      null,
      receipt("intent", 0, {
        namespaceKey: "openclaw-global-owner",
        serviceBefore: { managed: true, running: true, enabled: true },
        previousSelection: previous,
        previousPackageVersion: "1.0.0",
        stableBindingAlreadyVerified: true,
        brokerId: "test-broker",
        brokerRevision: null,
      }),
    );
    materialization = append(
      materialization,
      receipt("generation-materialization-intent", 1, {
        role: "candidate",
        sourceArtifactId: "manager:stage",
        generationId: candidate.generationId,
        manifest: manifest("b"),
        packageVersion: "2.0.0",
        entrypointRelativePath: candidate.entrypointRelativePath,
      }),
    );
    materialization = append(materialization, failureReceipt(2, "materialize-generation", true));
    await expectRecovery({
      record: materialization,
      physical: physical({
        selector: previous,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "adjudicate-failure",
    });
    const materializationAdjudicated = append(
      materialization,
      receipt("failure-adjudicated", 3, {
        failedReceiptId: materialization.receipts[2]!.receiptId,
        resumeFromReceiptId: materialization.receipts[1]!.receiptId,
      }),
    );
    await expectRecovery({
      record: materializationAdjudicated,
      physical: physical({
        selector: previous,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "record-materialized",
    });

    let beforeSelectionReceipt = append(
      null,
      receipt("intent", 0, {
        namespaceKey: "openclaw-global-owner",
        serviceBefore: { managed: true, running: true, enabled: true },
        previousSelection: previous,
        previousPackageVersion: "1.0.0",
        stableBindingAlreadyVerified: true,
        brokerId: "test-broker",
        brokerRevision: null,
      }),
    );
    beforeSelectionReceipt = append(
      beforeSelectionReceipt,
      receipt("generation-materialization-intent", 1, {
        role: "candidate",
        sourceArtifactId: "manager:stage",
        generationId: candidate.generationId,
        manifest: manifest("b"),
        packageVersion: "2.0.0",
        entrypointRelativePath: candidate.entrypointRelativePath,
      }),
    );
    beforeSelectionReceipt = append(
      beforeSelectionReceipt,
      receipt("generation-materialized", 2, {
        role: "candidate",
        generation: { ...candidate, packageVersion: "2.0.0" },
      }),
    );
    beforeSelectionReceipt = append(
      beforeSelectionReceipt,
      receipt("candidate-selection-intent", 3, { from: previous, to: candidate }),
    );
    const selectionFailure = append(
      beforeSelectionReceipt,
      failureReceipt(beforeSelectionReceipt.receipts.length, "switch-selector", true),
    );
    await expectRecovery({
      record: selectionFailure,
      physical: physical({
        selector: candidate,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "adjudicate-failure",
    });
  });

  it("requires a verified stable binding for an existing selection", async () => {
    const previous = selection("a");
    const existing = append(
      null,
      receipt("intent", 0, {
        namespaceKey: "openclaw-global-owner",
        serviceBefore: { managed: true, running: true, enabled: true },
        previousSelection: previous,
        previousPackageVersion: "1.0.0",
        stableBindingAlreadyVerified: true,
        brokerId: "test-broker",
        brokerRevision: null,
      }),
    );
    await expectRecovery({
      record: existing,
      physical: physical({
        selector: previous,
        generations: [previous],
        bindingConverged: true,
      }),
      action: "resume-materialization",
    });

    expect(() =>
      append(
        null,
        receipt("intent", 0, {
          namespaceKey: "openclaw-global-owner",
          serviceBefore: { managed: true, running: true, enabled: true },
          previousSelection: previous,
          previousPackageVersion: "1.0.0",
          stableBindingAlreadyVerified: false,
          brokerId: "test-broker",
          brokerRevision: null,
        }),
      ),
    ).toThrow("existing generation selection requires a verified stable binding");
  });

  it("durably replays a broker mutation lost before its ledger receipt", async () => {
    const previous = selection("a");
    let record = append(
      null,
      receipt("intent", 0, {
        namespaceKey: "openclaw-global-owner",
        serviceBefore: { managed: true, running: true, enabled: true },
        previousSelection: null,
        previousPackageVersion: null,
        stableBindingAlreadyVerified: false,
        brokerId: "test-broker",
        brokerRevision: null,
      }),
    );
    const materializationIntent = receipt("generation-materialization-intent", 1, {
      role: "previous",
      sourceArtifactId: "manager:live",
      generationId: previous.generationId,
      manifest: manifest("a"),
      packageVersion: "1.0.0",
      entrypointRelativePath: previous.entrypointRelativePath,
    });
    record = append(record, materializationIntent);
    await expect(
      reconcilePendingUpdateGenerationBrokerMutation({ record, filesystem: null }),
    ).rejects.toThrow("requires a confined filesystem provider");
    const broker = createTestReplayableConfinedFilesystem();

    const committedBeforeCrash = await reconcilePendingUpdateGenerationBrokerMutation({
      record,
      filesystem: broker.filesystem,
    });
    expect(committedBeforeCrash?.receipt.kind).toBe("materialize-generation");
    expect(broker.mutationCount()).toBe(1);

    const failed = append(record, failureReceipt(2, "materialize-generation", true));
    const unrelatedFailure = append(record, failureReceipt(2, "switch-selector", true));
    await expect(
      reconcilePendingUpdateGenerationBrokerMutation({
        record: unrelatedFailure,
        filesystem: broker.filesystem,
      }),
    ).resolves.toBeNull();

    const recovered = await reconcilePendingUpdateGenerationBrokerMutation({
      record: failed,
      filesystem: broker.filesystem,
    });
    expect(recovered).toEqual(committedBeforeCrash);
    expect(broker.mutationCount()).toBe(1);
    if (!recovered || recovered.receipt.kind !== "materialize-generation") {
      throw new Error("expected a replayed materialization receipt");
    }

    const changedReplay = structuredClone(recovered.request);
    if (changedReplay.kind !== "materialize-generation") {
      throw new Error("expected a materialization request");
    }
    changedReplay.sourceArtifactId = "manager:different-live-root";
    await expect(broker.filesystem.perform(changedReplay)).rejects.toThrow(
      "replayed with a different request",
    );
    expect(broker.mutationCount()).toBe(1);

    const syncRequest: Extract<UpdateGenerationBrokerRequest, { kind: "sync-parent-directory" }> = {
      formatVersion: 1,
      kind: "sync-parent-directory",
      brokerId: "test-broker",
      namespaceKey: "openclaw-global-owner",
      transactionId: TRANSACTION_ID,
      operationId: buildUpdateGenerationBrokerOperationId({
        intentReceiptId: materializationIntent.receiptId,
        kind: "sync-parent-directory",
      }),
      expectedRevision: recovered.receipt.revision,
      parent: "generations",
      afterOperationId: recovered.receipt.operationId,
    };
    const parentDirectorySync = await broker.filesystem.perform(syncRequest);
    expect(parentDirectorySync.kind).toBe("sync-parent-directory");
    expect(broker.mutationCount()).toBe(2);

    const materialized = {
      ...receipt("generation-materialized", 3, {
        role: "previous",
        generation: { ...previous, packageVersion: "1.0.0" },
      }),
      evidence: { materialization: recovered.receipt, parentDirectorySync },
    };
    expect(() => appendUpdateGenerationReceipt(unrelatedFailure, materialized)).toThrow(
      "requires durable adjudication",
    );
    record = appendUpdateGenerationReceipt(failed, materialized);
    expect(projectUpdateGenerationTransaction(record).brokerRevision).toBe(
      parentDirectorySync.revision,
    );
  });

  it("builds recovery broker requests only from the pre-await authenticated record", async () => {
    const previous = selection("a");
    let record = append(
      null,
      receipt("intent", 0, {
        namespaceKey: "openclaw-global-owner",
        serviceBefore: { managed: true, running: true, enabled: true },
        previousSelection: null,
        previousPackageVersion: null,
        stableBindingAlreadyVerified: false,
        brokerId: "test-broker",
        brokerRevision: null,
      }),
    );
    record = append(
      record,
      receipt("generation-materialization-intent", 1, {
        role: "previous",
        sourceArtifactId: "original-source",
        generationId: previous.generationId,
        manifest: manifest("a"),
        packageVersion: "1.0.0",
        entrypointRelativePath: previous.entrypointRelativePath,
      }),
    );
    const broker = createTestReplayableConfinedFilesystem();

    const pending = reconcilePendingUpdateGenerationBrokerMutation({
      record,
      filesystem: broker.filesystem,
    });
    const aliasedIntent = record.receipts.at(-1);
    if (!aliasedIntent || aliasedIntent.kind !== "generation-materialization-intent") {
      throw new Error("expected aliased materialization intent");
    }
    aliasedIntent.sourceArtifactId = "mutated-after-call";
    const reconciled = await pending;

    expect(reconciled?.request.kind).toBe("materialize-generation");
    if (reconciled?.request.kind === "materialize-generation") {
      expect(reconciled.request.sourceArtifactId).toBe("original-source");
    }
  });

  it("adjudicates only from pre-await authenticated record and observation snapshots", async () => {
    const previous = selection("a");
    const record = append(
      null,
      receipt("intent", 0, {
        namespaceKey: "openclaw-global-owner",
        serviceBefore: { managed: true, running: true, enabled: true },
        previousSelection: previous,
        previousPackageVersion: "1.0.0",
        stableBindingAlreadyVerified: true,
        brokerId: "test-broker",
        brokerRevision: null,
      }),
    );
    const valid = await authenticateTestRecoveryObservation({
      record,
      physical: physical({
        selector: previous,
        generations: [previous],
        bindingConverged: true,
        serviceState: { running: true, enabled: true },
      }),
    });
    const aliasedObservation = structuredClone(valid.observation);
    const aliasedRuntime = structuredClone(valid.runtime);

    const pending = adjudicateAuthenticatedUpdateGenerationTransaction(
      record,
      valid.filesystem,
      aliasedObservation,
      aliasedRuntime,
    );
    const intentReceipt = record.receipts[0];
    if (intentReceipt?.kind !== "intent" || !intentReceipt.previousSelection) {
      throw new Error("expected a prior generation intent");
    }
    intentReceipt.previousSelection.generationId = "c".repeat(32);
    aliasedObservation.selector = null;
    aliasedObservation.generations = [];
    aliasedRuntime.bindingConverged = false;

    await expect(pending).resolves.toMatchObject({
      action: "resume-materialization",
      role: "candidate",
    });
  });

  it("binds authenticated recovery observations to the exact projected broker revision", async () => {
    const previous = selection("a");
    const record = append(
      null,
      receipt("intent", 0, {
        namespaceKey: "openclaw-global-owner",
        serviceBefore: { managed: true, running: true, enabled: true },
        previousSelection: previous,
        previousPackageVersion: "1.0.0",
        stableBindingAlreadyVerified: true,
        brokerId: "test-broker",
        brokerRevision: null,
      }),
    );
    const recoveryState = physical({
      selector: previous,
      generations: [previous],
      bindingConverged: true,
      serviceState: { running: true, enabled: true },
    });
    const valid = await authenticateTestRecoveryObservation({
      record,
      physical: recoveryState,
    });
    await expect(
      adjudicateAuthenticatedUpdateGenerationTransaction(
        record,
        null,
        valid.observation,
        valid.runtime,
      ),
    ).rejects.toThrow("requires a confined filesystem provider");

    const mismatches = [
      {
        label: "broker",
        identityOverrides: { brokerId: "other-broker" },
        message: "outside the confined provider scope",
      },
      {
        label: "namespace",
        identityOverrides: { namespaceKey: "other-namespace" },
        message: "outside the confined provider scope",
      },
      {
        label: "transaction",
        identityOverrides: { transactionId: "other-transaction" },
        message: "different generation transaction",
      },
      {
        label: "revision",
        identityOverrides: { expectedRevision: "stale-revision" },
        message: "projected broker revision",
      },
    ] as const;
    for (const mismatch of mismatches) {
      const signed = await authenticateTestRecoveryObservation({
        record,
        physical: recoveryState,
        identityOverrides: mismatch.identityOverrides,
      });
      await expect(
        adjudicateAuthenticatedUpdateGenerationTransaction(
          record,
          signed.filesystem,
          signed.observation,
          signed.runtime,
        ),
        mismatch.label,
      ).rejects.toThrow(mismatch.message);
    }
  });
});
