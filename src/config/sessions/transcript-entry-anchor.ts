/** Immutable transcript identity issued by the SQLite append transaction. */
export type TranscriptEntryAnchor = Readonly<{
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  generation: string;
  entryId: string;
  rawSeq: number;
  effectiveParentId: string | null;
  activeMessagePosition: number;
  idempotencyKey?: string;
}>;

/** Current user row bound to one recorder-owned logical turn. */
export type TranscriptTurnAdmission = TranscriptEntryAnchor &
  Readonly<{
    logicalTurnId: string;
    role: "user";
  }>;

/** Exact accepted transcript range, inclusive of admission and terminal. */
export type TranscriptTurnBoundary = Readonly<{
  admission: TranscriptTurnAdmission;
  terminal: TranscriptEntryAnchor;
}>;
