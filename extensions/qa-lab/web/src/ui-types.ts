import type {
  QaEvidenceArtifactView,
  QaEvidenceGalleryEntryView,
  QaEvidenceGalleryModel,
  QaEvidenceMatrixCellView,
  QaEvidenceProducerContext,
  QaEvidenceProducerContextFile,
} from "../../shared/evidence-gallery-types.js";

/* ===== Shared types (unchanged from the bus protocol) ===== */

export type Conversation = {
  accountId: string;
  id: string;
  kind: "direct" | "channel";
  title?: string;
};

export type Attachment = {
  id: string;
  kind: "image" | "video" | "audio" | "file";
  mimeType: string;
  fileName?: string;
  inline?: boolean;
  url?: string;
  contentBase64?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  altText?: string;
  transcript?: string;
};

export type Thread = {
  accountId: string;
  id: string;
  conversationId: string;
  title: string;
};

export type Message = {
  accountId: string;
  id: string;
  direction: "inbound" | "outbound";
  conversation: Omit<Conversation, "accountId">;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: number;
  threadId?: string;
  threadTitle?: string;
  deleted?: boolean;
  editedAt?: number;
  attachments?: Attachment[];
  reactions: Array<{ emoji: string; senderId: string }>;
};

type BusEvent =
  | { cursor: number; kind: "thread-created"; thread: Thread }
  | { cursor: number; kind: string; message?: Message; emoji?: string };

export type Snapshot = {
  conversations: Conversation[];
  threads: Thread[];
  messages: Message[];
  events: BusEvent[];
};

export type ReportEnvelope = {
  report: null | {
    outputPath: string;
    markdown: string;
    generatedAt: string;
  };
};

export type SeedScenario = {
  id: string;
  title: string;
  surface: string;
  objective: string;
  successCriteria: string[];
  docsRefs?: string[];
  codeRefs?: string[];
};

export type Bootstrap = {
  baseUrl: string;
  latestReport: ReportEnvelope["report"];
  controlUiUrl: string | null;
  controlUiEmbeddedUrl: string | null;
  kickoffTask: string;
  scenarios: SeedScenario[];
  defaults: {
    conversationKind: "direct" | "channel";
    conversationId: string;
    senderId: string;
    senderName: string;
  };
  runner: RunnerSnapshot;
  runnerCatalog: {
    status: "loading" | "ready" | "failed";
    real: RunnerModelOption[];
  };
};

type ScenarioStep = {
  name: string;
  status: "pass" | "fail" | "skip";
  details?: string;
};

export type ScenarioOutcome = {
  id: string;
  name: string;
  status: "pending" | "running" | "pass" | "fail" | "skip";
  details?: string;
  steps?: ScenarioStep[];
  startedAt?: string;
  finishedAt?: string;
};

type ScenarioRun = {
  kind: "suite" | "self-check";
  status: "idle" | "running" | "completed";
  startedAt?: string;
  finishedAt?: string;
  scenarios: ScenarioOutcome[];
  counts: {
    total: number;
    pending: number;
    running: number;
    passed: number;
    failed: number;
    skipped: number;
  };
};

export type RunnerSelection = {
  providerMode: "mock-openai" | "live-frontier";
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  scenarioIds: string[];
};

type RunnerSnapshot = {
  status: "idle" | "running" | "completed" | "failed";
  selection: RunnerSelection;
  startedAt?: string;
  finishedAt?: string;
  artifacts: null | {
    evidencePath: string;
    outputDir: string;
    reportPath: string;
    summaryPath: string;
    watchUrl: string;
  };
  error: string | null;
};

export type RunnerModelOption = {
  key: string;
  name: string;
  provider: string;
  input: string;
  preferred: boolean;
};

export type OutcomesEnvelope = {
  run: ScenarioRun | null;
};

type CaptureSessionSummary = {
  id: string;
  startedAt: number;
  endedAt?: number;
  mode: string;
  sourceProcess: string;
  proxyUrl?: string;
  eventCount: number;
};

export type CaptureEventView = {
  id?: number;
  ts: number;
  protocol: string;
  direction: string;
  kind: string;
  flowId: string;
  method?: string;
  host?: string;
  path?: string;
  status?: number;
  closeCode?: number;
  contentType?: string;
  headersJson?: string;
  dataText?: string;
  payloadPreview?: string;
  dataBlobId?: string;
  errorText?: string;
  provider?: string;
  api?: string;
  model?: string;
  captureOrigin?: string;
};

export type CaptureQueryPreset =
  | "none"
  | "double-sends"
  | "retry-storms"
  | "cache-busting"
  | "ws-duplicate-frames"
  | "missing-ack"
  | "error-bursts";

export type CaptureSessionsEnvelope = {
  sessions: CaptureSessionSummary[];
};

export type CaptureEventsEnvelope = {
  events: CaptureEventView[];
};

export type CaptureQueryEnvelope = {
  rows: Array<Record<string, string | number | null>>;
};

type CaptureObservedDimension = {
  value: string;
  count: number;
};

type CaptureCoverageSummary = {
  sessionId: string;
  totalEvents: number;
  unlabeledEventCount: number;
  providers: CaptureObservedDimension[];
  apis: CaptureObservedDimension[];
  models: CaptureObservedDimension[];
  hosts: CaptureObservedDimension[];
  localPeers: CaptureObservedDimension[];
};

export type CaptureCoverageEnvelope = {
  coverage: CaptureCoverageSummary;
};

export type CaptureStartupProbeStatus = {
  label: string;
  url: string;
  ok: boolean;
  error?: string;
};

