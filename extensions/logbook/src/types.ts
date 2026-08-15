// Shared Logbook domain shapes used by the store, pipeline, and gateway methods.

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
