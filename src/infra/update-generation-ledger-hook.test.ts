import { describe, expect, it } from "vitest";
import {
  attachTestBrokerEvidence,
  createTestConfinedFilesystemForAuthentication,
} from "../../test/helpers/update-generation-broker-fixture.js";
import { TestUpdateGenerationMemoryLedger as MemoryLedger } from "../../test/helpers/update-generation-memory-ledger.js";
import {
  UpdateGenerationConfinedFilesystem,
  type UpdateGenerationAuthenticatedBrokerReceiptOf,
  type UpdateGenerationBrokerOperationKind,
  type UpdateGenerationBrokerReceipt,
  type UpdateGenerationBrokerReceiptOf,
  type UpdateGenerationBrokerRequest,
} from "./update-generation-confined-filesystem.js";
import { parseUpdateGenerationTransactionRecord } from "./update-generation-contract-parser.js";
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
  authenticateUpdateGenerationTransactionRecord,
  persistUpdateGenerationReceipt,
  type UpdateGenerationLedgerCompareAndSwapResult,
  type UpdateGenerationLedgerHook,
  type UpdateGenerationTransactionSnapshot,
} from "./update-generation-ledger-hook.js";

const TRANSACTION_ID = "update-transaction-1";
const NAMESPACE_KEY = "openclaw-global-owner";
const AUTHENTICATION_FILESYSTEM = createTestConfinedFilesystemForAuthentication();
const REJECTING_AUTHENTICATION_FILESYSTEM = createTestConfinedFilesystemForAuthentication(false);

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
    recordedAtMs: 1_788_300_000_000 + sequence,
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

function intent(previousSelection: UpdateGenerationSelection | null, stable: boolean) {
  return receipt("intent", 0, {
    namespaceKey: NAMESPACE_KEY,
    serviceBefore: { managed: true, running: true, enabled: true },
    previousSelection,
    previousPackageVersion: previousSelection ? "1.0.0" : null,
    stableBindingAlreadyVerified: stable,
    brokerId: "test-broker",
    brokerRevision: null,
  });
}

function append(
  record: UpdateGenerationTransactionRecord | null,
  next: UpdateGenerationTransactionReceipt,
): UpdateGenerationTransactionRecord {
  return appendUpdateGenerationReceipt(record, attachTestBrokerEvidence(record, next));
}

function assertDeepFrozen(value: unknown): void {
  if (!value || typeof value !== "object") {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) {
    assertDeepFrozen(child);
  }
}

class RecordingAuthenticationFilesystem extends UpdateGenerationConfinedFilesystem {
  readonly brokerId = "test-broker";
  readonly namespaceKey = NAMESPACE_KEY;
  readonly receipts: UpdateGenerationBrokerReceipt[] = [];

  static create(): RecordingAuthenticationFilesystem {
    return new RecordingAuthenticationFilesystem();
  }

  protected async invokeBroker(
    _request: UpdateGenerationBrokerRequest,
  ): Promise<UpdateGenerationBrokerReceipt> {
    throw new Error("authentication-only filesystem cannot invoke the broker");
  }

  protected async verifyBrokerSignature(): Promise<boolean> {
    return true;
  }

  override async authenticate<Kind extends UpdateGenerationBrokerOperationKind>(
    brokerReceipt: UpdateGenerationBrokerReceiptOf<Kind>,
  ): Promise<UpdateGenerationAuthenticatedBrokerReceiptOf<Kind>> {
    const authenticated = await super.authenticate(brokerReceipt);
    this.receipts.push(authenticated);
    return authenticated;
  }
}

class CapturingLedger implements UpdateGenerationLedgerHook {
  record: UpdateGenerationTransactionRecord | null = null;
  capturedReceipt: UpdateGenerationTransactionReceipt | null = null;

  constructor(private readonly snapshot: UpdateGenerationTransactionSnapshot) {}

  async read(): Promise<UpdateGenerationTransactionSnapshot> {
    return this.snapshot;
  }

  async readReceipt(): Promise<UpdateGenerationTransactionSnapshot | null> {
    return null;
  }

  async compareAndSwap(params: {
    namespaceKey: string;
    expectedRevision: string | null;
    receipt: UpdateGenerationTransactionReceipt;
    nextRecord: UpdateGenerationTransactionRecord;
  }): Promise<UpdateGenerationLedgerCompareAndSwapResult> {
    expect(params.namespaceKey).toBe(NAMESPACE_KEY);
    expect(params.expectedRevision).toBe(this.snapshot.revision);
    this.record = params.nextRecord;
    this.capturedReceipt = params.receipt;
    return { status: "stored", snapshot: { revision: "2", record: params.nextRecord } };
  }
}

