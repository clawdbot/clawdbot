import { describe, expect, it } from "vitest";
import {
  attachTestBrokerEvidence,
  authenticateTestRecoveryObservation,
  createTestConfinedFilesystemForAuthentication,
  type TestUpdateGenerationRecoveryState,
} from "../../test/helpers/update-generation-broker-fixture.js";
import { TestUpdateGenerationMemoryLedger as MemoryLedger } from "../../test/helpers/update-generation-memory-ledger.js";
import {
  digestUpdateGenerationBrokerReceiptPayload,
  digestUpdateGenerationBrokerRequest,
} from "./update-generation-confined-filesystem.js";
import { parseUpdateGenerationTransactionRecord } from "./update-generation-contract-parser.js";
import {
  appendUpdateGenerationReceipt,
  buildUpdateGenerationReceiptId,
  projectUpdateGenerationTransaction,
  type UpdateGenerationManifest,
  type UpdateGenerationSelection,
  type UpdateGenerationServiceIntent,
  type UpdateGenerationTransactionReceipt,
  type UpdateGenerationTransactionRecord,
} from "./update-generation-contract.js";
import { persistUpdateGenerationReceipt } from "./update-generation-ledger-hook.js";
import { adjudicateUpdateGenerationTransaction as adjudicateAuthenticatedUpdateGenerationTransaction } from "./update-generation-recovery.js";

const TRANSACTION_ID = "update-transaction-1";
const NAMESPACE_KEY = "openclaw-global-owner";
const AUTHENTICATION_FILESYSTEM = createTestConfinedFilesystemForAuthentication();

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
    recordedAtMs: 1_788_300_000_000 + sequence,
    kind,
    ...fields,
  } as ReceiptOf<Kind>;
}

function manifest(character: string): UpdateGenerationManifest {
  return {
    algorithm: "sha256",
    digest: character.repeat(64),
    entryCount: 2,
    totalBytes: 100,
  };
}

function selection(character: string): UpdateGenerationSelection {
  return {
    formatVersion: 1,
    generationId: character.repeat(32),
    manifestSha256: character.repeat(64),
    entrypointRelativePath: "openclaw.mjs",
  };
}

function intent(
  previousSelection: UpdateGenerationSelection | null,
  stable: boolean,
  serviceBefore: UpdateGenerationServiceIntent = {
    managed: true,
    running: true,
    enabled: true,
  },
) {
  return receipt("intent", 0, {
    namespaceKey: NAMESPACE_KEY,
    serviceBefore,
    previousSelection,
    previousPackageVersion: previousSelection ? "1.0.0" : null,
    stableBindingAlreadyVerified: stable,
    brokerId: "test-broker",
    brokerRevision: null,
  });
}

function candidateSelectedRecord(serviceBefore: UpdateGenerationServiceIntent): {
  record: UpdateGenerationTransactionRecord;
  previous: UpdateGenerationSelection;
  candidate: UpdateGenerationSelection;
} {
  const previous = selection("a");
  const candidate = selection("b");
  let record = append(null, intent(previous, true, serviceBefore));
  record = append(
    record,
    receipt("generation-materialization-intent", 1, {
      role: "candidate",
      sourceArtifactId: "stage:candidate",
      generationId: candidate.generationId,
      manifest: manifest("b"),
      packageVersion: "2.0.0",
      entrypointRelativePath: candidate.entrypointRelativePath,
    }),
  );
  record = append(
    record,
    receipt("generation-materialized", 2, {
      role: "candidate",
      generation: { ...candidate, packageVersion: "2.0.0" },
    }),
  );
  record = append(
    record,
    receipt("candidate-selection-intent", 3, { from: previous, to: candidate }),
  );
  record = append(record, receipt("candidate-selected", 4, { selection: candidate }));
  return { record, previous, candidate };
}

