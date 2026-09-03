import { describe, expect, it } from "vitest";
import { parseUpdateGenerationTransactionRecord } from "./update-generation-contract-schema.js";
import {
  appendUpdateGenerationReceipt,
  buildUpdateGenerationReceiptId,
  persistUpdateGenerationReceipt,
  projectUpdateGenerationTransaction,
  type UpdateGenerationLedgerCompareAndSwapResult,
  type UpdateGenerationLedgerHook,
  type UpdateGenerationManifest,
  type UpdateGenerationSelection,
  type UpdateGenerationTransactionReceipt,
  type UpdateGenerationTransactionRecord,
  type UpdateGenerationTransactionSnapshot,
} from "./update-generation-contract.js";
import { adjudicateUpdateGenerationTransaction } from "./update-generation-recovery.js";

const TRANSACTION_ID = "update-transaction-1";
const NAMESPACE_KEY = "openclaw-global-owner";

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

function intent(previousSelection: UpdateGenerationSelection | null, stable: boolean) {
  return receipt("intent", 0, {
    manager: "pnpm",
    namespaceKey: NAMESPACE_KEY,
    namespaceRoot: "/manager/.openclaw-generations",
    selectorPath: "/manager/.openclaw-generations/selector.json",
    stagingRoot: "/manager/.openclaw-stage",
    serviceBefore: { managed: true, running: true, enabled: true },
    previousSelection,
    previousPackageVersion: previousSelection ? "1.0.0" : null,
    stableBindingAlreadyVerified: stable,
  });
}

function append(
  record: UpdateGenerationTransactionRecord | null,
  next: UpdateGenerationTransactionReceipt,
): UpdateGenerationTransactionRecord {
  return appendUpdateGenerationReceipt(record, next);
}

class MemoryLedger implements UpdateGenerationLedgerHook {
  #revision = 0;
  #snapshot: UpdateGenerationTransactionSnapshot | null = null;
  #receipts = new Map<string, UpdateGenerationTransactionSnapshot>();

  constructor(snapshot: UpdateGenerationTransactionSnapshot | null = null) {
    this.#snapshot = snapshot ? structuredClone(snapshot) : null;
    this.#revision = Number(snapshot?.revision ?? 0);
  }