describe("update generation ledger hook", () => {
  it("returns one deeply frozen authenticated graph with exact broker receipt identities", async () => {
    const candidate = selection("b");
    let record = append(null, intent(selection("a"), true));
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
    record = append(
      record,
      receipt("generation-materialized", 2, {
        role: "candidate",
        generation: { ...candidate, packageVersion: "2.0.0" },
      }),
    );
    const filesystem = RecordingAuthenticationFilesystem.create();

    const authenticated = await authenticateUpdateGenerationTransactionRecord(filesystem, record);

    expect(authenticated).not.toBe(record);
    assertDeepFrozen(authenticated);
    const materialized = authenticated.receipts.at(-1);
    if (!materialized || materialized.kind !== "generation-materialized") {
      throw new Error("expected authenticated materialization receipt");
    }
    expect(filesystem.receipts).toContain(materialized.evidence.materialization);
    expect(filesystem.receipts).toContain(materialized.evidence.parentDirectorySync);
  });

  it("persists the pre-await receipt snapshot through the exact frozen CAS graph", async () => {
    const initialRecord = append(null, intent(selection("a"), true));
    const snapshot = { revision: "1", record: initialRecord };
    const ledger = new CapturingLedger(snapshot);
    const candidateIntent = receipt("generation-materialization-intent", 1, {
      role: "candidate",
      sourceArtifactId: "original-source",
      generationId: "b".repeat(32),
      manifest: manifest("b"),
      packageVersion: "2.0.0",
      entrypointRelativePath: "openclaw.mjs",
    });

    const pending = persistUpdateGenerationReceipt({
      filesystem: AUTHENTICATION_FILESYSTEM,
      ledger,
      snapshot,
      receipt: candidateIntent,
    });
    candidateIntent.sourceArtifactId = "mutated-after-call";
    const persisted = await pending;

    const stored = ledger.record?.receipts.at(-1);
    expect(stored?.kind).toBe("generation-materialization-intent");
    if (!stored || stored.kind !== "generation-materialization-intent") {
      throw new Error("expected captured materialization intent");
    }
    expect(stored.sourceArtifactId).toBe("original-source");
    expect(ledger.capturedReceipt).toBe(stored);
    assertDeepFrozen(ledger.record);
    assertDeepFrozen(persisted);
    const returned = persisted.record.receipts.at(-1);
    expect(returned?.kind).toBe("generation-materialization-intent");
    if (returned?.kind === "generation-materialization-intent") {
      expect(returned.sourceArtifactId).toBe("original-source");
    }
  });

  it("rejects legacy path records instead of promoting them to broker evidence", () => {
    const legacy = structuredClone(append(null, intent(selection("a"), true))) as Record<
      string,
      unknown
    >;
    legacy.formatVersion = 1;
    expect(() => parseUpdateGenerationTransactionRecord(legacy)).toThrow(
      "Legacy path-backed update generation records cannot be promoted to broker evidence",
    );
  });

  it("authenticates embedded broker receipts before rebuilding transitions", async () => {
    const candidate = selection("b");
    let record = append(null, intent(selection("a"), true));
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
    record = append(
      record,
      receipt("generation-materialized", 2, {
        role: "candidate",
        generation: { ...candidate, packageVersion: "2.0.0" },
      }),
    );
    const corrupt = structuredClone(record);
    const materialized = corrupt.receipts.at(-1);
    if (!materialized || materialized.kind !== "generation-materialized") {
      throw new Error("expected materialized receipt");
    }
    materialized.sequence = 9;

    await expect(
      persistUpdateGenerationReceipt({
        filesystem: REJECTING_AUTHENTICATION_FILESYSTEM,
        ledger: new MemoryLedger(),
        snapshot: { revision: "ledger-1", record: corrupt },
        receipt: receipt("candidate-selection-intent", 3, {
          from: selection("a"),
          to: candidate,
        }),
      }),
    ).rejects.toThrow("signature was not authenticated");
  });

  it("requires CAS and makes receipt replay idempotent", async () => {
    const ledger = new MemoryLedger();
    const firstReceipt = intent(selection("a"), true);
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: null,
        ledger,
        snapshot: null,
        receipt: firstReceipt,
      }),
    ).rejects.toThrow("requires a confined filesystem provider");
    const first = await persistUpdateGenerationReceipt({
      filesystem: AUTHENTICATION_FILESYSTEM,
      ledger,
      snapshot: null,
      receipt: firstReceipt,
    });
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: null,
        receipt: firstReceipt,
      }),
    ).resolves.toEqual(first);
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: first,
        receipt: firstReceipt,
      }),
    ).resolves.toEqual(first);
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: null,
        receipt: {
          ...firstReceipt,
          serviceBefore: { ...firstReceipt.serviceBefore, running: false },
        },
      }),
    ).rejects.toThrow("replayed different receipt content");

    const fabricatedTransactionId = "fabricated-update-transaction";
    const fabricatedReceipt = {
      ...firstReceipt,
      transactionId: fabricatedTransactionId,
      receiptId: buildUpdateGenerationReceiptId({
        transactionId: fabricatedTransactionId,
        sequence: 0,
        kind: "intent",
      }),
    };
    const fabricatedRecord = appendUpdateGenerationReceipt(null, fabricatedReceipt);
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: { revision: first.revision, record: fabricatedRecord },
        receipt: fabricatedReceipt,
      }),
    ).rejects.toThrow("missing from the authoritative ledger");
    await expect(ledger.read(NAMESPACE_KEY)).resolves.toEqual(first);

    const orphanedRecord = appendUpdateGenerationReceipt(null, firstReceipt);
    const emptyLedger = new MemoryLedger();
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger: emptyLedger,
        snapshot: { revision: "fabricated", record: orphanedRecord },
        receipt: firstReceipt,
      }),
    ).rejects.toThrow("missing from the authoritative ledger");
    await expect(emptyLedger.read(NAMESPACE_KEY)).resolves.toBeNull();

    const candidateIntent = receipt("generation-materialization-intent", 1, {
      role: "candidate",
      sourceArtifactId: "stage:candidate",
      generationId: "b".repeat(32),
      manifest: manifest("b"),
      packageVersion: "2.0.0",
      entrypointRelativePath: "openclaw.mjs",
    });
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: { ...first, revision: "stale" },
        receipt: candidateIntent,
      }),
    ).rejects.toThrow("ledger revision changed");
    await expect(ledger.read(NAMESPACE_KEY)).resolves.toEqual(first);

    const second = await persistUpdateGenerationReceipt({
      filesystem: AUTHENTICATION_FILESYSTEM,
      ledger,
      snapshot: first,
      receipt: candidateIntent,
    });
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: null,
        receipt: candidateIntent,
      }),
    ).resolves.toEqual(second);
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: null,
        receipt: { ...candidateIntent, sourceArtifactId: "stage:poisoned" },
      }),
    ).rejects.toThrow("replayed different receipt content");
    await expect(ledger.read(NAMESPACE_KEY)).resolves.toEqual(second);
  });

  it("atomically rolls a cleaned namespace into a new transaction", async () => {
    const previous = selection("a");
    const candidate = selection("b");
    let priorRecord = append(null, intent(previous, true));
    priorRecord = append(
      priorRecord,
      receipt("generation-materialization-intent", 1, {
        role: "candidate",
        sourceArtifactId: "stage:candidate",
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
    const selectedRecord = priorRecord;
    priorRecord = append(
      priorRecord,
      receipt("completion", 5, {
        packageVersion: "2.0.0",
        launcherVersion: "2.0.0",
        serviceRunning: true,
        serviceEnabled: true,
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
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: { revision: priorSnapshot.revision, record: selectedRecord },
        receipt: receipt("rollback-intent", 5, {
          from: candidate,
          to: previous,
          reason: "caller supplied an authenticated record prefix",
        }),
      }),
    ).rejects.toThrow("snapshot changed");
    await expect(ledger.read(NAMESPACE_KEY)).resolves.toEqual(priorSnapshot);
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
      brokerRevision: projectUpdateGenerationTransaction(priorRecord).brokerRevision,
    };

    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: priorSnapshot,
        receipt: { ...nextIntent, brokerRevision: "stale-broker-revision" },
      }),
    ).rejects.toThrow("continue its broker revision chain");
    await expect(ledger.read(NAMESPACE_KEY)).resolves.toEqual(priorSnapshot);

    for (const malformed of [
      { ...nextIntent, previousSelection: selection("c") },
      { ...nextIntent, previousPackageVersion: "9.9.9" },
      {
        ...nextIntent,
        serviceBefore: { ...nextIntent.serviceBefore, running: false },
      },
      {
        ...nextIntent,
        serviceBefore: { ...nextIntent.serviceBefore, enabled: false },
      },
      {
        ...nextIntent,
        previousSelection: null,
        previousPackageVersion: null,
        stableBindingAlreadyVerified: false,
      },
    ]) {
      await expect(
        persistUpdateGenerationReceipt({
          filesystem: AUTHENTICATION_FILESYSTEM,
          ledger,
          snapshot: priorSnapshot,
          receipt: malformed,
        }),
      ).rejects.toThrow("continue the terminal runtime");
      await expect(ledger.read(NAMESPACE_KEY)).resolves.toEqual(priorSnapshot);
    }

    const next = await persistUpdateGenerationReceipt({
      filesystem: AUTHENTICATION_FILESYSTEM,
      ledger,
      snapshot: priorSnapshot,
      receipt: nextIntent,
    });
    expect(next.record).toEqual({
      formatVersion: 2,
      transactionId: nextTransactionId,
      namespaceKey: NAMESPACE_KEY,
      receipts: [nextIntent],
    });
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: priorSnapshot,
        receipt: nextIntent,
      }),
    ).resolves.toEqual(next);
    const historicalReceipt = priorRecord.receipts[0];
    if (!historicalReceipt) {
      throw new Error("expected a prior transaction receipt");
    }
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: priorSnapshot,
        receipt: historicalReceipt,
      }),
    ).resolves.toEqual(priorSnapshot);
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: next,
        receipt: historicalReceipt,
      }),
    ).resolves.toEqual(priorSnapshot);

    let rolledBackRecord = append(
      selectedRecord,
      receipt("rollback-intent", 5, {
        from: candidate,
        to: previous,
        reason: "post-selection verification failed",
      }),
    );
    rolledBackRecord = append(
      rolledBackRecord,
      receipt("rolled-back", 6, {
        selection: previous,
        launcherVersion: "1.0.0",
        serviceRunning: true,
        serviceEnabled: true,
      }),
    );
    rolledBackRecord = append(
      rolledBackRecord,
      receipt("cleanup-intent", 7, {
        generationIds: [],
        protectedGenerationIds: [previous.generationId, candidate.generationId],
      }),
    );
    rolledBackRecord = append(
      rolledBackRecord,
      receipt("cleanup-completed", 8, { removedGenerationIds: [], deferred: [] }),
    );
    const rolledBackSnapshot = { revision: "9", record: rolledBackRecord };
    const rolledBackLedger = new MemoryLedger(rolledBackSnapshot);
    const rolledBackTransactionId = "update-transaction-after-rollback";
    const rolledBackIntent = {
      ...intent(previous, true),
      transactionId: rolledBackTransactionId,
      receiptId: buildUpdateGenerationReceiptId({
        transactionId: rolledBackTransactionId,
        sequence: 0,
        kind: "intent",
      }),
      brokerRevision: projectUpdateGenerationTransaction(rolledBackRecord).brokerRevision,
    };
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger: rolledBackLedger,
        snapshot: rolledBackSnapshot,
        receipt: {
          ...rolledBackIntent,
          previousSelection: candidate,
          previousPackageVersion: "2.0.0",
        },
      }),
    ).rejects.toThrow("continue the terminal runtime");
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger: rolledBackLedger,
        snapshot: rolledBackSnapshot,
        receipt: rolledBackIntent,
      }),
    ).resolves.toMatchObject({
      record: { transactionId: rolledBackTransactionId, receipts: [rolledBackIntent] },
    });
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: next,
        receipt: {
          ...nextIntent,
          transactionId: "foreign-transaction",
          receiptId: buildUpdateGenerationReceiptId({
            transactionId: "foreign-transaction",
            sequence: 0,
            kind: "intent",
          }),
          namespaceKey: "foreign-namespace",
        },
      }),
    ).rejects.toThrow("snapshot belongs to a different namespace");
    const incompleteRecord = {
      ...priorRecord,
      receipts: priorRecord.receipts.slice(0, -2),
    };
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger: new MemoryLedger({ revision: "5", record: incompleteRecord }),
        snapshot: { revision: "5", record: incompleteRecord },
        receipt: nextIntent,
      }),
    ).rejects.toThrow("requires completed prior cleanup");
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger: new MemoryLedger({ revision: "5", record: priorRecord }),
        snapshot: { revision: "5", record: incompleteRecord },
        receipt: nextIntent,
      }),
    ).rejects.toThrow("snapshot changed");
  });
});
