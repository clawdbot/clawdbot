// Shared Logbook domain shapes used by the store, pipeline, and gateway methods.
import type { Generated } from "openclaw/plugin-sdk/sqlite-runtime";

export type LogbookFrame = {
  id: number;
  capturedAtMs: number;
  day: string;
  path: string;
  screenIndex: number;
  width?: number;
  height?: number;
  byteSize: number;
  idle: boolean;
};

export type LogbookBatchStatus = "pending" | "running" | "done" | "error";

export type LogbookBatch = {
  id: number;
  day: string;
  startMs: number;
  endMs: number;
  status: LogbookBatchStatus;
  error?: string;
  frameCount: number;
  model?: string;
};

export type LogbookObservation = {
  id: number;
  batchId: number;
  day: string;
  startMs: number;
  endMs: number;
  text: string;
};

export type LogbookDistraction = {
  startMs: number;
  endMs: number;
  title: string;
};

export type LogbookCard = {
  id: number;
  day: string;
  startMs: number;
  endMs: number;
  title: string;
  summary: string;
  detail: string;
  category: string;
  appPrimary?: string;
  appSecondary?: string;
  distractions: LogbookDistraction[];
  keyframeId?: number;
};

export type LogbookCardDraft = Omit<LogbookCard, "id">;

export type LogbookDayStats = {
  trackedMs: number;
  distractionMs: number;
  categories: Array<{ category: string; ms: number }>;
  apps: Array<{ domain: string; ms: number }>;
};

export type LogbookStatus = {
  captureEnabled: boolean;
  capturePaused: boolean;
  captureIntervalSeconds: number;
  analysisIntervalMinutes: number;
  retentionDays: number;
  nodeId?: string;
  nodeName?: string;
  lastCaptureAtMs?: number;
  lastCaptureError?: string;
  pendingFrames: number;
  analysisRunning: boolean;
  lastBatch?: Pick<LogbookBatch, "id" | "day" | "status" | "endMs" | "error">;
  visionModel?: string;
  visionModelSource: "config" | "media-defaults" | "missing";
  today: string;
  todayCards: number;
  timeZone: string;
};

export type LogbookDatabase = {
  frames: {
    id: Generated<number>;
    captured_at_ms: number;
    day: string;
    path: string;
    screen_index: number;
    width: number | null;
    height: number | null;
    byte_size: number;
    content_hash: string;
    idle: number;
    batch_id: number | null;
  };
  batches: {
    id: Generated<number>;
    day: string;
    start_ms: number;
    end_ms: number;
    status: LogbookBatchStatus;
    error: string | null;
    frame_count: number;
    model: string | null;
    created_ms: number;
    updated_ms: number;
  };
  observations: {
    id: Generated<number>;
    batch_id: number;
    day: string;
    start_ms: number;
    end_ms: number;
    text: string;
  };
  cards: {
    id: Generated<number>;
    day: string;
    start_ms: number;
    end_ms: number;
    title: string;
    summary: string;
    detail: string;
    category: string;
    app_primary: string | null;
    app_secondary: string | null;
    distractions: string;
    keyframe_id: number | null;
    updated_ms: number;
  };
  standups: { day: string; text: string; updated_ms: number };
};