  async read(namespaceKey: string): Promise<UpdateGenerationTransactionSnapshot | null> {
    return this.#snapshot?.record.namespaceKey === namespaceKey
      ? structuredClone(this.#snapshot)
      : null;
  }

  async compareAndSwap(params: {
    namespaceKey: string;
    expectedRevision: string | null;
    receipt: UpdateGenerationTransactionReceipt;
    nextRecord: UpdateGenerationTransactionRecord;
  }): Promise<UpdateGenerationLedgerCompareAndSwapResult> {
    const replay = this.#receipts.get(params.receipt.receiptId);
    if (replay) {
      return { status: "replayed", snapshot: structuredClone(replay) };
    }
    if ((this.#snapshot?.revision ?? null) !== params.expectedRevision) {
      return {
        status: "conflict",
        snapshot: this.#snapshot ? structuredClone(this.#snapshot) : null,
      };
    }
    this.#revision += 1;
    this.#snapshot = {
      revision: String(this.#revision),
      record: structuredClone(params.nextRecord),
    };
    this.#receipts.set(params.receipt.receiptId, this.#snapshot);
    return { status: "stored", snapshot: structuredClone(this.#snapshot) };
  }
}

describe("durable update generation transaction contract", () => {
  it("serializes a complete existing-binding activation without methods", () => {
    const previous = selection("a");
    const candidate = selection("b");
    let record = append(null, intent(previous, true));
    expect(
      adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        generations: [],
        bindingConverged: true,
      }),
    ).toMatchObject({ action: "resume-materialization", role: "candidate" });
    record = append(
      record,
      receipt("generation-materialization-intent", 1, {
        role: "candidate",
        sourceRoot: "/stage/candidate",
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
      adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        generations: [],
        bindingConverged: true,
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
      adjudicateUpdateGenerationTransaction(roundTrip, {
        selector: candidate,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
          { generationId: candidate.generationId, manifestSha256: candidate.manifestSha256 },
        ],
        bindingConverged: true,
      }),
    ).toEqual({ action: "complete", reason: "completion receipt and selector agree" });
    expect(
      adjudicateUpdateGenerationTransaction(roundTrip, {
        selector: candidate,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
        ],
        bindingConverged: true,
      }),
    ).toMatchObject({ action: "inconsistent" });
    expect(
      adjudicateUpdateGenerationTransaction(roundTrip, {
        selector: candidate,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
          { generationId: candidate.generationId, manifestSha256: candidate.manifestSha256 },
        ],
        bindingConverged: false,
      }),
    ).toMatchObject({ action: "inconsistent" });
  });

  it("adjudicates every mutation boundary from durable intent and physical state", () => {
    const previous = selection("a");
    const candidate = selection("b");
    let record = append(null, intent(null, false));
    record = append(
      record,
      receipt("generation-materialization-intent", 1, {
        role: "previous",
        sourceRoot: "/live/owner",
        generationId: previous.generationId,
        manifest: manifest("a"),
        packageVersion: "1.0.0",
        entrypointRelativePath: previous.entrypointRelativePath,
      }),
    );
    expect(
      adjudicateUpdateGenerationTransaction(record, {
        selector: null,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
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
      adjudicateUpdateGenerationTransaction(record, {
        selector: null,
        generations: [],
        bindingConverged: false,
      }),
    ).toMatchObject({ action: "persist-baseline-selection-intent", role: "previous" });
    record = append(record, receipt("baseline-selection-intent", 3, { selection: previous }));
    expect(
      adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        generations: [],
        bindingConverged: false,
      }),
    ).toMatchObject({ action: "record-baseline-selected" });
    record = append(record, receipt("baseline-selected", 4, { selection: previous }));
    expect(
      adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        generations: [],
        bindingConverged: false,
      }),
    ).toMatchObject({ action: "persist-binding-intent" });
    expect(
      adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        generations: [],
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
      adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        generations: [],
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
        sourceRoot: "/stage/candidate",
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
      adjudicateUpdateGenerationTransaction(record, {
        selector: candidate,
        generations: [],
        bindingConverged: true,
      }),
    ).toMatchObject({ action: "record-candidate-selected" });
  });

