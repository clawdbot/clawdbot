export type SessionBackfillDay = {
  day: string;
  candidateCount: number;
  topCandidates: string[];
};

type SessionBackfillBatchProgress = {
  batch: number;
  days: number;
  candidates: number;
  stagedEntries: number;
};

export type SessionBackfillResult = {
  agentId: string;
  workspaceDir: string;
  applied: boolean;
  rem: boolean;
  days: SessionBackfillDay[];
  candidateCount: number;
  stagedEntries: number;
  writtenDiaryEntries: number;
  replacedDiaryEntries: number;
  batchCount?: number;
  batches?: SessionBackfillBatchProgress[];
  rollback?: {
    removedDiaryEntries: number;
    removedStagedEntries: number;
  };
};

type SessionBackfillContinuation = {
  advanced: boolean;
  hasMore: boolean;
};

export type SessionBackfillExecution = {
  result: SessionBackfillResult;
  continuation: SessionBackfillContinuation;
};
