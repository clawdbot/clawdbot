// Shared trajectory support-bundle schema. Runtime, transcript, and export code
// all emit this versioned JSONL shape so external debugging tools can replay it.
export type TrajectoryEventSource = "runtime" | "transcript" | "export";

// Serialized tool definition captured with compiled context events.
export type TrajectoryToolDefinition = {
  name: string;
  description?: string;
  parameters?: unknown;
};

// Versioned event envelope for runtime and transcript-derived trajectory rows.
export type TrajectoryEvent = {
  traceSchema: "openclaw-trajectory";
  schemaVersion: 1;
  traceId: string;
  source: TrajectoryEventSource;
  type: string;
  ts: string;
  seq: number;
  sourceSeq?: number;
  sessionId: string;
  sessionKey?: string;
  runId?: string;
  workspaceDir?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  entryId?: string;
  parentEntryId?: string | null;
  data?: Record<string, unknown>;
};

// Bundle manifest written beside events.jsonl in trajectory exports.
export type TrajectoryBundleManifest = {
  traceSchema: "openclaw-trajectory";
  schemaVersion: 1;
  generatedAt: string;
  traceId: string;
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  leafId: string | null;
  eventCount: number;
  runtimeEventCount: number;
  transcriptEventCount: number;
  sourceFiles: {
    session: string;
    runtime?: string;
  };
  contents?: Array<{
    path: string;
    mediaType: string;
    bytes: number;
  }>;
  supplementalFiles?: string[];
  warnings?: TrajectoryBundleWarning[];
};

// Parse/export warnings are grouped in the manifest with sample row numbers.
export type TrajectoryBundleWarning = {
  source: "session" | "runtime";
  code:
    | "invalid-session-json"
    | "invalid-session-row"
    | "incomplete-session-branch"
    | "cyclic-session-branch"
    | "invalid-runtime-json"
    | "invalid-runtime-event";
  count: number;
  rows: number[];
  message: string;
};