export type CaptureStartupStatus = {
  proxy: CaptureStartupProbeStatus;
  gateway: CaptureStartupProbeStatus;
  qaLab: CaptureStartupProbeStatus;
};

export type CaptureStartupStatusEnvelope = {
  status: CaptureStartupStatus;
};

type EvidenceStatus = QaEvidenceGalleryEntryView["status"];
export type EvidenceArtifactView = QaEvidenceArtifactView;
export type EvidenceEntryView = QaEvidenceGalleryEntryView;
export type EvidenceProducerContextFile = QaEvidenceProducerContextFile;
export type EvidenceMatrixCell = QaEvidenceMatrixCellView;
export type EvidenceProducerContext = QaEvidenceProducerContext;
type EvidenceGalleryModel = QaEvidenceGalleryModel;

export type EvidenceEnvelope = {
  evidence: EvidenceGalleryModel | null;
};

export type CaptureSavedView = {
  id: string;
  name: string;
  sessionIds: string[];
  kindFilter: string[];
  providerFilter: string[];
  hostFilter: string[];
  searchText: string;
  headerMode: "key" | "all" | "hidden";
  viewMode: "list" | "timeline";
  groupMode: "none" | "flow" | "host-path" | "burst";
  timelineLaneMode: "domain" | "provider" | "flow";
  timelineLaneSort: "most-events" | "most-errors" | "severity" | "alphabetical";
  timelineZoom: 75 | 100 | 150 | 200 | 300;
  timelineSparklineMode: "session-relative" | "lane-relative";
  errorsOnly: boolean;
  detailPlacement: "right" | "bottom";
  payloadLayout: "formatted" | "raw" | null;
  payloadExtent: "preview" | "full";
};

export type TabId = "chat" | "results" | "report" | "events" | "capture" | "evidence";

export type UiState = {
  theme: "light" | "dark";
  bootstrap: Bootstrap | null;
  snapshot: Snapshot | null;
  latestReport: ReportEnvelope["report"];
  scenarioRun: ScenarioRun | null;
  captureSessions: CaptureSessionSummary[];
  captureEvents: CaptureEventView[];
  captureQueryPreset: CaptureQueryPreset;
  captureQueryRows: Array<Record<string, string | number | null>>;
  captureKindFilter: string[];
  captureProviderFilter: string[];
  captureHostFilter: string[];
  captureSearchText: string;
  captureHeaderMode: "key" | "all" | "hidden";
  captureViewMode: "list" | "timeline";
  captureGroupMode: "none" | "flow" | "host-path" | "burst";
  captureTimelineLaneMode: "domain" | "provider" | "flow";
  captureTimelineLaneSort: "most-events" | "most-errors" | "severity" | "alphabetical";
  captureTimelinePreviousLaneSort:
    | "most-events"
    | "most-errors"
    | "severity"
    | "alphabetical"
    | null;
  captureTimelineLaneSearch: string;
  captureTimelineZoom: 75 | 100 | 150 | 200 | 300;
  captureTimelineSparklineMode: "session-relative" | "lane-relative";
  captureTimelineWindowStartPct: number | null;
  captureTimelineWindowEndPct: number | null;
  captureTimelineBrushAnchorPct: number | null;
  captureTimelineBrushCurrentPct: number | null;
  captureTimelineFocusSelectedFlow: boolean;
  captureTimelineFocusedLaneMode: "all" | "only-matching" | "collapse-background";
  captureTimelineFocusedLaneThreshold: "any" | "events-2" | "percent-10" | "percent-25";
  captureDetailPlacement: "right" | "bottom";
  captureDetailSplitPct: number;
  captureDetailSplitDragging: boolean;
  captureDetailView: "overview" | "flow" | "payload" | "headers";
  capturePreferredDetailView: "overview" | "flow" | "payload" | "headers" | null;
  captureFlowDetailLayout: "nav-first" | "pair-first" | null;
  capturePayloadDetailLayout: "formatted" | "raw" | null;
  capturePayloadExtent: "preview" | "full";
  capturePayloadEventSort: "stream" | "name" | "size";
  capturePayloadEventFilter: string;
  captureErrorsOnly: boolean;
  captureCoverage: CaptureCoverageSummary | null;
  captureStartupStatus: CaptureStartupStatus | null;
  evidence: EvidenceGalleryModel | null;
  evidenceArtifactFilter: "all" | EvidenceArtifactView["mediaKind"];
  evidenceError: string | null;
  evidenceLoading: boolean;
  evidencePathDraft: string;
  evidenceSearchText: string;
  evidenceStatusFilter: "all" | EvidenceStatus;
  captureControlsExpanded: boolean;
  captureSummaryExpanded: boolean;
  captureSavedViews: CaptureSavedView[];
  captureSelectedSessionsExpanded: boolean;
  sidebarCollapsed: boolean;
  sidebarPanel: "scenarios" | "config" | "run";
  captureCollapsedLaneIds: string[];
  capturePinnedLaneIds: string[];
  selectedCaptureSessionIds: string[];
  selectedCaptureEventKey: string | null;
  selectedEvidenceEntryId: string | null;
  selectedConversationKey: string | null;
  selectedThreadId: string | null;
  selectedScenarioId: string | null;
  activeTab: TabId;
  runnerDraft: RunnerSelection | null;
  runnerDraftDirty: boolean;
  composer: {
    conversationKind: "direct" | "channel";
    conversationId: string;
    senderId: string;
    senderName: string;
    text: string;
  };
  busy: boolean;
  error: string | null;
};
