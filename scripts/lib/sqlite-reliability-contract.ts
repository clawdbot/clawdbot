type ProfileId = "smoke" | "default" | "large";

export type IndexRepairJournalMode = "delete" | "wal";

export const INDEX_REPAIR_INDEX_NAME = "idx_openclaw_reliability_records_identity";
export const INDEX_REPAIR_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS openclaw_reliability_index_records (
    id INTEGER PRIMARY KEY,
    identity TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_REPAIR_INDEX_NAME}
    ON openclaw_reliability_index_records(identity);
`;

export type ProfileConfig = {
  iterations: number;
  maxWalBytes: number;
  payloadBytes: number;
  retainedBatches: number;
  rowsPerBatch: number;
  walAutoCheckpointPages: number;
  writerPauseMs: number;
};

export type CliOptions = {
  agentId: string | null;
  output: string | null;
  profile: ProfileId;
  repository: string | null;
  stateDir: string | null;
};

export type CompactionPayloadProof = {
  bytes: number;
  idSum: number;
  rows: number;
};

export type ReliabilityStateProof = {
  batches: number;
  rows: number;
  sha256: string;
};

export function formatReliabilityStderr(stderr: string): string {
  const text = stderr.trim();
  return text ? ` stderr=${JSON.stringify(text)}` : "";
}

export function assertSameCompactionPayload(
  actual: CompactionPayloadProof,
  expected: CompactionPayloadProof,
  label: string,
): void {
  if (
    actual.bytes !== expected.bytes ||
    actual.idSum !== expected.idSum ||
    actual.rows !== expected.rows
  ) {
    throw new Error(
      `${label} changed compaction payload: expected rows=${expected.rows} bytes=${expected.bytes} idSum=${expected.idSum}, got rows=${actual.rows} bytes=${actual.bytes} idSum=${actual.idSum}`,
    );
  }
}

export type ReliabilityReport = {
  arch: string;
  concurrentRestoresVerified: number;
  crashRecoveryProof: {
    committedStatePreserved: true;
    exit: {
      code: number | null;
      signal: NodeJS.Signals | null;
    };
    partialVisibleAfterRecovery: false;
    sourceRecovered: true;
    stateAfterRecovery: ReliabilityStateProof;
    stateBeforeKill: ReliabilityStateProof;
    writerRestarted: true;
  };
  iterations: number;
  indexRepairInterruptionProof: {
    rollbackJournal: {
      exit: {
        code: number | null;
        signal: NodeJS.Signals | null;
      };
      journalBytesObserved: number;
      repairedIndexes: string[];
      recoveryVerified: true;
      rowsPreserved: number;
      walBytesObserved: number;
    };
    wal: {
      exit: {
        code: number | null;
        signal: NodeJS.Signals | null;
      };
      journalBytesObserved: number;
      repairedIndexes: string[];
      recoveryVerified: true;
      rowsPreserved: number;
      walBytesObserved: number;
    };
  };
  maintenanceProof: {
    bloatBytes: number;
    compaction: {
      autoVacuum: {
        after: 2;
        before: number;
      };
      databaseBytes: {
        after: number;
        before: number;
      };
      freelistPages: {
        after: 0;
        before: number;
      };
      reclaimedBytes: number;
      walBytes: {
        after: 0;
        before: number;
      };
    };
    vacuumInterruption: {
      autoVacuumAfterRecovery: number;
      autoVacuumBeforeKill: number;
      exit: {
        code: number | null;
        signal: NodeJS.Signals | null;
      };
      journalBytesObserved: number;
      payloadAfterRecovery: CompactionPayloadProof;
      payloadBeforeKill: CompactionPayloadProof;
      recoveryVerified: true;
      stateAfterRecovery: ReliabilityStateProof;
      stateBeforeKill: ReliabilityStateProof;
      walBytesObserved: number;
    };
    postCompact: {
      restoreMs: number;
      restoreVerified: true;
      snapshotBytes: number;
      snapshotMs: number;
      state: ReliabilityStateProof;
    };
    repositoryInterruption: {
      afterCommit: {
        crashSnapshotVerifiedAfterCrash: true;
        crashSnapshotVisibleAfterCrash: true;
        exit: {
          code: number | null;
          signal: NodeJS.Signals | null;
        };
        incompleteEntries: 0;
        payload: CompactionPayloadProof;
        repositoryVerified: true;
        retryCreated: true;
        sourcePayloadPreserved: true;
        sourceStatePreserved: true;
        stagingEntries: number;
        state: ReliabilityStateProof;
        visibleSnapshotsAfterCrash: number;
      };
      beforePending: {
        crashSnapshotVerifiedAfterCrash: false;
        crashSnapshotVisibleAfterCrash: false;
        exit: {
          code: number | null;
          signal: NodeJS.Signals | null;
        };
        incompleteEntries: 1;
        payload: CompactionPayloadProof;
        repositoryVerified: true;
        retryCreated: true;
        sourcePayloadPreserved: true;
        sourceStatePreserved: true;
        stagingEntries: number;
        state: ReliabilityStateProof;
        visibleSnapshotsAfterCrash: number;
      };
      pending: {
        crashSnapshotVerifiedAfterCrash: true;
        crashSnapshotVisibleAfterCrash: true;
        exit: {
          code: number | null;
          signal: NodeJS.Signals | null;
        };
        incompleteEntries: 0;
        payload: CompactionPayloadProof;
        repositoryVerified: true;
        retryCreated: true;
        sourcePayloadPreserved: true;
        sourceStatePreserved: true;
        stagingEntries: number;
        state: ReliabilityStateProof;
        visibleSnapshotsAfterCrash: number;
      };
    };
    restoreInterruption: {
      afterPublish: {
        existingTargetPreserved: true;
        exit: {
          code: number | null;
          signal: NodeJS.Signals | null;
        };
        payloadAfterRecovery: CompactionPayloadProof;
        recoveryVerified: true;
        repositoryVerified: true;
        retryRestored: false;
        stagingEntries: number;
        stateAfterRecovery: ReliabilityStateProof;
        targetVerifiedAfterCrash: true;
        targetVisibleAfterCrash: true;
      };
      beforePublish: {
        existingTargetPreserved: false;
        exit: {
          code: number | null;
          signal: NodeJS.Signals | null;
        };
        payloadAfterRecovery: CompactionPayloadProof;
        recoveryVerified: true;
        repositoryVerified: true;
        retryRestored: true;
        stagingEntries: number;
        stateAfterRecovery: ReliabilityStateProof;
        targetVerifiedAfterCrash: false;
        targetVisibleAfterCrash: false;
      };
      snapshotBytes: number;
    };
  };
  node: string;
  paths: {
    repository: string;
    sourceDatabase: string;
    stateDir: string;
    syncedRepository: string;
  };
  platform: NodeJS.Platform;
  profile: ProfileId;
  publicationInterruptionProof: {
    afterPublish: {
      existingTargetPreserved: true;
      exit: {
        code: number | null;
        signal: NodeJS.Signals | null;
      };
      recoveryVerified: true;
      sourceStatePreserved: true;
      stagingEntries: number;
      targetVerifiedAfterCrash: true;
      targetVisibleAfterCrash: true;
    };
    beforePublish: {
      exit: {
        code: number | null;
        signal: NodeJS.Signals | null;
      };
      recoveryVerified: true;
      retryPublished: true;
      sourceStatePreserved: true;
      stagingEntries: number;
      targetVerifiedAfterCrash: false;
      targetVisibleAfterCrash: false;
    };
  };
  retainedBatches: number;
  restoresVerified: number;
  rowsPerBatch: number;
  snapshotBytes: {
    max: number;
    min: number;
  };
  target: string;
  timingsMs: {
    restoreP50: number;
    restoreP95: number;
    snapshotP50: number;
    snapshotP95: number;
    total: number;
  };
  transactionProof: {
    committedWalSentinel: true;
    heldBatch: number;
    heldRows: number;
    visibleAfterRestore: false;
  };
  walBytes: {
    after: number;
    before: number;
    limit: number;
    peak: number;
  };
  writer: {
    batchesCommitted: number;
    rowsCommitted: number;
  };
};

export const PROFILES: Record<ProfileId, ProfileConfig> = {
  smoke: {
    // One snapshot before the forced writer crash and one after restart prove
    // both distinct smoke paths; larger profiles retain repeated stress loops.
    iterations: 2,
    maxWalBytes: 64 * 1024 * 1024,
    payloadBytes: 512,
    retainedBatches: 32,
    rowsPerBatch: 8,
    walAutoCheckpointPages: 256,
    writerPauseMs: 5,
  },
  default: {
    iterations: 25,
    maxWalBytes: 512 * 1024 * 1024,
    payloadBytes: 4 * 1024,
    retainedBatches: 128,
    rowsPerBatch: 32,
    walAutoCheckpointPages: 4 * 1024,
    writerPauseMs: 5,
  },
  large: {
    iterations: 100,
    maxWalBytes: 8 * 1024 * 1024 * 1024,
    payloadBytes: 8 * 1024,
    retainedBatches: 256,
    rowsPerBatch: 64,
    walAutoCheckpointPages: 16 * 1024,
    writerPauseMs: 1,
  },
};

export const STRESS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS openclaw_reliability_sentinel (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS openclaw_reliability_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE(batch, ordinal)
  );
`;

export const COMMITTED_WAL_SENTINEL = "committed-before-ready";
