import { describe, expect, it } from "vitest";
import {
  attachTestBrokerEvidence,
  authenticateTestRecoveryObservation,
} from "../../test/helpers/update-generation-broker-fixture.js";
import {
  appendUpdateGenerationReceipt,
  buildUpdateGenerationReceiptId,
  type UpdateGenerationManifest,
  type UpdateGenerationSelection,
  type UpdateGenerationTransactionReceipt,
  type UpdateGenerationTransactionRecord,
} from "./update-generation-contract.js";
import { adjudicateUpdateGenerationTransaction } from "./update-generation-recovery.js";

const TRANSACTION_ID = "recovery-admission";

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
    receiptId: buildUpdateGenerationReceiptId({ transactionId: TRANSACTION_ID, sequence, kind }),
    recordedAtMs: 1_788_300_200_000 + sequence,
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
  return appendUpdateGenerationReceipt(record, attachTestBrokerEvidence(record, next));
}

function rollbackIntentRecord(): {
  record: UpdateGenerationTransactionRecord;
  previous: UpdateGenerationSelection;
  candidate: UpdateGenerationSelection;
} {
  const previous = selection("a");
  const candidate = selection("b");
  const receipts: UpdateGenerationTransactionReceipt[] = [
    receipt("intent", 0, {
      namespaceKey: "openclaw-global-owner",
      serviceBefore: { managed: true, running: true, enabled: true },
      previousSelection: previous,
      previousPackageVersion: "1.0.0",
      stableBindingAlreadyVerified: true,
      brokerId: "test-broker",
      brokerRevision: null,
    }),
    receipt("generation-materialization-intent", 1, {
      role: "candidate",
      sourceArtifactId: "manager:stage",
      generationId: candidate.generationId,
      manifest: manifest("b"),
      packageVersion: "2.0.0",
      entrypointRelativePath: candidate.entrypointRelativePath,
    }),
    receipt("generation-materialized", 2, {
      role: "candidate",
      generation: { ...candidate, packageVersion: "2.0.0" },
    }),
    receipt("candidate-selection-intent", 3, { from: previous, to: candidate }),
    receipt("candidate-selected", 4, { selection: candidate }),
    receipt("failure", 5, {
      operation: "doctor",
      reason: "Doctor failed",
      serviceRestored: false,
    }),
    receipt("rollback-intent", 6, {
      from: candidate,
      to: previous,
      reason: "Doctor failed",
    }),
  ];
  let record: UpdateGenerationTransactionRecord | null = null;
  for (const next of receipts) {
    record = append(record, next);
  }
  if (!record) {
    throw new Error("expected rollback intent record");
  }
  return { record, previous, candidate };
}

async function authenticatedRecoveryInput(
  serviceState: {
    running: boolean;
    enabled?: boolean;
  } | null,
) {
  const { record, previous, candidate } = rollbackIntentRecord();
  const authenticated = await authenticateTestRecoveryObservation({
    record,
    physical: {
      selector: previous,
      selectorDurable: true,
      generations: [previous, candidate].map(({ generationId, manifestSha256 }) => ({
        generationId,
        manifestSha256,
        parentDirectoryDurable: true,
      })),
      bindingConverged: true,
      serviceState,
    },
  });
  return { record, ...authenticated };
}

describe("update generation recovery admission", () => {
  it("requires observed running and enabled state before recording rollback", async () => {
    for (const serviceState of [null, { running: false }, { running: true, enabled: false }]) {
      const input = await authenticatedRecoveryInput(serviceState);
      await expect(
        adjudicateUpdateGenerationTransaction(
          input.record,
          input.filesystem,
          input.observation,
          input.runtime,
        ),
      ).resolves.toMatchObject({ action: "inconsistent" });
    }

    const input = await authenticatedRecoveryInput({ running: true, enabled: true });
    await expect(
      adjudicateUpdateGenerationTransaction(
        input.record,
        input.filesystem,
        input.observation,
        input.runtime,
      ),
    ).resolves.toMatchObject({ action: "record-rolled-back" });
  });

  it("strictly decodes runtime recovery observations before adjudication", async () => {
    const input = await authenticatedRecoveryInput({ running: true, enabled: true });
    const malformedRuntimeObservations: unknown[] = [
      { bindingConverged: "false", serviceState: input.runtime.serviceState },
      { bindingConverged: true, serviceState: { running: "true", enabled: true } },
      { bindingConverged: true, serviceState: { running: true, enabled: "true" } },
      { bindingConverged: true, serviceState: { running: true, enabled: undefined } },
      { bindingConverged: true, serviceState: input.runtime.serviceState, extra: true },
      Object.assign(Object.create({ bindingConverged: true }), { serviceState: null }),
    ];

    for (const runtime of malformedRuntimeObservations) {
      await expect(
        adjudicateUpdateGenerationTransaction(
          input.record,
          input.filesystem,
          input.observation,
          runtime as never,
        ),
      ).rejects.toThrow("runtime");
    }
  });
});