  it("makes rollback selector-only and protects both retained generations from cleanup", () => {
    const previous = selection("a");
    const candidate = selection("b");
    let record = append(null, intent(previous, true));
    record = append(
      record,
      receipt("generation-materialization-intent", 1, {
        role: "candidate",
        sourceRoot: "/stage/candidate",
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
      adjudicateUpdateGenerationTransaction(record, {
        selector: candidate,
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
      adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        generations: [],
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
        }),
      ),
    ).toThrow("does not prove previous runtime and service convergence");
    record = append(
      record,
      receipt("rolled-back", 7, {
        selection: previous,
        launcherVersion: "1.0.0",
        serviceRunning: true,
      }),
    );

    expect(
      adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
        generations: [
          { generationId: previous.generationId, manifestSha256: previous.manifestSha256 },
          { generationId: candidate.generationId, manifestSha256: candidate.manifestSha256 },
        ],
        bindingConverged: true,
      }),
    ).toMatchObject({ action: "complete" });
    expect(
      adjudicateUpdateGenerationTransaction(record, {
        selector: previous,
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
    expect(() =>
      append(
        record,
        receipt("cleanup-completed", 9, {
          removedGenerationIds: [],
          deferred: [],
        }),
      ),
    ).toThrow("Cleanup completion differs from its durable intent");
  });

  it("requires CAS and makes receipt replay idempotent", async () => {
    const ledger = new MemoryLedger();
    const firstReceipt = intent(selection("a"), true);
    const first = await persistUpdateGenerationReceipt({
      ledger,
      snapshot: null,
      receipt: firstReceipt,
    });
    const replayed = await persistUpdateGenerationReceipt({
      ledger,
      snapshot: null,
      receipt: firstReceipt,
    });
    expect(replayed).toEqual(first);
    const replayedAfterRead = await persistUpdateGenerationReceipt({
      ledger,
      snapshot: first,
      receipt: firstReceipt,
    });
    expect(replayedAfterRead).toEqual(first);
    const conflictingReplay = { ...firstReceipt, manager: "bun" as const };
    await expect(
      persistUpdateGenerationReceipt({
        ledger,
        snapshot: null,
        receipt: conflictingReplay,
      }),
    ).rejects.toThrow("replayed different receipt content");

    const candidateIntent = receipt("generation-materialization-intent", 1, {
      role: "candidate",
      sourceRoot: "/stage/candidate",
      generationId: "b".repeat(32),
      manifest: manifest("b"),
      packageVersion: "2.0.0",
      entrypointRelativePath: "openclaw.mjs",
    });
    await expect(
      persistUpdateGenerationReceipt({
        ledger,
        snapshot: { ...first, revision: "stale" },
        receipt: candidateIntent,
      }),
    ).rejects.toThrow("ledger revision changed");
    await expect(ledger.read(NAMESPACE_KEY)).resolves.toEqual(first);
  });

  it("atomically rolls a cleaned namespace into a new transaction", async () => {
    const previous = selection("a");
    const candidate = selection("b");
    let priorRecord = append(null, intent(previous, true));
    priorRecord = append(
      priorRecord,
      receipt("generation-materialization-intent", 1, {
        role: "candidate",
        sourceRoot: "/stage/candidate",
        generationId: candidate.generationId,
        manifest: manifest("b"),
        packageVersion: "2.0.0",
        entrypointRelativePath: candidate.entrypointRelativePath,
      }),
    );
    priorRecord = append(
      priorRecord,
      receipt("generation-materialized", 2, {
        role: "candidate",
        generation: { ...candidate, packageVersion: "2.0.0" },
      }),
    );
    priorRecord = append(
      priorRecord,
      receipt("candidate-selection-intent", 3, { from: previous, to: candidate }),
    );
    priorRecord = append(priorRecord, receipt("candidate-selected", 4, { selection: candidate }));
    priorRecord = append(
      priorRecord,
      receipt("completion", 5, {
        packageVersion: "2.0.0",
        launcherVersion: "2.0.0",
        serviceRunning: true,
      }),
    );
    priorRecord = append(
      priorRecord,
      receipt("cleanup-intent", 6, {
        generationIds: [],
        protectedGenerationIds: [previous.generationId, candidate.generationId],
      }),
    );
    priorRecord = append(
      priorRecord,
      receipt("cleanup-completed", 7, { removedGenerationIds: [], deferred: [] }),
    );
    const priorSnapshot = { revision: "8", record: priorRecord };
    const ledger = new MemoryLedger(priorSnapshot);
    const nextTransactionId = "update-transaction-2";
    const nextIntent = {
      ...intent(candidate, true),
      transactionId: nextTransactionId,
      receiptId: buildUpdateGenerationReceiptId({
        transactionId: nextTransactionId,
        sequence: 0,
        kind: "intent",
      }),
      previousPackageVersion: "2.0.0",
    };

    const next = await persistUpdateGenerationReceipt({
      ledger,
      snapshot: priorSnapshot,
      receipt: nextIntent,
    });
    expect(next.record).toEqual({
      formatVersion: 1,
      transactionId: nextTransactionId,
      namespaceKey: NAMESPACE_KEY,
      receipts: [nextIntent],
    });
    await expect(
      persistUpdateGenerationReceipt({
        ledger: new MemoryLedger({ revision: "5", record: priorRecord }),
        snapshot: {
          revision: "5",
          record: { ...priorRecord, receipts: priorRecord.receipts.slice(0, -2) },
        },
        receipt: nextIntent,
      }),
    ).rejects.toThrow("requires completed prior cleanup");
  });

  it("rejects a completion claim before candidate selection", () => {
    const record = append(null, intent(selection("a"), true));
    expect(() =>
      append(
        record,
        receipt("completion", 1, {
          packageVersion: "2.0.0",
          launcherVersion: "2.0.0",
          serviceRunning: true,
        }),
      ),
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
        formatVersion: 1,
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
        sourceRoot: "/stage/candidate",
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
        sourceRoot: "/live/previous",
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

  it("rejects corrupt durable records before adjudication", () => {
    const record = append(null, intent(selection("a"), true));
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
  });
});