function append(
  record: UpdateGenerationTransactionRecord | null,
  next: UpdateGenerationTransactionReceipt,
): UpdateGenerationTransactionRecord {
  return appendUpdateGenerationReceipt(record, attachTestBrokerEvidence(record, next));
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

describe("durable update generation transaction contract", () => {
  it.each([
    {
      label: "enabled-running",
      serviceBefore: { managed: true, running: true, enabled: true },
    },
    {
      label: "enabled-stopped",
      serviceBefore: { managed: true, running: false, enabled: true },
    },
    {
      label: "disabled-stopped",
      serviceBefore: { managed: true, running: false, enabled: false },
    },
  ] as const)(
    "requires $label service convergence for success, rollback, restart, and replay",
    async ({ serviceBefore }) => {
      const {
        record: selectedRecord,
        previous,
        candidate,
      } = candidateSelectedRecord(serviceBefore);
      const completion = receipt("completion", 5, {
        packageVersion: "2.0.0",
        launcherVersion: "2.0.0",
        serviceRunning: serviceBefore.running,
        serviceEnabled: serviceBefore.enabled,
      });
      const completed = append(selectedRecord, completion);
      const storedCompletion = completed.receipts.at(-1);
      if (!storedCompletion || storedCompletion.kind !== "completion") {
        throw new Error("expected completion receipt");
      }
      const missingEnablement = { ...storedCompletion, serviceEnabled: undefined };
      const flippedEnablement = {
        ...storedCompletion,
        serviceEnabled: !serviceBefore.enabled,
      };
      expect(() => append(selectedRecord, missingEnablement)).toThrow(
        "does not prove candidate and service convergence",
      );
      expect(() => append(selectedRecord, flippedEnablement)).toThrow(
        "does not prove candidate and service convergence",
      );

      for (const invalidCompletion of [missingEnablement, flippedEnablement]) {
        const invalidRecord = {
          ...completed,
          receipts: [...completed.receipts.slice(0, -1), invalidCompletion],
        };
        expect(() =>
          parseUpdateGenerationTransactionRecord(
            // oxlint-disable-next-line unicorn/prefer-structured-clone -- malformed durable JSON is under test.
            JSON.parse(JSON.stringify(invalidRecord)),
          ),
        ).toThrow("service convergence");
        await expect(
          persistUpdateGenerationReceipt({
            filesystem: AUTHENTICATION_FILESYSTEM,
            ledger: new MemoryLedger({ revision: "6", record: invalidRecord }),
            snapshot: { revision: "6", record: invalidRecord },
            receipt: invalidCompletion,
          }),
        ).rejects.toThrow("service convergence");
      }
      const restarted = parseUpdateGenerationTransactionRecord(
        // oxlint-disable-next-line unicorn/prefer-structured-clone -- durable JSON restart is under test.
        JSON.parse(JSON.stringify(completed)),
      );
      const physical = {
        selector: candidate,
        selectorDurable: true,
        generations: [
          {
            generationId: previous.generationId,
            manifestSha256: previous.manifestSha256,
            parentDirectoryDurable: true,
          },
          { generationId: candidate.generationId, manifestSha256: candidate.manifestSha256 },
        ],
        bindingConverged: true,
        serviceState: { running: serviceBefore.running, enabled: serviceBefore.enabled },
      };
      expect(await adjudicateUpdateGenerationTransaction(restarted, physical)).toMatchObject({
        action: "complete",
      });
      expect(
        await adjudicateUpdateGenerationTransaction(restarted, {
          ...physical,
          serviceState: { running: serviceBefore.running },
        }),
      ).toMatchObject({ action: "inconsistent" });
      expect(
        await adjudicateUpdateGenerationTransaction(restarted, {
          ...physical,
          serviceState: { running: serviceBefore.running, enabled: !serviceBefore.enabled },
        }),
      ).toMatchObject({ action: "inconsistent" });
      const snapshot = { revision: "6", record: restarted };
      await expect(
        persistUpdateGenerationReceipt({
          filesystem: AUTHENTICATION_FILESYSTEM,
          ledger: new MemoryLedger(snapshot),
          snapshot,
          receipt: storedCompletion,
        }),
      ).resolves.toEqual(snapshot);

      let rollbackRecord = append(
        selectedRecord,
        receipt("rollback-intent", 5, {
          from: candidate,
          to: previous,
          reason: "verification failed",
        }),
      );
      const rolledBack = receipt("rolled-back", 6, {
        selection: previous,
        launcherVersion: "1.0.0",
        serviceRunning: serviceBefore.running,
        serviceEnabled: serviceBefore.enabled,
      });
      const evidencedRollback = attachTestBrokerEvidence(rollbackRecord, rolledBack);
      if (evidencedRollback.kind !== "rolled-back") {
        throw new Error("expected rolled-back receipt");
      }
      const rollbackMissingEnablement = {
        ...evidencedRollback,
        serviceEnabled: undefined,
      };
      const rollbackFlippedEnablement = {
        ...evidencedRollback,
        serviceEnabled: !serviceBefore.enabled,
      };
      expect(() => append(rollbackRecord, rollbackMissingEnablement)).toThrow(
        "does not prove previous runtime and service convergence",
      );
      expect(() => append(rollbackRecord, rollbackFlippedEnablement)).toThrow(
        "does not prove previous runtime and service convergence",
      );
      rollbackRecord = append(rollbackRecord, rolledBack);
      for (const invalidRollback of [rollbackMissingEnablement, rollbackFlippedEnablement]) {
        const invalidRecord = {
          ...rollbackRecord,
          receipts: [...rollbackRecord.receipts.slice(0, -1), invalidRollback],
        };
        expect(() =>
          parseUpdateGenerationTransactionRecord(
            // oxlint-disable-next-line unicorn/prefer-structured-clone -- malformed durable JSON is under test.
            JSON.parse(JSON.stringify(invalidRecord)),
          ),
        ).toThrow("service convergence");
        await expect(
          persistUpdateGenerationReceipt({
            filesystem: AUTHENTICATION_FILESYSTEM,
            ledger: new MemoryLedger({ revision: "7", record: invalidRecord }),
            snapshot: { revision: "7", record: invalidRecord },
            receipt: invalidRollback,
          }),
        ).rejects.toThrow("service convergence");
      }
      const restartedRollback = parseUpdateGenerationTransactionRecord(
        // oxlint-disable-next-line unicorn/prefer-structured-clone -- durable JSON restart is under test.
        JSON.parse(JSON.stringify(rollbackRecord)),
      );
      expect(
        await adjudicateUpdateGenerationTransaction(restartedRollback, {
          ...physical,
          selector: previous,
        }),
      ).toMatchObject({ action: "complete" });
    },
  );

  it("serializes a complete existing-binding activation without methods", async () => {
    const previous = selection("a");
    const candidate = selection("b");
    let record = append(null, intent(previous, true));
    expect(
      await adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        selectorDurable: true,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
          { generationId: candidate.generationId, manifestSha256: candidate.manifestSha256 },
        ],
        bindingConverged: true,
        serviceState: { running: true, enabled: true },
      }),
    ).toMatchObject({ action: "resume-materialization", role: "candidate" });
    record = append(
      record,
      receipt("generation-materialization-intent", 1, {
        role: "candidate",
        sourceArtifactId: "stage:candidate",
        generationId: candidate.generationId,
        manifest: manifest("b"),
        packageVersion: "2.0.0",
        entrypointRelativePath: candidate.entrypointRelativePath,
      }),
    );
    record = append(
      record,
      receipt("generation-materialized", 2, {
        role: "candidate",
        generation: { ...candidate, packageVersion: "2.0.0" },
      }),
    );
    expect(
      await adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        selectorDurable: true,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
          { generationId: candidate.generationId, manifestSha256: candidate.manifestSha256 },
        ],
        bindingConverged: true,
        serviceState: { running: true, enabled: true },
      }),
    ).toMatchObject({ action: "persist-candidate-selection-intent", role: "candidate" });
    record = append(
      record,
      receipt("candidate-selection-intent", 3, { from: previous, to: candidate }),
    );
    record = append(record, receipt("candidate-selected", 4, { selection: candidate }));
    record = append(
      record,
      receipt("completion", 5, {
        packageVersion: "2.0.0",
        launcherVersion: "2.0.0",
        serviceRunning: true,
        serviceEnabled: true,
      }),
    );

    // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON persistence is under test.
    const roundTrip = parseUpdateGenerationTransactionRecord(JSON.parse(JSON.stringify(record)));
    expect(roundTrip).toEqual(record);
    expect(projectUpdateGenerationTransaction(roundTrip)).toMatchObject({
      candidateSelection: candidate,
      completed: true,
      bindingCompleted: true,
    });
    expect(
      await adjudicateUpdateGenerationTransaction(roundTrip, {
        selector: candidate,
        selectorDurable: true,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
          { generationId: candidate.generationId, manifestSha256: candidate.manifestSha256 },
        ],
        bindingConverged: true,
        serviceState: { running: true, enabled: true },
      }),
    ).toEqual({ action: "complete", reason: "completion receipt and selector agree" });
    expect(
      await adjudicateUpdateGenerationTransaction(roundTrip, {
        selector: candidate,
        selectorDurable: true,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
        ],
        bindingConverged: true,
      }),
    ).toMatchObject({ action: "inconsistent" });
    expect(
      await adjudicateUpdateGenerationTransaction(roundTrip, {
        selector: candidate,
        selectorDurable: true,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
          { generationId: candidate.generationId, manifestSha256: candidate.manifestSha256 },
        ],
        bindingConverged: false,
      }),
    ).toMatchObject({ action: "inconsistent" });
  });

  it("adjudicates every mutation boundary from durable intent and physical state", async () => {
    const previous = selection("a");
    const candidate = selection("b");
    let record = append(null, intent(null, false));
    record = append(
      record,
      receipt("generation-materialization-intent", 1, {
        role: "previous",
        sourceArtifactId: "live:owner",
        generationId: previous.generationId,
        manifest: manifest("a"),
        packageVersion: "1.0.0",
        entrypointRelativePath: previous.entrypointRelativePath,
      }),
    );
    expect(
      await adjudicateUpdateGenerationTransaction(record, {
        selector: null,
        selectorDurable: true,
        generations: [
          {
            generationId: previous.generationId,
            manifestSha256: previous.manifestSha256,
            parentDirectoryDurable: true,
          },
        ],
        bindingConverged: false,
      }),
    ).toMatchObject({ action: "record-materialized", role: "previous" });
    record = append(
      record,
      receipt("generation-materialized", 2, {
        role: "previous",
        generation: { ...previous, packageVersion: "1.0.0" },
      }),
    );
    expect(
      await adjudicateUpdateGenerationTransaction(record, {
        selector: null,
        selectorDurable: true,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
        ],
        bindingConverged: false,
      }),
    ).toMatchObject({ action: "persist-baseline-selection-intent", role: "previous" });
    record = append(record, receipt("baseline-selection-intent", 3, { selection: previous }));
    expect(
      await adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        selectorDurable: true,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
        ],
        bindingConverged: false,
      }),
    ).toMatchObject({ action: "record-baseline-selected" });
    record = append(record, receipt("baseline-selected", 4, { selection: previous }));
    expect(
      await adjudicateUpdateGenerationTransaction(record, {
        selector: null,
        selectorDurable: true,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
        ],
        bindingConverged: false,
      }),
    ).toMatchObject({ action: "inconsistent" });
    expect(
      await adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        selectorDurable: true,
        generations: [],
        bindingConverged: false,
      }),
    ).toMatchObject({ action: "inconsistent" });
    expect(
      await adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        selectorDurable: true,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
        ],
        bindingConverged: false,
      }),
    ).toMatchObject({ action: "persist-binding-intent" });
    expect(
      await adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        selectorDurable: true,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
          { generationId: candidate.generationId, manifestSha256: candidate.manifestSha256 },
        ],
        bindingConverged: true,
      }),
    ).toMatchObject({ action: "persist-binding-intent" });
    record = append(
      record,
      receipt("binding-intent", 5, {
        bindings: [
          { kind: "launcher", identity: "/manager/bin/openclaw", priorFingerprint: "old" },
          { kind: "service", identity: "gateway", priorFingerprint: "old-service" },
        ],
      }),
    );
    expect(
      await adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        selectorDurable: true,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
        ],
        bindingConverged: true,
      }),
    ).toMatchObject({ action: "record-binding-completed" });
    record = append(
      record,
      receipt("binding-completed", 6, {
        bindings: [
          {
            kind: "launcher",
            identity: "/manager/bin/openclaw",
            priorFingerprint: "old",
            fingerprint: "stable",
          },
          {
            kind: "service",
            identity: "gateway",
            priorFingerprint: "old-service",
            fingerprint: "stable-service",
          },
        ],
      }),
    );
    record = append(
      record,
      receipt("generation-materialization-intent", 7, {
        role: "candidate",
        sourceArtifactId: "stage:candidate",
        generationId: candidate.generationId,
        manifest: manifest("b"),
        packageVersion: "2.0.0",
        entrypointRelativePath: candidate.entrypointRelativePath,
      }),
    );
    record = append(
      record,
      receipt("generation-materialized", 8, {
        role: "candidate",
        generation: { ...candidate, packageVersion: "2.0.0" },
      }),
    );
    record = append(
      record,
      receipt("candidate-selection-intent", 9, { from: previous, to: candidate }),
    );
    expect(
      await adjudicateUpdateGenerationTransaction(record, {
        selector: candidate,
        selectorDurable: true,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
          { generationId: candidate.generationId, manifestSha256: candidate.manifestSha256 },
        ],
        bindingConverged: true,
      }),
    ).toMatchObject({ action: "record-candidate-selected" });
  });

  it("makes rollback selector-only and protects both retained generations from cleanup", async () => {
    const previous = selection("a");
    const candidate = selection("b");
    let record = append(null, intent(previous, true));
    record = append(
      record,
      receipt("generation-materialization-intent", 1, {
        role: "candidate",
        sourceArtifactId: "stage:candidate",
        generationId: candidate.generationId,
        manifest: manifest("b"),
        packageVersion: "2.0.0",
        entrypointRelativePath: candidate.entrypointRelativePath,
      }),
    );
    record = append(
      record,
      receipt("generation-materialized", 2, {
        role: "candidate",
        generation: { ...candidate, packageVersion: "2.0.0" },
      }),
    );
    record = append(
      record,
      receipt("candidate-selection-intent", 3, { from: previous, to: candidate }),
    );
    record = append(record, receipt("candidate-selected", 4, { selection: candidate }));
    record = append(
      record,
      receipt("failure", 5, {
        operation: "doctor",
        reason: "Doctor failed",
        serviceRestored: false,
      }),
    );
    expect(
      await adjudicateUpdateGenerationTransaction(record, {
        selector: candidate,
        selectorDurable: true,
        generations: [],
        bindingConverged: true,
      }),
    ).toMatchObject({ action: "adjudicate-failure" });
    record = append(
      record,
      receipt("rollback-intent", 6, {
        from: candidate,
        to: previous,
        reason: "Doctor failed",
      }),
    );
    expect(
      await adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        selectorDurable: true,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
          { generationId: candidate.generationId, manifestSha256: candidate.manifestSha256 },
        ],
        bindingConverged: true,
      }),
    ).toMatchObject({ action: "record-rolled-back" });
    expect(() =>
      append(
        record,
        receipt("rolled-back", 7, {
          selection: previous,
          launcherVersion: "2.0.0",
          serviceRunning: true,
          serviceEnabled: true,
        }),
      ),
    ).toThrow("does not prove previous runtime and service convergence");
    record = append(
      record,
      receipt("rolled-back", 7, {
        selection: previous,
        launcherVersion: "1.0.0",
        serviceRunning: true,
        serviceEnabled: true,
      }),
    );

    expect(
      await adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        selectorDurable: true,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
          { generationId: candidate.generationId, manifestSha256: candidate.manifestSha256 },
        ],
        bindingConverged: true,
        serviceState: { running: true, enabled: true },
      }),
    ).toMatchObject({ action: "complete" });
    expect(
      await adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        selectorDurable: true,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
        ],
        bindingConverged: true,
      }),
    ).toMatchObject({ action: "inconsistent" });

    expect(() =>
      append(
        record,
        receipt("cleanup-intent", 8, {
          generationIds: [candidate.generationId],
          protectedGenerationIds: [previous.generationId, candidate.generationId],
        }),
      ),
    ).toThrow("Cleanup cannot include a protected generation");
    expect(() =>
      append(
        record,
        receipt("cleanup-intent", 8, {
          generationIds: [],
          protectedGenerationIds: [previous.generationId],
        }),
      ),
    ).toThrow("Cleanup must protect the durable active and rollback generations");

    const obsolete = "d".repeat(32);
    record = append(
      record,
      receipt("cleanup-intent", 8, {
        generationIds: [obsolete],
        protectedGenerationIds: [previous.generationId, candidate.generationId],
      }),
    );
    const cleanupWithEvidence = attachTestBrokerEvidence(
      record,
      receipt("cleanup-completed", 9, {
        removedGenerationIds: [],
        deferred: [{ generationId: obsolete, reason: "busy" }],
      }),
    );
    if (cleanupWithEvidence.kind !== "cleanup-completed") {
      throw new Error("expected cleanup receipt");
    }
    expect(() => append(record, { ...cleanupWithEvidence, deferred: [] })).toThrow(
      "Cleanup completion differs from its durable intent",
    );
  });

  it("rejects a completion claim before candidate selection", () => {
    const record = append(null, intent(selection("a"), true));
    const candidateRecord = candidateSelectedRecord({
      managed: true,
      running: true,
      enabled: true,
    }).record;
    const evidencedCompletion = attachTestBrokerEvidence(
      candidateRecord,
      receipt("completion", 5, {
        packageVersion: "2.0.0",
        launcherVersion: "2.0.0",
        serviceRunning: true,
        serviceEnabled: true,
      }),
    );
    expect(() =>
      append(record, {
        ...evidencedCompletion,
        sequence: 1,
        receiptId: buildUpdateGenerationReceiptId({
          transactionId: TRANSACTION_ID,
          sequence: 1,
          kind: "completion",
        }),
      }),
    ).toThrow("completion cannot follow intent");
  });

  it("rejects a verified binding without a previous generation", () => {
    expect(() => append(null, intent(null, true))).toThrow(
      "A verified stable binding requires a previous generation selection",
    );
    expect(() =>
      append(null, { ...intent(selection("a"), true), previousPackageVersion: null }),
    ).toThrow("Previous generation selection and package version must be recorded together");
    expect(() =>
      parseUpdateGenerationTransactionRecord({
        formatVersion: 2,
        transactionId: TRANSACTION_ID,
        namespaceKey: NAMESPACE_KEY,
        receipts: [intent(null, true)],
      }),
    ).toThrow("A verified stable binding requires a previous generation selection");
  });

  it("requires materialization and binding acknowledgements to match their intents", () => {
    const previous = selection("a");
    const candidate = selection("b");
    let record = append(null, intent(previous, true));
    record = append(
      record,
      receipt("generation-materialization-intent", 1, {
        role: "candidate",
        sourceArtifactId: "stage:candidate",
        generationId: candidate.generationId,
        manifest: manifest("b"),
        packageVersion: "2.0.0",
        entrypointRelativePath: candidate.entrypointRelativePath,
      }),
    );
    expect(() =>
      append(
        record,
        receipt("generation-materialized", 2, {
          role: "candidate",
          generation: { ...candidate, packageVersion: "2.0.1" },
        }),
      ),
    ).toThrow("descriptor does not match its intent");

    let bindingRecord = append(null, intent(null, false));
    bindingRecord = append(
      bindingRecord,
      receipt("generation-materialization-intent", 1, {
        role: "previous",
        sourceArtifactId: "live:previous",
        generationId: previous.generationId,
        manifest: manifest("a"),
        packageVersion: "1.0.0",
        entrypointRelativePath: previous.entrypointRelativePath,
      }),
    );
    bindingRecord = append(
      bindingRecord,
      receipt("generation-materialized", 2, {
        role: "previous",
        generation: { ...previous, packageVersion: "1.0.0" },
      }),
    );
    bindingRecord = append(
      bindingRecord,
      receipt("baseline-selection-intent", 3, { selection: previous }),
    );
    bindingRecord = append(bindingRecord, receipt("baseline-selected", 4, { selection: previous }));
    bindingRecord = append(
      bindingRecord,
      receipt("binding-intent", 5, {
        bindings: [
          { kind: "launcher", identity: "/manager/bin/openclaw", priorFingerprint: "old" },
          { kind: "service", identity: "gateway", priorFingerprint: "old-service" },
        ],
      }),
    );
    expect(() =>
      append(
        bindingRecord,
        receipt("binding-completed", 6, {
          bindings: [
            {
              kind: "launcher",
              identity: "/manager/bin/openclaw",
              priorFingerprint: "old",
              fingerprint: "stable",
            },
          ],
        }),
      ),
    ).toThrow("Binding completion differs from its durable intent");
  });

  it("rejects missing directory durability and retained-pair evidence", () => {
    const previous = selection("a");
    const candidate = selection("b");
    let materializing = append(null, intent(previous, true));
    materializing = append(
      materializing,
      receipt("generation-materialization-intent", 1, {
        role: "candidate",
        sourceArtifactId: "stage:candidate",
        generationId: candidate.generationId,
        manifest: manifest("b"),
        packageVersion: "2.0.0",
        entrypointRelativePath: candidate.entrypointRelativePath,
      }),
    );
    const materialized = attachTestBrokerEvidence(
      materializing,
      receipt("generation-materialized", 2, {
        role: "candidate",
        generation: { ...candidate, packageVersion: "2.0.0" },
      }),
    );
    if (materialized.kind !== "generation-materialized") {
      throw new Error("expected materialized receipt");
    }
    const missingDirectorySync = structuredClone(materialized);
    delete (missingDirectorySync.evidence as Partial<typeof missingDirectorySync.evidence>)
      .parentDirectorySync;
    expect(() => append(materializing, missingDirectorySync)).toThrow();

    const selected = candidateSelectedRecord({ managed: true, running: true, enabled: true });
    const completion = attachTestBrokerEvidence(
      selected.record,
      receipt("completion", 5, {
        packageVersion: "2.0.0",
        launcherVersion: "2.0.0",
        serviceRunning: true,
        serviceEnabled: true,
      }),
    );
    if (completion.kind !== "completion") {
      throw new Error("expected completion receipt");
    }
    const missingRetainedGeneration = structuredClone(completion);
    missingRetainedGeneration.evidence.recoveryObservation.retainedPair = null;
    missingRetainedGeneration.evidence.recoveryObservation.signature.signedPayloadSha256 =
      digestUpdateGenerationBrokerReceiptPayload(
        missingRetainedGeneration.evidence.recoveryObservation,
      );
    expect(() => append(selected.record, missingRetainedGeneration)).toThrow(
      "does not prove the selected retained pair",
    );
  });

  it("rejects broker operation replay across durable transaction receipts", () => {
    const selected = candidateSelectedRecord({ managed: true, running: true, enabled: true });
    const selectedReceipt = selected.record.receipts.find(
      (entry) => entry.kind === "candidate-selected",
    );
    if (!selectedReceipt || selectedReceipt.kind !== "candidate-selected") {
      throw new Error("expected candidate selection receipt");
    }
    const completion = attachTestBrokerEvidence(
      selected.record,
      receipt("completion", 5, {
        packageVersion: "2.0.0",
        launcherVersion: "2.0.0",
        serviceRunning: true,
        serviceEnabled: true,
      }),
    );
    if (completion.kind !== "completion") {
      throw new Error("expected completion receipt");
    }
    const replayed = structuredClone(completion);
    const retained = replayed.evidence.retainedPair;
    retained.operationId = selectedReceipt.evidence.retainedPair.operationId;
    retained.requestSha256 = digestUpdateGenerationBrokerRequest({
      formatVersion: 1,
      kind: "verify-retained-pair",
      brokerId: retained.brokerId,
      namespaceKey: retained.namespaceKey,
      transactionId: retained.transactionId,
      operationId: retained.operationId,
      expectedRevision: retained.previousRevision,
      selected: retained.retainedPair.selected,
      rollback: retained.retainedPair.rollback,
    });
    retained.signature.signedPayloadSha256 = digestUpdateGenerationBrokerReceiptPayload(retained);

    expect(() => append(selected.record, replayed)).toThrow("Broker operation id was replayed");
  });

  it("rejects corrupt durable records before adjudication", () => {
    const record = append(null, intent(selection("a"), true));
    const legacyPathRecord = structuredClone(record) as Record<string, unknown>;
    legacyPathRecord.formatVersion = 1;
    expect(() => parseUpdateGenerationTransactionRecord(legacyPathRecord)).toThrow(
      "Legacy path-backed update generation records cannot be promoted to broker evidence",
    );
    expect(() =>
      append(null, { ...intent(selection("a"), true), brokerRevision: "   " }),
    ).toThrow();

    const corruptSequence = structuredClone(record) as Record<string, unknown>;
    const receipts = corruptSequence.receipts as Array<Record<string, unknown>>;
    const firstReceipt = receipts.at(0);
    if (!firstReceipt) {
      throw new Error("expected intent receipt");
    }
    firstReceipt.sequence = 4;
    expect(() => parseUpdateGenerationTransactionRecord(corruptSequence)).toThrow();

    const unsafeEntrypoint = structuredClone(record) as Record<string, unknown>;
    const unsafeReceipts = unsafeEntrypoint.receipts as Array<Record<string, unknown>>;
    const unsafeIntent = unsafeReceipts.at(0);
    if (!unsafeIntent) {
      throw new Error("expected unsafe intent receipt");
    }
    const previous = (unsafeIntent.previousSelection as Record<string, unknown>) ?? {};
    previous.entrypointRelativePath = "../outside.mjs";
    expect(() => parseUpdateGenerationTransactionRecord(unsafeEntrypoint)).toThrow();
    expect(() =>
      append(null, {
        ...intent(selection("a"), true),
        previousSelection: {
          ...selection("a"),
          entrypointRelativePath: "../outside.mjs",
        },
      }),
    ).toThrow();
  });
});
