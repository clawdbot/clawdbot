// Test-only compatibility for legacy file/artifact fixtures.
import "./types.js";
import "./session-accessor.types.js";

declare module "./types.js" {
  interface SessionEntryTestExtensions {
    sessionFile?: string;
  }
}

declare module "./session-accessor.types.js" {
  interface SessionTranscriptRuntimeTarget {
    sessionFile?: string;
  }

  interface SessionTranscriptTurnPersistResult {
    sessionFile?: string;
  }

  interface SessionTranscriptReadTarget {
    sessionFile?: string;
  }
}

export {};
