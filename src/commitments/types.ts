export type CommitmentKind = "event_check_in" | "deadline_check" | "care_check_in" | "open_loop";

export type CommitmentSensitivity = "routine" | "personal" | "care";

export type CommitmentStatus = "pending" | "sent" | "dismissed" | "snoozed" | "expired";

export type CommitmentSource = "inferred_user_context" | "agent_promise";

export type CommitmentScope = {
  agentId: string;
  sessionKey: string;
  channel: string;
  accountId?: string;
  to?: string;
  threadId?: string;
  senderId?: string;
};

export type CommitmentDueWindow = {
  earliestMs: number;
  latestMs: number;
  timezone: string;
};

export type CommitmentRecord = CommitmentScope & {
  id: string;
  kind: CommitmentKind;
  sensitivity: CommitmentSensitivity;
  source: CommitmentSource;
  status: CommitmentStatus;
  reason: string;
  suggestedText: string;
  dedupeKey: string;
  confidence: number;
  dueWindow: CommitmentDueWindow;
  sourceMessageId?: string;
  sourceRunId?: string;
  /** @deprecated Legacy-only field from early stores. Do not replay this into delivery prompts. */
  sourceUserText?: string;
  /** @deprecated Legacy-only field from early stores. Do not replay this into delivery prompts. */
  sourceAssistantText?: string;
  createdAtMs: number;
  updatedAtMs: number;
  attempts: number;
  lastAttemptAtMs?: number;
  sentAtMs?: number;
  dismissedAtMs?: number;
  snoozedUntilMs?: number;
  expiredAtMs?: number;
};

export type CommitmentStoreFile = {
  version: 1;
  commitments: CommitmentRecord[];
};

export type CommitmentCandidate = {
  itemId: string;
  kind: CommitmentKind;
  sensitivity: CommitmentSensitivity;
  source: CommitmentSource;
  reason: string;
  suggestedText: string;
  dedupeKey: string;
  confidence: number;
  dueWindow: {
    earliest: string;
    latest?: string;
    timezone?: string;
  };
};

export type CommitmentExtractionItem = CommitmentScope & {
  itemId: string;
  nowMs: number;
  timezone: string;
  userText: string;
  assistantText?: string;
  sourceMessageId?: string;
  sourceRunId?: string;
  existingPending: Array<{
    kind: CommitmentKind;
    reason: string;
    dedupeKey: string;
    earliestMs: number;
    latestMs: number;
  }>;
};

export type CommitmentExtractionBatchResult = {
  candidates: CommitmentCandidate[];
};
