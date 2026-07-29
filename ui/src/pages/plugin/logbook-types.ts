export type LogbookStatusPayload = {
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
  lastBatch?: { id: number; day: string; status: string; endMs: number; error?: string };
  visionModel?: string;
  visionModelSource: "config" | "media-defaults" | "missing";
  today: string;
  todayCards: number;
  timeZone: string;
};

type LogbookDistractionPayload = { startMs: number; endMs: number; title: string };

export type LogbookCardPayload = {
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
  distractions: LogbookDistractionPayload[];
  keyframeId?: number;
};

type LogbookDayStatsPayload = {
  trackedMs: number;
  distractionMs: number;
  categories: Array<{ category: string; ms: number }>;
  apps: Array<{ domain: string; ms: number }>;
};

export type LogbookTimelinePayload = {
  day: string;
  cards: LogbookCardPayload[];
  stats: LogbookDayStatsPayload;
};

export type LogbookDaysPayload = {
  days: Array<{ day: string; cards: number; firstMs: number; lastMs: number }>;
};

export type LogbookUiState = {
  day: string;
  /** True once the user navigated to a specific day; unpinned views follow the gateway's today. */
  dayPinned: boolean;
  status: LogbookStatusPayload | null;
  days: LogbookDaysPayload["days"];
  timeline: LogbookTimelinePayload | null;
  loading: boolean;
  error: string | null;
  expandedCardIds: Set<number>;
  framePreviews: Map<number, string>;
  frameLoads: Set<number>;
  framePreviewFailed: Set<number>;
  standup: { day: string; text: string; updatedMs: number } | null;
  standupLoading: boolean;
  askQuestion: string;
  askAnswer: string | null;
  askLoading: boolean;
  actionPending: boolean;
  requestUpdate: (() => void) | null;
};
