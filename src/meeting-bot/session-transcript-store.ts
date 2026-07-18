import type {
  MeetingSessionRecord,
  MeetingTranscriptLine,
  MeetingTranscriptSnapshot,
} from "./session-types.js";

type RetainedTranscriptSnapshot = MeetingTranscriptSnapshot & {
  pageEpoch?: string;
  pageNextIndex: number;
};

const ENDED_TRANSCRIPTS_MAX = 4;
const TRANSCRIPT_MAX_LINES = 2_000;

export class MeetingSessionTranscriptStore<TSession extends MeetingSessionRecord> {
  readonly #transcripts = new Map<string, RetainedTranscriptSnapshot>();
  readonly #captures = new Map<string, Promise<void>>();
  readonly #finalizing = new Set<string>();
  readonly #retired = new Set<string>();

  constructor(
    private readonly options: {
      getSession(sessionId: string): TSession | undefined;
      isBrowserSession(session: TSession): boolean;
      isTranscribeSession(session: TSession): boolean;
      hasBrowserTab(session: TSession): boolean;
      capture(
        session: TSession,
        options?: { finalize?: boolean },
      ): Promise<MeetingTranscriptSnapshot | undefined>;
    },
  ) {}

  async read(
    sessionId: string,
    options: { sinceIndex?: number } = {},
  ): Promise<{
    found: boolean;
    sessionId?: string;
    startIndex?: number;
    nextIndex?: number;
    droppedLines?: number;
    evicted?: boolean;
    lines?: MeetingTranscriptLine[];
  }> {
    const session = this.options.getSession(sessionId);
    if (!session) {
      return { found: false };
    }
    if (!this.options.isTranscribeSession(session)) {
      throw new Error("transcript is only available for transcribe-mode sessions");
    }
    const sinceIndex = options.sinceIndex ?? 0;
    if (!Number.isSafeInteger(sinceIndex) || sinceIndex < 0) {
      throw new Error("sinceIndex must be a non-negative safe integer");
    }
    if (session.state === "active" && !this.#finalizing.has(session.id)) {
      await this.capture(session);
    }
    const snapshot = this.#transcripts.get(sessionId) ?? { droppedLines: 0, lines: [] };
    const startIndex = Math.max(sinceIndex, snapshot.droppedLines);
    return {
      found: true,
      sessionId,
      startIndex,
      nextIndex: snapshot.droppedLines + snapshot.lines.length,
      droppedLines: snapshot.droppedLines,
      ...(session.transcriptEvicted ? { evicted: true } : {}),
      lines: snapshot.lines.slice(startIndex - snapshot.droppedLines),
    };
  }

  startFinalizing(sessionId: string): void {
    this.#finalizing.add(sessionId);
  }

  finishFinalizing(sessionId: string): void {
    this.#finalizing.delete(sessionId);
  }

  async capture(session: TSession, options: { finalize?: boolean } = {}): Promise<void> {
    const previous = this.#captures.get(session.id) ?? Promise.resolve();
    const capture = previous
      .catch(() => {})
      .then(async () => {
        if (
          !this.options.isBrowserSession(session) ||
          !this.options.isTranscribeSession(session) ||
          !this.options.hasBrowserTab(session)
        ) {
          return;
        }
        const snapshot = await this.options.capture(session, options);
        if (snapshot) {
          this.#merge(session.id, snapshot);
        }
      });
    this.#captures.set(session.id, capture);
    try {
      await capture;
    } finally {
      if (this.#captures.get(session.id) === capture) {
        this.#captures.delete(session.id);
      }
    }
  }

  retire(sessionId: string): void {
    const snapshot = this.#transcripts.get(sessionId);
    if (snapshot) {
      this.#transcripts.delete(sessionId);
      this.#transcripts.set(sessionId, snapshot);
      this.#retired.delete(sessionId);
      this.#retired.add(sessionId);
    }
    const retainedIds = [...this.#retired]
      .filter((id) => this.#transcripts.has(id))
      .toSorted((left, right) =>
        (this.options.getSession(left)?.updatedAt ?? "").localeCompare(
          this.options.getSession(right)?.updatedAt ?? "",
        ),
      );
    for (const id of retainedIds.slice(0, -ENDED_TRANSCRIPTS_MAX)) {
      this.#transcripts.delete(id);
      this.#retired.delete(id);
      const session = this.options.getSession(id);
      if (session) {
        session.transcriptEvicted = true;
      }
    }
  }

  #merge(sessionId: string, snapshot: MeetingTranscriptSnapshot): void {
    const pageNextIndex = snapshot.droppedLines + snapshot.lines.length;
    const retained = this.#transcripts.get(sessionId);
    if (!retained) {
      const excess = Math.max(0, snapshot.lines.length - TRANSCRIPT_MAX_LINES);
      // Keep the page's absolute next cursor while retaining only its bounded tail.
      // Advancing droppedLines preserves stable indices for the retained lines.
      this.#transcripts.set(sessionId, {
        droppedLines: snapshot.droppedLines + excess,
        lines: excess > 0 ? snapshot.lines.slice(excess) : snapshot.lines,
        pageEpoch: snapshot.epoch,
        pageNextIndex,
      });
      return;
    }
    const retainedNextIndex = retained.droppedLines + retained.lines.length;
    if (retained.pageEpoch !== snapshot.epoch) {
      if (snapshot.droppedLines > 0) {
        // A new page epoch with an already-trimmed prefix leaves a cursor gap.
        // Keep only its contiguous tail so older lines never move to new indices.
        retained.droppedLines = retainedNextIndex + snapshot.droppedLines;
        retained.lines = [...snapshot.lines];
      } else {
        retained.lines.push(...snapshot.lines);
      }
      retained.pageEpoch = snapshot.epoch;
      retained.pageNextIndex = pageNextIndex;
    } else if (pageNextIndex > retained.pageNextIndex) {
      if (snapshot.droppedLines > retained.pageNextIndex) {
        // Preserve the accumulated cross-epoch offset, but discard the stale segment
        // before the page gap instead of shifting it under the new cursor range.
        const pageOffset = retainedNextIndex - retained.pageNextIndex;
        retained.droppedLines = pageOffset + snapshot.droppedLines;
        retained.lines = [...snapshot.lines];
      } else {
        retained.lines.push(
          ...snapshot.lines.slice(retained.pageNextIndex - snapshot.droppedLines),
        );
      }
      retained.pageNextIndex = pageNextIndex;
    }
    const excess = retained.lines.length - TRANSCRIPT_MAX_LINES;
    if (excess > 0) {
      retained.lines.splice(0, excess);
      retained.droppedLines += excess;
    }
  }
}
