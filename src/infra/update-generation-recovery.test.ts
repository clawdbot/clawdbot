import { describe, expect, it } from "vitest";
import {
  appendUpdateGenerationReceipt,
  buildUpdateGenerationReceiptId,
  type UpdateGenerationManifest,
  type UpdateGenerationSelection,
  type UpdateGenerationTransactionReceipt,
  type UpdateGenerationTransactionRecord,
} from "./update-generation-contract.js";
import {
  adjudicateUpdateGenerationTransaction,
  type UpdateGenerationPhysicalState,
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
  "formatVersion" | "transactionId" | "sequence" | "receiptId" | "recordedAtMs" | "kind"
>;

function receipt<Kind extends ReceiptKind>(
  kind: Kind,
  sequence: number,
  fields: ReceiptFields<Kind>,
): ReceiptOf<Kind> {
  return {
    formatVersion: 1,
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
  return appendUpdateGenerationReceipt(record, next);
}

function physical(params: {
  selector: UpdateGenerationSelection | null;
  selectorDurable?: boolean;
  generations: UpdateGenerationSelection[];
  bindingConverged?: boolean;
}): UpdateGenerationPhysicalState {
  return {
    selector: params.selector,
    selectorDurable: params.selectorDurable ?? true,
    generations: params.generations.map(({ generationId, manifestSha256 }) => ({
      generationId,
      manifestSha256,
    })),
    bindingConverged: params.bindingConverged ?? false,
  };
}

function expectRecovery(params: {
  record: UpdateGenerationTransactionRecord;
  physical: UpdateGenerationPhysicalState;
  action: UpdateGenerationRecoveryAction;
  nextReceipt?: UpdateGenerationTransactionReceipt;
}): void {
  expect(adjudicateUpdateGenerationTransaction(params.record, params.physical)).toMatchObject({
    action: params.action,
  });
  if (params.nextReceipt) {
    expect(() => append(params.record, params.nextReceipt!)).not.toThrow();
  }
}

describe("update generation recovery transition matrix", () => {
  it("keeps every receipt-producing recovery decision appendable", () => {
    const previous = selection("a");
    const candidate = selection("b");
    const intent = receipt("intent", 0, {
      manager: "pnpm",
      namespaceKey: "openclaw-global-owner",
      namespaceRoot: "/manager/.openclaw-generations",
      selectorPath: "/manager/.openclaw-generations/selector.json",
      stagingRoot: "/manager/.openclaw-stage",
      serviceBefore: { managed: true, running: true },
      previousSelection: null,
      previousPackageVersion: null,
      stableBindingAlreadyVerified: false,
    });
    const previousIntent = receipt("generation-materialization-intent", 1, {
      role: "previous",
      sourceRoot: "/manager/live",
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
      sourceRoot: "/manager/stage",
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
    const failure = receipt("failure", 11, {
      operation: "doctor",
      reason: "injected failure",
      serviceRestored: false,
    });
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
    expectRecovery({
      record,
      physical: physical({ selector: null, generations: [] }),
      action: "resume-materialization",
      nextReceipt: previousIntent,
    });
    record = append(record, previousIntent);
    expectRecovery({
      record,
      physical: physical({ selector: null, generations: [previous] }),
      action: "record-materialized",
      nextReceipt: previousMaterialized,
    });
    record = append(record, previousMaterialized);
    expectRecovery({
      record,
      physical: physical({ selector: null, generations: [previous] }),
      action: "persist-baseline-selection-intent",
      nextReceipt: baselineIntent,
    });
    record = append(record, baselineIntent);
    expectRecovery({
      record,
      physical: physical({
        selector: previous,
        selectorDurable: false,
        generations: [previous],
      }),
      action: "stabilize-selector",
    });
    expectRecovery({
      record,
      physical: physical({ selector: previous, generations: [previous] }),
      action: "record-baseline-selected",
      nextReceipt: baselineSelected,
    });
    record = append(record, baselineSelected);
    expectRecovery({
      record,
      physical: physical({ selector: previous, generations: [previous] }),
      action: "persist-binding-intent",
      nextReceipt: bindingIntent,
    });
    record = append(record, bindingIntent);
    expectRecovery({
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
    expectRecovery({
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
    expectRecovery({
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
    expectRecovery({
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
    expectRecovery({
      record,
      physical: physical({
        selector: candidate,
        selectorDurable: false,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "stabilize-selector",
    });
    expectRecovery({
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
    expectRecovery({
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
    expectRecovery({
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
    expectRecovery({
      record,
      physical: physical({
        selector: previous,
        selectorDurable: false,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "stabilize-selector",
    });
    expectRecovery({
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
    expectRecovery({
      record,
      physical: physical({
        selector: previous,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "complete",
      nextReceipt: cleanupIntent,
    });
    record = append(record, cleanupIntent);
    expectRecovery({
      record,
      physical: physical({
        selector: previous,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "resume-cleanup",
      nextReceipt: cleanupCompleted,
    });
    record = append(record, cleanupCompleted);
    expectRecovery({
      record,
      physical: physical({
        selector: previous,
        generations: [previous, candidate],
        bindingConverged: true,
      }),
      action: "complete",
    });
  });

  it("requires selector durability and baseline presence before dependent transitions", () => {
    const previous = selection("a");
    const candidate = selection("b");
    let record = append(
      null,
      receipt("intent", 0, {
        manager: "bun",
        namespaceKey: "bun-global-owner",
        namespaceRoot: "/manager/.openclaw-generations",
        selectorPath: "/manager/.openclaw-generations/selector.json",
        stagingRoot: "/manager/.openclaw-stage",
        serviceBefore: { managed: true, running: false },
        previousSelection: previous,
        previousPackageVersion: "1.0.0",
        stableBindingAlreadyVerified: true,
      }),
    );
    record = append(
      record,
      receipt("generation-materialization-intent", 1, {
        role: "candidate",
        sourceRoot: "/manager/stage",
        generationId: candidate.generationId,
        manifest: manifest("b"),
        packageVersion: "2.0.0",
        entrypointRelativePath: candidate.entrypointRelativePath,
      }),
    );
    expectRecovery({
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
        manager: "pnpm",
        namespaceKey: "pnpm-global-owner",
        namespaceRoot: "/manager/.openclaw-generations",
        selectorPath: "/manager/.openclaw-generations/selector.json",
        stagingRoot: "/manager/.openclaw-stage",
        serviceBefore: { managed: true, running: true },
        previousSelection: null,
        previousPackageVersion: null,
        stableBindingAlreadyVerified: false,
      }),
    );
    bootstrap = append(
      bootstrap,
      receipt("generation-materialization-intent", 1, {
        role: "previous",
        sourceRoot: "/manager/live",
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
    expectRecovery({
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
    expectRecovery({
      record: bootstrap,
      physical: physical({ selector: previous, generations: [], bindingConverged: true }),
      action: "inconsistent",
    });
  });
});
