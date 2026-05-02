/* ===== Shared types (unchanged from the bus protocol) ===== */

type Conversation = {
  id: string;
  kind: "direct" | "channel";
  title?: string;
};

type Attachment = {
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

type Thread = {
  id: string;
  conversationId: string;
  title: string;
};

type Message = {
  id: string;
  direction: "inbound" | "outbound";
  conversation: Conversation;
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

type SeedScenario = {
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

type ScenarioOutcome = {
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
    outputDir: string;
    reportPath: string;
    summaryPath: string;
    watchUrl: string;
  };
  error: string | null;
};

type RunnerModelOption = {
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

type CaptureEventView = {
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

type CaptureQueryPreset =
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

type CaptureStartupProbeStatus = {
  label: string;
  url: string;
  ok: boolean;
  error?: string;
};

type CaptureStartupStatus = {
  proxy: CaptureStartupProbeStatus;
  gateway: CaptureStartupProbeStatus;
  qaLab: CaptureStartupProbeStatus;
};

export type CaptureStartupStatusEnvelope = {
  status: CaptureStartupStatus;
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

export type TabId = "chat" | "results" | "report" | "events" | "capture";

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
  selectedConversationId: string | null;
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

/* ===== Helpers ===== */

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatIso(iso?: string) {
  if (!iso) {
    return "—";
  }
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function esc(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseJsonObject(raw?: string): Record<string, unknown> | null {
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function renderCaptureKeyValueGrid(rows: Array<{ label: string; value: string }>): string {
  if (rows.length === 0) {
    return '<div class="empty-state">No structured fields available.</div>';
  }
  return `<div class="capture-kv-grid">
    ${rows
      .map(
        (row) => `<div class="capture-kv-row">
          <div class="capture-kv-label">${esc(row.label)}</div>
          <div class="capture-kv-value capture-mono">${esc(row.value)}</div>
        </div>`,
      )
      .join("")}
  </div>`;
}

function isImportantCaptureHeader(label: string): boolean {
  return /content-type|content-length|accept|cache-control|etag|last-modified|retry-after|location|date|server|x-request-id|openai-processing-ms|cf-cache-status|vary|age|host|user-agent/i.test(
    label,
  );
}

function renderCaptureHeaders(raw: string | undefined, mode: UiState["captureHeaderMode"]): string {
  if (mode === "hidden") {
    return '<div class="empty-state">Headers are hidden. Switch to key or all to inspect them.</div>';
  }
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return '<div class="empty-state">No captured headers for this event.</div>';
  }
  const sourceEntries =
    mode === "key"
      ? Object.entries(parsed).filter(([label]) => isImportantCaptureHeader(label))
      : Object.entries(parsed);
  const groups: Array<{
    key: string;
    label: string;
    match: (header: string) => boolean;
  }> = [
    { key: "auth", label: "Auth & Session", match: (header) => isSensitiveCaptureField(header) },
    {
      key: "content",
      label: "Content",
      match: (header) => /content-|accept|encoding|transfer-encoding/i.test(header),
    },
    {
      key: "cache",
      label: "Caching & Validation",
      match: (header) => /cache|etag|if-|last-modified|vary|expires|age/i.test(header),
    },
    {
      key: "routing",
      label: "Routing & Network",
      match: (header) =>
        /host|origin|referer|x-forwarded|forwarded|cf-|traceparent|tracestate|via/i.test(header),
    },
  ];
  const remaining = new Map(sourceEntries);
  const renderedGroups = groups
    .map((group) => {
      const rows = Array.from(remaining.entries())
        .filter(([label]) => group.match(label))
        .map(([label, value]) => {
          remaining.delete(label);
          return { label, value: formatCaptureFieldValue(value, label) };
        })
        .filter((row) => row.value.length > 0)
        .toSorted((left, right) => left.label.localeCompare(right.label));
      if (rows.length === 0) {
        return "";
      }
      return `<section class="capture-inline-section">
        <div class="capture-summary-label">${esc(group.label)}</div>
        ${renderCaptureKeyValueGrid(rows)}
      </section>`;
    })
    .filter(Boolean);
  const otherRows = Array.from(remaining.entries())
    .map(([label, value]) => ({
      label,
      value: formatCaptureFieldValue(value, label),
    }))
    .filter((row) => row.value.length > 0)
    .toSorted((left, right) => left.label.localeCompare(right.label));
  if (otherRows.length > 0) {
    renderedGroups.push(`<section class="capture-inline-section">
      <div class="capture-summary-label">Other</div>
      ${renderCaptureKeyValueGrid(otherRows)}
    </section>`);
  }
  return (
    renderedGroups.join("") || '<div class="empty-state">No captured headers for this event.</div>'
  );
}

function isSensitiveCaptureField(label: string): boolean {
  return /authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|x[-_]?api[-_]?key|token|secret|password|session/i.test(
    label,
  );
}

function redactCaptureScalar(value: string, label?: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (label && isSensitiveCaptureField(label)) {
    if (/^bearer\s+/i.test(trimmed)) {
      return "Bearer [redacted]";
    }
    return "[redacted]";
  }
  if (trimmed.length > 400) {
    return `${trimmed.slice(0, 280)}\n…\n${trimmed.slice(-80)}`;
  }
  return trimmed;
}

function redactCaptureValue(value: unknown, label?: string): unknown {
  if (typeof value === "string") {
    return redactCaptureScalar(value, label);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactCaptureValue(entry, label));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = redactCaptureValue(entry, key);
  }
  return out;
}

function formatCaptureFieldValue(value: unknown, label?: string): string {
  const redacted = redactCaptureValue(value, label);
  if (typeof redacted === "string") {
    return redacted;
  }
  if (redacted == null) {
    return "";
  }
  if (Array.isArray(redacted)) {
    return redacted
      .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
      .filter(Boolean)
      .join(", ");
  }
  return JSON.stringify(redacted, null, 2);
}

function renderCaptureFormPayload(payload: string): string {
  const params = new URLSearchParams(payload.trim());
  const rows = Array.from(params.entries()).map(([label, value]) => ({
    label,
    value: redactCaptureScalar(value, label),
  }));
  return rows.length > 0
    ? renderCaptureKeyValueGrid(rows)
    : `<pre class="report-pre capture-pre">${esc(redactCaptureScalar(payload))}</pre>`;
}

function renderCaptureSsePayload(
  payload: string,
  options?: {
    sort?: UiState["capturePayloadEventSort"];
    filterText?: string;
  },
): { body: string; eventCount: number; visibleCount: number } {
  const frames = payload
    .split(/\n\n+/)
    .map((frame) => frame.trim())
    .filter(Boolean)
    .slice(0, 48)
    .map((frame, index) => {
      const rows = frame
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const separatorIndex = line.indexOf(":");
          const label =
            separatorIndex >= 0 ? line.slice(0, separatorIndex).trim() || "field" : "line";
          const value = separatorIndex >= 0 ? line.slice(separatorIndex + 1).trim() : line;
          return { label, value: redactCaptureScalar(value, label) };
        });
      const eventName = rows.find((row) => row.label === "event")?.value || "message";
      const dataText = rows
        .filter((row) => row.label === "data")
        .map((row) => row.value)
        .join("\n");
      const searchable = [eventName, dataText, ...rows.flatMap((row) => [row.label, row.value])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return {
        id: index,
        index,
        eventName,
        rows,
        byteLength: new TextEncoder().encode(frame).length,
        searchable,
      };
    });
  const normalizedFilter = options?.filterText?.trim().toLowerCase() ?? "";
  const filteredFrames =
    normalizedFilter.length === 0
      ? frames
      : frames.filter((frame) => frame.searchable.includes(normalizedFilter));
  const sortMode = options?.sort ?? "stream";
  const sortedFrames = [...filteredFrames].toSorted((left, right) => {
    if (sortMode === "name") {
      return left.eventName.localeCompare(right.eventName) || left.index - right.index;
    }
    if (sortMode === "size") {
      return right.byteLength - left.byteLength || left.index - right.index;
    }
    return left.index - right.index;
  });
  if (frames.length === 0) {
    return {
      body: `<pre class="report-pre capture-pre">${esc(redactCaptureScalar(payload))}</pre>`,
      eventCount: 0,
      visibleCount: 0,
    };
  }
  return {
    body:
      sortedFrames.length === 0
        ? '<div class="empty-state">No SSE frames match the current payload filter.</div>'
        : `<div class="capture-sse-stack">
            ${sortedFrames
              .map(
                (frame) => `<section class="capture-inline-section capture-inline-section-compact">
                  <div class="capture-summary-header">
                    <div class="capture-summary-label">Event ${frame.index + 1}</div>
                    <div class="capture-detail-mini-meta">
                      <span class="capture-chip">${esc(frame.eventName)}</span>
                      <span class="capture-chip capture-chip-muted">${frame.byteLength.toLocaleString()} bytes</span>
                    </div>
                  </div>
                  ${renderCaptureKeyValueGrid(frame.rows)}
                </section>`,
              )
              .join("")}
          </div>`,
    eventCount: frames.length,
    visibleCount: sortedFrames.length,
  };
}

function renderCapturePayload(
  payload: string | undefined,
  contentType?: string,
  options?: {
    payloadEventSort?: UiState["capturePayloadEventSort"];
    payloadEventFilter?: string;
  },
): {
  body: string;
  mode: string;
  byteLength: number;
  looksStructured: boolean;
  itemCount?: number;
  visibleItemCount?: number;
} {
  if (!payload?.length) {
    return {
      body: '<div class="empty-state">No inline payload preview for this event.</div>',
      mode: "none",
      byteLength: 0,
      looksStructured: false,
    };
  }
  const trimmed = payload.trim();
  const byteLength = new TextEncoder().encode(payload).length;
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    return {
      body: renderCaptureFormPayload(payload),
      mode: "form",
      byteLength,
      looksStructured: true,
    };
  }
  if (contentType?.includes("text/event-stream") || /^event:|^data:/m.test(trimmed)) {
    const sse = renderCaptureSsePayload(payload, {
      sort: options?.payloadEventSort,
      filterText: options?.payloadEventFilter,
    });
    return {
      body: sse.body,
      mode: "sse",
      byteLength,
      looksStructured: true,
      itemCount: sse.eventCount,
      visibleItemCount: sse.visibleCount,
    };
  }
  const isJsonLike =
    contentType?.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[");
  if (isJsonLike) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return {
        body: `<pre class="report-pre capture-pre capture-pre-json">${esc(
          JSON.stringify(redactCaptureValue(parsed), null, 2),
        )}</pre>`,
        mode: "json",
        byteLength,
        looksStructured: true,
      };
    } catch {
      // fall through to plain text
    }
  }
  return {
    body: `<pre class="report-pre capture-pre">${esc(redactCaptureScalar(payload))}</pre>`,
    mode: "text",
    byteLength,
    looksStructured: false,
  };
}

function renderCaptureCommandBlock(label: string, command: string): string {
  return `<div class="capture-startup-command">
    <div class="capture-summary-header">
      <div class="capture-summary-label">${esc(label)}</div>
      <button
        class="btn-sm capture-copy-button"
        type="button"
        data-copy-text="${esc(command)}"
      >Copy</button>
    </div>
    <pre class="report-pre capture-pre capture-startup-pre">${esc(command)}</pre>
  </div>`;
}

function renderCaptureStartupStatusRow(status: CaptureStartupProbeStatus | null): string {
  if (!status) {
    return '<div class="capture-startup-status-row text-dimmed text-sm">Status unavailable.</div>';
  }
  return `<div class="capture-startup-status-row text-sm">
    <span class="capture-chip ${status.ok ? "capture-chip-strong" : "capture-chip-danger"}">${
      status.ok ? "reachable" : "unreachable"
    }</span>
    <span class="capture-startup-status-url capture-mono">${esc(status.url)}</span>
    ${status.ok ? "" : `<span class="text-dimmed">${esc(status.error || "connection failed")}</span>`}
  </div>`;
}

function renderCaptureStartupInstructions(status: CaptureStartupStatus | null): string {
  const proxyStart = "pnpm proxy:start --port 7799";
  const gatewayStart = `OPENCLAW_DEBUG_PROXY_ENABLED=1 \\
OPENCLAW_DEBUG_PROXY_REQUIRE=1 \\
OPENCLAW_DEBUG_PROXY_URL=http://127.0.0.1:7799 \\
pnpm openclaw gateway --port 18789 --bind loopback`;
  const qaStart = "pnpm qa:lab:ui --port 43124 --control-ui-url http://127.0.0.1:18789/";
  const caInstall = "pnpm proxy:install-ca";
  const caTrust =
    "sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain /Users/thoffman/.openclaw/debug-proxy/certs/root-ca.pem";
  return `<div class="capture-startup-state">
    <div class="capture-startup-title">Proxy capture is not running yet.</div>
    <div class="text-dimmed text-sm capture-startup-copy">
      Start the proxy, then the gateway through that proxy, then QA Lab. Each command is copyable.
    </div>
    <div class="capture-startup-grid">
      <div>
        ${renderCaptureStartupStatusRow(status?.proxy ?? null)}
        ${renderCaptureCommandBlock("1. Start proxy", proxyStart)}
      </div>
      <div>
        ${renderCaptureStartupStatusRow(status?.gateway ?? null)}
        ${renderCaptureCommandBlock("2. Start gateway through proxy", gatewayStart)}
      </div>
      <div>
        ${renderCaptureStartupStatusRow(status?.qaLab ?? null)}
        ${renderCaptureCommandBlock("3. Start QA Lab", qaStart)}
      </div>
      <div>
        <div class="capture-startup-status-row text-dimmed text-sm">
          Install the debug CA once on macOS if you want HTTPS/WSS clients to trust the proxy.
        </div>
        ${renderCaptureCommandBlock("4. Generate/install debug CA helper", caInstall)}
        ${renderCaptureCommandBlock("5. macOS system trust (if needed)", caTrust)}
      </div>
    </div>
  </div>`;
}

function captureEventKey(event: Pick<CaptureEventView, "id" | "flowId" | "ts" | "kind">): string {
  return `${event.id ?? "no-id"}:${event.flowId}:${event.ts}:${event.kind}`;
}

function captureEventGlyph(event: Pick<CaptureEventView, "kind" | "direction">): {
  label: string;
  cls: string;
} {
  switch (event.kind) {
    case "request":
      return { label: "REQ", cls: "req" };
    case "response":
      return { label: "RES", cls: "res" };
    case "error":
      return { label: "ERR", cls: "err" };
    case "ws-frame":
      return { label: "WS", cls: "ws" };
    case "ws-open":
      return { label: "W+", cls: "ws" };
    case "ws-close":
      return { label: "W-", cls: "ws" };
    case "tls-handshake":
      return { label: "TLS", cls: "sys" };
    case "connect":
      return { label: "CON", cls: "sys" };
    case "retry-link":
      return { label: "RTY", cls: "warn" };
    default:
      return { label: event.direction === "inbound" ? "IN" : "OUT", cls: "sys" };
  }
}

function findPairedCaptureEvent(
  event: CaptureEventView | null,
  candidates: CaptureEventView[],
): { counterpart: CaptureEventView | null; role: "request" | "response" | null } {
  if (!event?.flowId || (event.kind !== "request" && event.kind !== "response")) {
    return { counterpart: null, role: null };
  }
  const flowEvents = candidates
    .filter(
      (candidate) =>
        candidate.flowId === event.flowId &&
        (candidate.kind === "request" || candidate.kind === "response") &&
        captureEventKey(candidate) !== captureEventKey(event),
    )
    .toSorted(
      (left, right) =>
        left.ts - right.ts || captureEventKey(left).localeCompare(captureEventKey(right)),
    );
  if (event.kind === "request") {
    return {
      counterpart:
        flowEvents.find((candidate) => candidate.kind === "response" && candidate.ts >= event.ts) ??
        null,
      role: "response",
    };
  }
  const requests = flowEvents.filter(
    (candidate) => candidate.kind === "request" && candidate.ts <= event.ts,
  );
  return {
    counterpart: requests.at(-1) ?? null,
    role: "request",
  };
}

function attachmentSourceUrl(attachment: Attachment): string | null {
  if (attachment.url?.trim()) {
    return attachment.url;
  }
  if (attachment.contentBase64?.trim()) {
    return `data:${attachment.mimeType};base64,${attachment.contentBase64}`;
  }
  return null;
}

function renderMessageAttachments(message: Message): string {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    return "";
  }
  const items = attachments
    .map((attachment) => {
      const sourceUrl = attachmentSourceUrl(attachment);
      const label = attachment.fileName || attachment.altText || attachment.mimeType;
      if (attachment.kind === "image" && sourceUrl) {
        return `<figure class="msg-attachment msg-attachment-image">
          <img src="${esc(sourceUrl)}" alt="${esc(attachment.altText || label)}" loading="lazy" />
          <figcaption>${esc(label)}</figcaption>
        </figure>`;
      }
      if (attachment.kind === "video" && sourceUrl) {
        return `<figure class="msg-attachment msg-attachment-video">
          <video controls preload="metadata" src="${esc(sourceUrl)}"></video>
          <figcaption>${esc(label)}</figcaption>
        </figure>`;
      }
      if (attachment.kind === "audio" && sourceUrl) {
        return `<figure class="msg-attachment msg-attachment-audio">
          <audio controls preload="metadata" src="${esc(sourceUrl)}"></audio>
          <figcaption>${esc(label)}</figcaption>
        </figure>`;
      }
      const transcript = attachment.transcript?.trim()
        ? `<div class="msg-attachment-transcript">${esc(attachment.transcript)}</div>`
        : "";
      const href = sourceUrl ? ` href="${esc(sourceUrl)}" target="_blank" rel="noreferrer"` : "";
      return `<div class="msg-attachment msg-attachment-file">
        <a class="msg-attachment-link"${href}>${esc(label)}</a>
        ${transcript}
      </div>`;
    })
    .join("");
  return `<div class="msg-attachments">${items}</div>`;
}

const MOCK_MODELS: RunnerModelOption[] = [
  {
    key: "mock-openai/gpt-5.5",
    name: "GPT-5.5 (mock)",
    provider: "mock-openai",
    input: "text",
    preferred: true,
  },
  {
    key: "mock-openai/gpt-5.5-alt",
    name: "GPT-5.5 Alt (mock)",
    provider: "mock-openai",
    input: "text",
    preferred: false,
  },
];

function deriveSelectedConversation(state: UiState): string | null {
  return state.selectedConversationId ?? state.snapshot?.conversations[0]?.id ?? null;
}

function deriveSelectedThread(state: UiState): string | null {
  return state.selectedThreadId ?? null;
}

function filteredMessages(state: UiState) {
  const messages = state.snapshot?.messages ?? [];
  return messages.filter((message) => {
    if (state.selectedConversationId && message.conversation.id !== state.selectedConversationId) {
      return false;
    }
    if (state.selectedThreadId && message.threadId !== state.selectedThreadId) {
      return false;
    }
    return true;
  });
}

function findScenarioOutcome(state: UiState, scenario: SeedScenario) {
  return (
    state.scenarioRun?.scenarios.find((o) => o.id === scenario.id) ??
    state.scenarioRun?.scenarios.find((o) => o.name === scenario.title) ??
    null
  );
}

function statusDotClass(status: ScenarioOutcome["status"] | "pending"): string {
  return `scenario-item-dot scenario-item-dot-${status}`;
}

function badgeHtml(status: string): string {
  const tone = status === "failed" ? "fail" : status === "completed" ? "pass" : status;
  return `<span class="badge badge-${esc(tone)}">${esc(status)}</span>`;
}

function deriveSelection(state: UiState): RunnerSelection | null {
  return state.runnerDraft ?? state.bootstrap?.runner.selection ?? null;
}

/* ===== Render: Header ===== */

function renderHeader(state: UiState): string {
  const runner = state.bootstrap?.runner ?? null;
  const run = state.scenarioRun;
  const controlUrl = state.bootstrap?.controlUiUrl;

  return `
    <header class="header">
      <div class="header-left">
        <span class="header-title">QA Lab</span>
        <div class="header-status">
          ${runner ? badgeHtml(runner.status) : ""}
          ${run ? `<span class="badge badge-accent">${run.counts.passed}/${run.counts.total} pass</span>` : ""}
          ${state.error ? `<span class="badge badge-fail">${esc(state.error)}</span>` : ""}
        </div>
      </div>
      <div class="header-right">
        ${controlUrl ? `<a class="header-link" href="${esc(controlUrl)}" target="_blank" rel="noreferrer">Control UI</a>` : ""}
        <button class="btn-ghost btn-sm" data-action="toggle-sidebar">${state.sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}</button>
        <button class="btn-ghost btn-sm" data-action="refresh"${state.busy ? " disabled" : ""}>Refresh</button>
        <button class="btn-ghost btn-sm" data-action="reset"${state.busy ? " disabled" : ""}>Reset</button>
        <button class="theme-toggle" data-action="toggle-theme" title="Toggle theme">${state.theme === "dark" ? "\u2600" : "\u263E"}</button>
      </div>
    </header>`;
}

/* ===== Render: Sidebar ===== */

function renderModelSelect(params: {
  id: string;
  label: string;
  value: string;
  options: RunnerModelOption[];
  disabled: boolean;
}): string {
  const values = new Set(params.options.map((o) => o.key));
  const options = [...params.options];
  if (!values.has(params.value) && params.value.trim()) {
    options.unshift({
      key: params.value,
      name: params.value,
      provider: params.value.split("/")[0] ?? "custom",
      input: "text",
      preferred: false,
    });
  }
  return `
    <div class="config-field">
      <span class="config-label">${esc(params.label)}</span>
      <select id="${esc(params.id)}"${params.disabled ? " disabled" : ""}>
        ${options
          .map(
            (o) =>
              `<option value="${esc(o.key)}"${o.key === params.value ? " selected" : ""}>${esc(o.key)}</option>`,
          )
          .join("")}
      </select>
    </div>`;
}

function renderSidebar(state: UiState): string {
  const scenarios = state.bootstrap?.scenarios ?? [];
  const selection = deriveSelection(state);
  const runner = state.bootstrap?.runner ?? null;
  const run = state.scenarioRun;
  const isRunning = runner?.status === "running";
  const realModels = state.bootstrap?.runnerCatalog.real ?? [];
  const modelOptions =
    selection?.providerMode === "live-frontier" && realModels.length > 0 ? realModels : MOCK_MODELS;
  const selectedIds = new Set(selection?.scenarioIds ?? []);

  return `
    <aside class="sidebar${state.sidebarCollapsed ? " is-collapsed" : ""}">
      <div class="sidebar-panel-tabs">
        <button class="btn-sm btn-ghost sidebar-panel-tab${state.sidebarPanel === "scenarios" ? " active" : ""}" data-sidebar-panel="scenarios">Scenarios</button>
        <button class="btn-sm btn-ghost sidebar-panel-tab${state.sidebarPanel === "config" ? " active" : ""}" data-sidebar-panel="config">Config</button>
        <button class="btn-sm btn-ghost sidebar-panel-tab${state.sidebarPanel === "run" ? " active" : ""}" data-sidebar-panel="run">Run</button>
      </div>
      ${
        state.sidebarPanel === "config"
          ? `<div class="sidebar-section sidebar-panel-body">
              <div class="sidebar-section-title"><h3>Configuration</h3></div>
              <div class="config-field">
                <span class="config-label">Provider lane</span>
                <select id="provider-mode"${isRunning ? " disabled" : ""}>
                  <option value="mock-openai"${selection?.providerMode === "mock-openai" ? " selected" : ""}>Synthetic (mock)</option>
                  <option value="live-frontier"${selection?.providerMode === "live-frontier" ? " selected" : ""}>Real frontier providers</option>
                </select>
              </div>
              ${renderModelSelect({
                id: "primary-model",
                label: "Primary model",
                value: selection?.primaryModel ?? "",
                options: modelOptions,
                disabled: isRunning,
              })}
              ${renderModelSelect({
                id: "alternate-model",
                label: "Alternate model",
                value: selection?.alternateModel ?? "",
                options: modelOptions,
                disabled: isRunning,
              })}
              ${
                selection?.providerMode === "live-frontier"
                  ? `<div class="config-hint">${esc(
                      state.bootstrap?.runnerCatalog.status === "loading"
                        ? "Loading model catalog\u2026"
                        : state.bootstrap?.runnerCatalog.status === "failed"
                          ? "Catalog unavailable; using manual input."
                          : `${realModels.length} models available`,
                    )}</div>`
                  : ""
              }
            </div>`
          : state.sidebarPanel === "run"
            ? `<div class="sidebar-panel-body">${run || runner ? renderRunStatus(state) : '<div class="sidebar-section"><div class="text-dimmed text-sm">No run data yet.</div></div>'}</div>`
            : `<div class="sidebar-section sidebar-scenarios sidebar-panel-body">
                <div class="sidebar-section-title">
                  <h3>Scenarios (${selectedIds.size}/${scenarios.length})</h3>
                  <div class="btn-group">
                    <button class="btn-sm btn-ghost" data-action="select-all-scenarios"${isRunning ? " disabled" : ""}>All</button>
                    <button class="btn-sm btn-ghost" data-action="clear-scenarios"${isRunning ? " disabled" : ""}>None</button>
                  </div>
                </div>
                <div class="scenario-scroll">
                  ${scenarios
                    .map((s) => {
                      const outcome = findScenarioOutcome(state, s);
                      const status = outcome?.status ?? "pending";
                      return `
                        <label class="scenario-item">
                          <input type="checkbox" data-scenario-toggle-id="${esc(s.id)}"${selectedIds.has(s.id) ? " checked" : ""}${isRunning ? " disabled" : ""} />
                          <span class="${statusDotClass(status)}"></span>
                          <div class="scenario-item-info">
                            <span class="scenario-item-title">${esc(s.title)}</span>
                            <span class="scenario-item-meta">${esc(s.surface)} · ${esc(s.id)}</span>
                          </div>
                        </label>`;
                    })
                    .join("")}
                </div>
              </div>`
      }

      <!-- Actions -->
      <div class="sidebar-actions">
        <button class="btn-primary" data-action="run-suite"${isRunning || !selectedIds.size || state.busy ? " disabled" : ""}>
          Run ${selectedIds.size} scenario${selectedIds.size === 1 ? "" : "s"}
        </button>
        <div class="btn-row">
          <button data-action="self-check"${isRunning || state.busy ? " disabled" : ""}>Self-check</button>
          <button data-action="kickoff"${isRunning || state.busy ? " disabled" : ""}>Kickoff</button>
        </div>
      </div>
    </aside>`;
}

function renderRunStatus(state: UiState): string {
  const run = state.scenarioRun;
  const runner = state.bootstrap?.runner ?? null;
  if (!run && !runner) {
    return "";
  }

  return `
    <div class="sidebar-section run-status">
      <div class="sidebar-section-title">
        <h3>Run Status</h3>
        ${runner ? badgeHtml(runner.status) : ""}
      </div>
      ${
        run
          ? `<div class="run-counts">
              <div class="run-count"><span class="run-count-value">${run.counts.total}</span><span class="run-count-label">Total</span></div>
              <div class="run-count"><span class="run-count-value count-pass">${run.counts.passed}</span><span class="run-count-label">Pass</span></div>
              <div class="run-count"><span class="run-count-value count-fail">${run.counts.failed}</span><span class="run-count-label">Fail</span></div>
              <div class="run-count"><span class="run-count-value">${run.counts.pending + run.counts.running}</span><span class="run-count-label">Left</span></div>
            </div>`
          : ""
      }
      <div class="run-meta">
        ${runner?.startedAt ? `Started ${esc(formatIso(runner.startedAt))}` : ""}
        ${runner?.finishedAt ? `<br>Finished ${esc(formatIso(runner.finishedAt))}` : ""}
        ${runner?.error ? `<br><span style="color:var(--danger)">${esc(runner.error)}</span>` : ""}
      </div>
    </div>`;
}

/* ===== Render: Tab bar ===== */

function renderTabBar(state: UiState): string {
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "chat", label: "Chat" },
    { id: "results", label: "Results" },
    { id: "report", label: "Report" },
    { id: "events", label: "Events" },
    { id: "capture", label: "Capture" },
  ];
  return `
    <nav class="tab-bar">
      ${tabs
        .map(
          (t) =>
            `<button class="tab-btn${state.activeTab === t.id ? " active" : ""}" data-tab="${t.id}">${t.label}</button>`,
        )
        .join("")}
      <div class="tab-spacer"></div>
    </nav>`;
}

/* ===== Render: Chat tab ===== */

function renderChatView(state: UiState): string {
  const conversations = state.snapshot?.conversations ?? [];
  const channels = conversations.filter((c) => c.kind === "channel");
  const dms = conversations.filter((c) => c.kind === "direct");
  const threads = (state.snapshot?.threads ?? []).filter(
    (t) => !state.selectedConversationId || t.conversationId === state.selectedConversationId,
  );
  const selectedConv = deriveSelectedConversation(state);
  const selectedThread = deriveSelectedThread(state);
  const activeConversation = conversations.find((c) => c.id === selectedConv);
  const messages = filteredMessages({
    ...state,
    selectedConversationId: selectedConv,
    selectedThreadId: selectedThread,
  });

  return `
    <div class="chat-view">
      <!-- Channel / DM sidebar -->
      <aside class="chat-sidebar">
        <div class="chat-sidebar-scroll">
          <div class="chat-sidebar-section">
            <div class="chat-sidebar-heading">Channels</div>
            <div class="chat-sidebar-list">
              ${
                channels.length === 0
                  ? '<div class="chat-sidebar-item" style="color:var(--text-tertiary);font-size:12px;cursor:default">No channels</div>'
                  : channels
                      .map(
                        (c) => `
                          <button class="chat-sidebar-item${c.id === selectedConv ? " active" : ""}" data-conversation-id="${esc(c.id)}">
                            <span class="chat-sidebar-icon">#</span>
                            <span class="chat-sidebar-label">${esc(c.title || c.id)}</span>
                          </button>`,
                      )
                      .join("")
              }
            </div>
          </div>
          <div class="chat-sidebar-section">
            <div class="chat-sidebar-heading">Direct Messages</div>
            <div class="chat-sidebar-list">
              ${
                dms.length === 0
                  ? '<div class="chat-sidebar-item" style="color:var(--text-tertiary);font-size:12px;cursor:default">No DMs</div>'
                  : dms
                      .map(
                        (c) => `
                          <button class="chat-sidebar-item${c.id === selectedConv ? " active" : ""}" data-conversation-id="${esc(c.id)}">
                            <span class="chat-sidebar-icon">\u25CF</span>
                            <span class="chat-sidebar-label">${esc(c.title || c.id)}</span>
                          </button>`,
                      )
                      .join("")
              }
            </div>
          </div>
          ${
            threads.length > 0
              ? `<div class="chat-sidebar-section">
                  <div class="chat-sidebar-heading">Threads</div>
                  <div class="chat-sidebar-list">
                    <button class="chat-sidebar-item${!selectedThread ? " active" : ""}" data-thread-select="root">
                      <span class="chat-sidebar-icon">\u2302</span>
                      <span class="chat-sidebar-label">Main timeline</span>
                    </button>
                    ${threads
                      .map(
                        (t) => `
                          <button class="chat-sidebar-item${t.id === selectedThread ? " active" : ""}" data-thread-select="${esc(t.id)}" data-thread-conv="${esc(t.conversationId)}">
                            <span class="chat-sidebar-icon">\u21B3</span>
                            <span class="chat-sidebar-label">${esc(t.title)}</span>
                          </button>`,
                      )
                      .join("")}
                  </div>
                </div>`
              : ""
          }
        </div>
      </aside>

      <!-- Main chat area -->
      <div class="chat-main">
        <!-- Channel header -->
        <div class="chat-channel-header">
          <span class="chat-channel-name">${esc(activeConversation?.title || selectedConv || "No conversation")}</span>
          ${activeConversation ? `<span class="chat-channel-kind">${activeConversation.kind}</span>` : ""}
          ${state.bootstrap?.runner.status === "running" ? '<span class="live-indicator"><span class="live-dot"></span>LIVE</span>' : ""}
        </div>

        <!-- Messages -->
        <div class="chat-messages" id="chat-messages">
          ${
            messages.length === 0
              ? '<div class="chat-empty">No messages yet. Run scenarios or send a message below.</div>'
              : messages.map((m) => renderMessage(m)).join("")
          }
        </div>

        <!-- Composer -->
        <div class="chat-composer">
          <div class="composer-context">
            <select id="conversation-kind">
              <option value="direct"${state.composer.conversationKind === "direct" ? " selected" : ""}>DM</option>
              <option value="channel"${state.composer.conversationKind === "channel" ? " selected" : ""}>Channel</option>
            </select>
            <span>as</span>
            <input id="sender-name" value="${esc(state.composer.senderName)}" placeholder="Name" />
            <span>in</span>
            <input id="conversation-id" value="${esc(state.composer.conversationId)}" placeholder="Conversation" />
            <input id="sender-id" type="hidden" value="${esc(state.composer.senderId)}" />
          </div>
          <div class="composer-input">
            <textarea id="composer-text" rows="1" placeholder="Type a message\u2026 (Enter to send, Shift+Enter for newline)">${esc(state.composer.text)}</textarea>
            <button class="btn-primary composer-send" data-action="send"${state.busy ? " disabled" : ""}>Send</button>
          </div>
        </div>
      </div>
    </div>`;
}

function messageAvatar(m: Message): { emoji: string; bg: string; role: string } {
  if (m.direction === "outbound") {
    return { emoji: "\uD83E\uDD80", bg: "#7c6cff", role: "Claw" }; // 🦀
  }
  return { emoji: "\uD83E\uDD9E", bg: "#d97706", role: "Clawfather" }; // 🦞
}

function renderMessage(m: Message): string {
  const name = m.senderName || m.senderId;
  const avatar = messageAvatar(m);
  const dirClass = m.direction === "inbound" ? "msg-direction-inbound" : "msg-direction-outbound";

  const metaTags: string[] = [];
  if (m.threadId) {
    metaTags.push(`<span class="msg-tag">thread ${esc(m.threadId)}</span>`);
  }
  if (m.editedAt) {
    metaTags.push('<span class="msg-tag">edited</span>');
  }
  if (m.deleted) {
    metaTags.push('<span class="msg-tag">deleted</span>');
  }

  const reactions =
    m.reactions.length > 0
      ? `<span class="msg-reactions">${m.reactions.map((r) => `<span class="msg-reaction">${esc(r.emoji)}</span>`).join("")}</span>`
      : "";

  return `
    <div class="msg msg-${m.direction}">
      <div class="msg-avatar" style="background:${avatar.bg}">${avatar.emoji}</div>
      <div class="msg-body">
        <div class="msg-header">
          <span class="msg-sender">${esc(name)}</span>
          <span class="msg-role">${esc(avatar.role)}</span>
          <span class="msg-direction ${dirClass}">${m.direction === "inbound" ? "\u2B06" : "\u2B07"}</span>
          <span class="msg-time">${formatTime(m.timestamp)}</span>
        </div>
        <div class="msg-text">${esc(m.text)}</div>
        ${renderMessageAttachments(m)}
        ${metaTags.length > 0 || reactions ? `<div class="msg-meta">${metaTags.join("")}${reactions}</div>` : ""}
      </div>
    </div>`;
}

function recentInspectorMessages(state: UiState, limit = 18) {
  return (state.snapshot?.messages ?? []).slice(-limit).toReversed();
}

function renderInspectorLiveMessage(message: Message): string {
  const avatar = messageAvatar(message);
  const conversationLabel = message.conversation.title || message.conversation.id;
  const threadLabel = message.threadTitle || message.threadId;

  return `
    <div class="inspector-live-message">
      <div class="inspector-live-message-head">
        <div class="inspector-live-message-identity">
          <span class="inspector-live-avatar" style="background:${avatar.bg}">${avatar.emoji}</span>
          <span class="inspector-live-sender">${esc(message.senderName || message.senderId)}</span>
          <span class="inspector-live-direction inspector-live-direction-${message.direction}">${message.direction === "inbound" ? "inbound" : "outbound"}</span>
        </div>
        <span class="inspector-live-time">${formatTime(message.timestamp)}</span>
      </div>
      <div class="inspector-live-channel">
        ${esc(conversationLabel)}${threadLabel ? ` · ${esc(threadLabel)}` : ""}
      </div>
      <div class="inspector-live-text">${esc(message.text)}</div>
    </div>`;
}

function renderInspectorLiveTranscript(state: UiState): string {
  const messages = recentInspectorMessages(state);
  const isLive = state.bootstrap?.runner.status === "running";

  return `
    <aside class="inspector-live">
      <div class="inspector-live-header">
        <div>
          <div class="inspector-section-title">Live Transcript</div>
          <div class="inspector-live-subtitle">
            ${isLive ? "Latest QA bus messages as the run progresses." : "Latest observed QA bus messages."}
          </div>
        </div>
        ${isLive ? '<span class="live-indicator"><span class="live-dot"></span>LIVE</span>' : ""}
      </div>
      <div class="inspector-live-feed">
        ${
          messages.length > 0
            ? messages.map((message) => renderInspectorLiveMessage(message)).join("")
            : '<div class="empty-state">No transcript yet. Start a run or send a message.</div>'
        }
      </div>
    </aside>`;
}

/* ===== Render: Results tab ===== */

function renderResultsView(state: UiState): string {
  const scenarios = state.bootstrap?.scenarios ?? [];
  const selected = scenarios.find((s) => s.id === state.selectedScenarioId) ?? scenarios[0] ?? null;

  return `
    <div class="results-view">
      <div class="results-list">
        ${scenarios.length === 0 ? '<div class="empty-state">No scenarios loaded.</div>' : ""}
        ${scenarios
          .map((s) => {
            const outcome = findScenarioOutcome(state, s);
            const status = outcome?.status ?? "pending";
            const isSelected = s.id === (selected?.id ?? null);
            return `
              <button class="result-card${isSelected ? " selected" : ""}" data-scenario-id="${esc(s.id)}">
                <span class="result-card-dot scenario-item-dot-${status}"></span>
                <div class="result-card-info">
                  <span class="result-card-title">${esc(s.title)}</span>
                  <span class="result-card-sub">${esc(s.surface)} · ${outcome?.steps?.length ?? s.successCriteria.length} steps</span>
                </div>
                ${badgeHtml(status)}
              </button>`;
          })
          .join("")}
      </div>
      <div class="results-inspector">
        ${selected ? renderInspector(state, selected) : '<div class="inspector-empty">Select a scenario</div>'}
      </div>
    </div>`;
}

function renderInspector(state: UiState, scenario: SeedScenario): string {
  const outcome = findScenarioOutcome(state, scenario);

  return `
    <div class="inspector-layout">
      <div class="inspector-main">
        <div class="inspector-header">
          <div>
            <div class="inspector-title">${esc(scenario.title)}</div>
            ${badgeHtml(outcome?.status ?? "pending")}
          </div>
        </div>
        <div class="inspector-objective">${esc(scenario.objective)}</div>
        <div class="inspector-meta">
          <div class="inspector-meta-item"><span class="inspector-meta-label">Surface</span><span class="inspector-meta-value">${esc(scenario.surface)}</span></div>
          <div class="inspector-meta-item"><span class="inspector-meta-label">Started</span><span class="inspector-meta-value">${esc(formatIso(outcome?.startedAt))}</span></div>
          <div class="inspector-meta-item"><span class="inspector-meta-label">Finished</span><span class="inspector-meta-value">${esc(formatIso(outcome?.finishedAt))}</span></div>
          <div class="inspector-meta-item"><span class="inspector-meta-label">Run</span><span class="inspector-meta-value">${esc(state.scenarioRun?.kind ?? "seed only")}</span></div>
        </div>

        <div class="inspector-section">
          <div class="inspector-section-title">Success Criteria</div>
          <ul class="criteria-list">
            ${scenario.successCriteria.map((c) => `<li class="criteria-item"><span class="criteria-bullet"></span>${esc(c)}</li>`).join("")}
          </ul>
        </div>

        <div class="inspector-section">
          <div class="inspector-section-title">Observed Outcome</div>
          ${
            outcome
              ? `
                ${outcome.details ? `<div style="margin-bottom:12px;color:var(--text-secondary);font-size:13px">${esc(outcome.details)}</div>` : ""}
                <div class="step-list">
                  ${
                    outcome.steps?.length
                      ? outcome.steps
                          .map(
                            (step) => `
                              <div class="step-card">
                                <div class="step-card-header">
                                  <span class="step-card-name">${esc(step.name)}</span>
                                  ${badgeHtml(step.status)}
                                </div>
                                ${step.details ? `<div class="step-card-details">${esc(step.details)}</div>` : ""}
                              </div>`,
                          )
                          .join("")
                      : '<div class="empty-state">No step data yet.</div>'
                  }
                </div>`
              : '<div class="empty-state">Not executed yet — seed plan only.</div>'
          }
        </div>

        ${
          scenario.docsRefs?.length
            ? `<div class="inspector-section">
                <div class="inspector-section-title">Docs</div>
                <div class="ref-list">${scenario.docsRefs.map((r) => `<span class="ref-tag">${esc(r)}</span>`).join("")}</div>
              </div>`
            : ""
        }
        ${
          scenario.codeRefs?.length
            ? `<div class="inspector-section">
                <div class="inspector-section-title">Code</div>
                <div class="ref-list">${scenario.codeRefs.map((r) => `<span class="ref-tag">${esc(r)}</span>`).join("")}</div>
              </div>`
            : ""
        }
      </div>
      ${renderInspectorLiveTranscript(state)}
    </div>`;
}

/* ===== Render: Report tab ===== */

function renderReportView(state: UiState): string {
  return `
    <div class="report-view">
      <div class="report-toolbar">
        <span class="report-toolbar-title">Protocol Report</span>
        <button class="btn-sm" data-action="download-report"${state.latestReport ? "" : " disabled"}>Export Markdown</button>
      </div>
      <div class="report-content">
        <pre class="report-pre">${esc(state.latestReport?.markdown ?? "Run the suite or self-check to generate a report.")}</pre>
      </div>
    </div>`;
}

/* ===== Render: Events tab ===== */

function renderEventsView(state: UiState): string {
  const events = (state.snapshot?.events ?? []).slice(-60).toReversed();

  return `
    <div class="events-view">
      <div class="events-header">
        <span class="events-header-title">Event Stream</span>
        <span class="text-dimmed text-sm">${events.length} events (newest first)</span>
      </div>
      <div class="events-scroll">
        ${
          events.length === 0
            ? '<div class="empty-state" style="padding:20px">No events yet.</div>'
            : events
                .map((e) => {
                  const detail =
                    "thread" in e
                      ? `${e.thread.conversationId}/${e.thread.id}`
                      : e.message
                        ? `${e.message.senderId}: ${e.message.text}`
                        : "";
                  return `
                    <div class="event-row">
                      <span class="event-kind">${esc(e.kind)}</span>
                      <span class="event-cursor">#${e.cursor}</span>
                      <span class="event-detail">${esc(detail)}</span>
                    </div>`;
                })
                .join("")
        }
      </div>
    </div>`;
}

function renderCaptureView(state: UiState): string {
  const sessionIds =
    state.selectedCaptureSessionIds.length > 0
      ? state.selectedCaptureSessionIds
      : state.captureSessions[0]?.id
        ? [state.captureSessions[0].id]
        : [];
  const sessions = state.captureSessions;
  const rows = state.captureQueryRows;
  const events = state.captureEvents;
  const availableKinds = [
    ...new Set(
      events.map((event) => event.kind).filter((value): value is string => Boolean(value)),
    ),
  ].toSorted();
  const availableProviders = [
    ...new Set(
      events.map((event) => event.provider).filter((value): value is string => Boolean(value)),
    ),
  ].toSorted();
  const availableHosts = [
    ...new Set(
      events.map((event) => event.host).filter((value): value is string => Boolean(value)),
    ),
  ].toSorted();
  const normalizedSearch = state.captureSearchText.trim().toLowerCase();
  const activeFilters: string[] = [];
  if (state.captureKindFilter.length > 0) {
    activeFilters.push(`kind: ${state.captureKindFilter.join(", ")}`);
  }
  if (state.captureProviderFilter.length > 0) {
    activeFilters.push(`provider: ${state.captureProviderFilter.join(", ")}`);
  }
  if (state.captureHostFilter.length > 0) {
    activeFilters.push(`host: ${state.captureHostFilter.join(", ")}`);
  }
  if (normalizedSearch) {
    activeFilters.push(`search: ${state.captureSearchText.trim()}`);
  }
  if (state.captureHeaderMode !== "key") {
    activeFilters.push(`headers: ${state.captureHeaderMode}`);
  }
  if (state.captureViewMode === "list" && state.captureGroupMode !== "none") {
    activeFilters.push(`group: ${state.captureGroupMode}`);
  }
  if (state.captureViewMode === "timeline") {
    activeFilters.push(`lanes: ${state.captureTimelineLaneMode}`);
    activeFilters.push(`lane sort: ${state.captureTimelineLaneSort}`);
    activeFilters.push(`zoom: ${state.captureTimelineZoom}%`);
    if (state.captureTimelineFocusSelectedFlow) {
      activeFilters.push("focus selected flow");
      if (state.captureTimelineFocusedLaneMode !== "all") {
        activeFilters.push(`focused lanes: ${state.captureTimelineFocusedLaneMode}`);
      }
      if (state.captureTimelineFocusedLaneThreshold !== "any") {
        activeFilters.push(`focus threshold: ${state.captureTimelineFocusedLaneThreshold}`);
      }
    }
    if (state.captureTimelineLaneSearch.trim()) {
      activeFilters.push(`lane search: ${state.captureTimelineLaneSearch.trim()}`);
    }
    if (state.capturePinnedLaneIds.length > 0) {
      activeFilters.push(`pinned lanes: ${state.capturePinnedLaneIds.length}`);
    }
    if (state.captureTimelineSparklineMode !== "session-relative") {
      activeFilters.push(`sparkline: ${state.captureTimelineSparklineMode}`);
    }
  }
  if (state.captureErrorsOnly) {
    activeFilters.push("errors only");
  }
  const baseFilteredEvents = events.filter((event) => {
    if (state.captureKindFilter.length > 0 && !state.captureKindFilter.includes(event.kind)) {
      return false;
    }
    if (
      state.captureProviderFilter.length > 0 &&
      !state.captureProviderFilter.includes(event.provider || "")
    ) {
      return false;
    }
    if (state.captureHostFilter.length > 0 && !state.captureHostFilter.includes(event.host || "")) {
      return false;
    }
    if (state.captureErrorsOnly && !event.errorText && (event.status ?? 0) < 400) {
      return false;
    }
    if (normalizedSearch) {
      const haystack = [
        event.kind,
        event.protocol,
        event.direction,
        event.provider,
        event.api,
        event.model,
        event.method,
        event.host,
        event.path,
        event.status == null ? "" : String(event.status),
        event.errorText,
        event.payloadPreview,
        event.flowId,
        event.closeCode == null ? "" : String(event.closeCode),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(normalizedSearch)) {
        return false;
      }
    }
    return true;
  });
  const minTs =
    baseFilteredEvents.length > 0 ? Math.min(...baseFilteredEvents.map((event) => event.ts)) : 0;
  const maxTs =
    baseFilteredEvents.length > 0 ? Math.max(...baseFilteredEvents.map((event) => event.ts)) : 0;
  const totalSpanMs = Math.max(1, maxTs - minTs);
  const activeWindowStartPct =
    state.captureTimelineWindowStartPct != null && state.captureTimelineWindowEndPct != null
      ? Math.min(state.captureTimelineWindowStartPct, state.captureTimelineWindowEndPct)
      : null;
  const activeWindowEndPct =
    state.captureTimelineWindowStartPct != null && state.captureTimelineWindowEndPct != null
      ? Math.max(state.captureTimelineWindowStartPct, state.captureTimelineWindowEndPct)
      : null;
  const draftWindowStartPct =
    state.captureTimelineBrushAnchorPct != null && state.captureTimelineBrushCurrentPct != null
      ? Math.min(state.captureTimelineBrushAnchorPct, state.captureTimelineBrushCurrentPct)
      : null;
  const draftWindowEndPct =
    state.captureTimelineBrushAnchorPct != null && state.captureTimelineBrushCurrentPct != null
      ? Math.max(state.captureTimelineBrushAnchorPct, state.captureTimelineBrushCurrentPct)
      : null;
  const activeWindowStartTs =
    activeWindowStartPct == null ? null : minTs + totalSpanMs * (activeWindowStartPct / 100);
  const activeWindowEndTs =
    activeWindowEndPct == null ? null : minTs + totalSpanMs * (activeWindowEndPct / 100);
  const activeWindowLabel =
    activeWindowStartTs == null || activeWindowEndTs == null
      ? null
      : `${formatTime(activeWindowStartTs)} → ${formatTime(activeWindowEndTs)} · ${formatDuration(
          Math.max(0, activeWindowEndTs - activeWindowStartTs),
        )}`;
  if (activeWindowLabel && state.captureViewMode === "timeline") {
    activeFilters.push(`window: ${activeWindowLabel}`);
  }
  const filteredEvents =
    state.captureViewMode === "timeline" &&
    activeWindowStartPct != null &&
    activeWindowEndPct != null
      ? baseFilteredEvents.filter((event) => {
          const percent = ((event.ts - minTs) / totalSpanMs) * 100;
          return percent >= activeWindowStartPct && percent <= activeWindowEndPct;
        })
      : baseFilteredEvents;
  const analysisEnabled = state.captureQueryPreset !== "none";
  const selectedSessions = sessions.filter((session) => sessionIds.includes(session.id));
  const singleSelectedSession =
    selectedSessions.length === 1 ? (selectedSessions[0] ?? null) : null;
  const selectedSessionEventCount = selectedSessions.reduce(
    (sum, session) => sum + session.eventCount,
    0,
  );
  const selectedEvent =
    filteredEvents.find((event) => {
      const key = captureEventKey(event);
      return key === state.selectedCaptureEventKey;
    }) ??
    filteredEvents[0] ??
    null;
  const selectedEventKey = selectedEvent == null ? null : captureEventKey(selectedEvent);
  const kindCounts = new Map<string, number>();
  for (const event of filteredEvents) {
    kindCounts.set(event.kind, (kindCounts.get(event.kind) ?? 0) + 1);
  }
  const topKinds = [...kindCounts.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 4);
  const topProviders = state.captureCoverage?.providers.slice(0, 4) ?? [];
  const topModels = state.captureCoverage?.models.slice(0, 3) ?? [];
  const selectedFlowId = selectedEvent?.flowId?.trim() || "";
  const selectedFlowEvents =
    selectedFlowId.length > 0
      ? events
          .filter((event) => event.flowId === selectedFlowId)
          .toSorted(
            (left, right) =>
              left.ts - right.ts || captureEventKey(left).localeCompare(captureEventKey(right)),
          )
      : [];
  const selectedFlowIndex =
    selectedEvent == null
      ? -1
      : selectedFlowEvents.findIndex(
          (event) => captureEventKey(event) === captureEventKey(selectedEvent),
        );
  const previousFlowEvent =
    selectedFlowIndex > 0 ? selectedFlowEvents[selectedFlowIndex - 1] : null;
  const nextFlowEvent =
    selectedFlowIndex >= 0 && selectedFlowIndex < selectedFlowEvents.length - 1
      ? selectedFlowEvents[selectedFlowIndex + 1]
      : null;
  const selectedPairing = findPairedCaptureEvent(selectedEvent, events);
  const pairedEvent = selectedPairing.counterpart;
  const pairedEventKey = pairedEvent ? captureEventKey(pairedEvent) : null;
  const pairedEventVisible =
    pairedEventKey != null &&
    filteredEvents.some((event) => captureEventKey(event) === pairedEventKey);
  const pairingLatencyMs =
    selectedEvent && pairedEvent ? Math.max(0, Math.abs(pairedEvent.ts - selectedEvent.ts)) : null;
  const previousFlowEventVisible =
    previousFlowEvent != null &&
    filteredEvents.some((event) => captureEventKey(event) === captureEventKey(previousFlowEvent));
  const nextFlowEventVisible =
    nextFlowEvent != null &&
    filteredEvents.some((event) => captureEventKey(event) === captureEventKey(nextFlowEvent));
  const timelineTrackWidthPx = Math.round(960 * (state.captureTimelineZoom / 100));
  const timelineWidthStyle = `--capture-timeline-track-width:${timelineTrackWidthPx}px`;
  const renderTimelineWindow = (
    startPct: number | null,
    endPct: number | null,
    className: string,
  ): string => {
    if (startPct == null || endPct == null) {
      return "";
    }
    const left = Math.max(0, Math.min(100, startPct));
    const width = Math.max(0, Math.min(100, endPct) - left);
    return `<div class="${className}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></div>`;
  };
  const timelineAxisTicks = Array.from({ length: 5 }, (_, index) => {
    const pct = (index / 4) * 100;
    const ts = minTs + (totalSpanMs * pct) / 100;
    return {
      pct,
      label: formatTime(ts),
      edgeClass:
        index === 0
          ? "capture-timeline-axis-tick-start"
          : index === 4
            ? "capture-timeline-axis-tick-end"
            : "",
    };
  });
  const renderLaneSparkline = (eventsForLane: CaptureEventView[], laneId: string) => {
    if (eventsForLane.length === 0) {
      return "";
    }
    const binCount = 18;
    const bins = Array.from({ length: binCount }, () => 0);
    const laneMinTs = eventsForLane.reduce(
      (min, event) => Math.min(min, event.ts),
      eventsForLane[0]?.ts ?? minTs,
    );
    const laneMaxTs = eventsForLane.reduce(
      (max, event) => Math.max(max, event.ts),
      eventsForLane[0]?.ts ?? maxTs,
    );
    const laneSpanMs = Math.max(1, laneMaxTs - laneMinTs);
    for (const event of eventsForLane) {
      const spanStart = state.captureTimelineSparklineMode === "lane-relative" ? laneMinTs : minTs;
      const spanMs =
        state.captureTimelineSparklineMode === "lane-relative" ? laneSpanMs : totalSpanMs;
      const rawIndex = spanMs <= 0 ? 0 : Math.floor(((event.ts - spanStart) / spanMs) * binCount);
      const index = Math.max(0, Math.min(binCount - 1, rawIndex));
      bins[index] += 1;
    }
    const maxBin = Math.max(...bins, 1);
    return `<div class="capture-timeline-sparkline">
      ${bins
        .map((count, index) => {
          const height = Math.max(12, Math.round((count / maxBin) * 100));
          const spanStartTs =
            state.captureTimelineSparklineMode === "lane-relative"
              ? laneMinTs + (laneSpanMs * index) / binCount
              : minTs + (totalSpanMs * index) / binCount;
          const spanEndTs =
            state.captureTimelineSparklineMode === "lane-relative"
              ? laneMinTs + (laneSpanMs * (index + 1)) / binCount
              : minTs + (totalSpanMs * (index + 1)) / binCount;
          const startPct = ((spanStartTs - minTs) / Math.max(1, totalSpanMs)) * 100;
          const endPct = ((spanEndTs - minTs) / Math.max(1, totalSpanMs)) * 100;
          const binLabel = `${laneId} · ${formatTime(spanStartTs)} → ${formatTime(spanEndTs)} · ${count} events`;
          return `<button
            class="capture-timeline-sparkline-bar"
            data-capture-sparkline-window="${esc(laneId)}:${index}"
            data-capture-window-start="${startPct.toFixed(4)}"
            data-capture-window-end="${endPct.toFixed(4)}"
            type="button"
            title="${esc(`${binLabel} · click/drag: custom window · Shift+drag: wider context`)}"
            style="height:${height}%"
          ></button>`;
        })
        .join("")}
    </div>`;
  };
  const computeLaneSeverity = (eventsForLane: CaptureEventView[]) => {
    const total = eventsForLane.length;
    const errorCount = eventsForLane.filter(
      (event) => Boolean(event.errorText) || (event.status ?? 0) >= 400,
    ).length;
    const focusedCount = selectedFlowId
      ? eventsForLane.filter((event) => event.flowId === selectedFlowId).length
      : 0;
    const recencyScore =
      total === 0
        ? 0
        : eventsForLane.reduce((max, event) => Math.max(max, event.ts), 0) / Math.max(1, maxTs);
    const errorShare = total > 0 ? errorCount / total : 0;
    const focusedShare = total > 0 ? focusedCount / total : 0;
    return (
      errorCount * 10 +
      errorShare * 30 +
      focusedShare * 35 +
      recencyScore * 8 +
      Math.min(total, 40) * 0.2
    );
  };
  const describeLaneSeverity = (eventsForLane: CaptureEventView[]) => {
    const total = eventsForLane.length;
    const errorCount = eventsForLane.filter(
      (event) => Boolean(event.errorText) || (event.status ?? 0) >= 400,
    ).length;
    const focusedCount = selectedFlowId
      ? eventsForLane.filter((event) => event.flowId === selectedFlowId).length
      : 0;
    const newestTs =
      total === 0 ? 0 : eventsForLane.reduce((max, event) => Math.max(max, event.ts), 0);
    const recencyMinutes =
      newestTs > 0 ? Math.max(0, Math.round((maxTs - newestTs) / 60000)) : null;
    const focusedPercent = total > 0 ? Math.round((focusedCount / total) * 100) : 0;
    const errorPercent = total > 0 ? Math.round((errorCount / total) * 100) : 0;
    const reasons: string[] = [];
    if (errorCount > 0) {
      reasons.push(`${errorCount} errors (${errorPercent}%)`);
    }
    if (selectedFlowId && focusedCount > 0) {
      reasons.push(`focused flow ${focusedPercent}%`);
    }
    if (recencyMinutes != null) {
      reasons.push(recencyMinutes === 0 ? "active now" : `${recencyMinutes}m old`);
    }
    if (total > 0) {
      reasons.push(`${total} events`);
    }
    return {
      score: computeLaneSeverity(eventsForLane),
      summary: reasons.join(" · "),
    };
  };
  const unsortedTimelineLanes = Array.from(
    filteredEvents.reduce((lanes, event) => {
      const providerLabel = event.provider || "unlabeled";
      const flowLabel = event.flowId || "(no flow id)";
      const laneConfig =
        state.captureTimelineLaneMode === "provider"
          ? {
              id: providerLabel,
              label: providerLabel,
              meta: [event.host, event.api, event.model].filter(Boolean).join(" · "),
            }
          : state.captureTimelineLaneMode === "flow"
            ? {
                id: flowLabel,
                label: flowLabel,
                meta: [event.provider, event.host, event.path].filter(Boolean).join(" · "),
              }
            : {
                id: event.host || "(no host)",
                label: event.host || "(no host)",
                meta: [event.provider, event.model].filter(Boolean).join(", "),
              };
      const laneId = laneConfig.id;
      const existing = lanes.get(laneId);
      if (existing) {
        existing.events.push(event);
        return lanes;
      }
      lanes.set(laneId, {
        id: laneId,
        label: laneConfig.label,
        meta: laneConfig.meta,
        events: [event],
      });
      return lanes;
    }, new Map()),
  ).map(([, lane]) => lane);
  const sortTimelineLanes = (
    lanes: Array<{ id: string; label: string; meta: string; events: CaptureEventView[] }>,
    mode: UiState["captureTimelineLaneSort"],
  ) =>
    [...lanes].toSorted((a, b) => {
      const aErrorCount = a.events.filter(
        (event) => Boolean(event.errorText) || (event.status ?? 0) >= 400,
      ).length;
      const bErrorCount = b.events.filter(
        (event) => Boolean(event.errorText) || (event.status ?? 0) >= 400,
      ).length;
      if (mode === "severity") {
        return (
          computeLaneSeverity(b.events) - computeLaneSeverity(a.events) ||
          bErrorCount - aErrorCount ||
          b.events.length - a.events.length ||
          a.label.localeCompare(b.label)
        );
      }
      if (mode === "most-errors") {
        return (
          bErrorCount - aErrorCount ||
          b.events.length - a.events.length ||
          a.label.localeCompare(b.label)
        );
      }
      if (mode === "alphabetical") {
        return a.label.localeCompare(b.label);
      }
      return (
        b.events.length - a.events.length ||
        bErrorCount - aErrorCount ||
        a.label.localeCompare(b.label)
      );
    });
  const timelineLanes = sortTimelineLanes(unsortedTimelineLanes, state.captureTimelineLaneSort);
  const previousTimelineLanes =
    state.captureTimelinePreviousLaneSort == null
      ? null
      : sortTimelineLanes(unsortedTimelineLanes, state.captureTimelinePreviousLaneSort);
  const previousLanePosition = new Map<string, number>(
    (previousTimelineLanes ?? []).map((lane, index) => [lane.id, index]),
  );
  const laneSearch = state.captureTimelineLaneSearch.trim().toLowerCase();
  const collapsedLaneIds = new Set(state.captureCollapsedLaneIds);
  const pinnedLaneIds = new Set(state.capturePinnedLaneIds);
  const focusedLaneMode =
    state.captureTimelineFocusSelectedFlow && selectedFlowId
      ? state.captureTimelineFocusedLaneMode
      : "all";
  const focusedLaneThreshold =
    state.captureTimelineFocusSelectedFlow && selectedFlowId
      ? state.captureTimelineFocusedLaneThreshold
      : "any";
  const laneMeetsFocusedThreshold = (focusedCount: number, laneTotal: number) => {
    if (focusedLaneThreshold === "events-2") {
      return focusedCount >= 2;
    }
    if (focusedLaneThreshold === "percent-10") {
      return laneTotal > 0 && focusedCount / laneTotal >= 0.1;
    }
    if (focusedLaneThreshold === "percent-25") {
      return laneTotal > 0 && focusedCount / laneTotal >= 0.25;
    }
    return focusedCount > 0;
  };
  const visibleTimelineLanes = timelineLanes.filter((lane) => {
    const focusedCount = selectedFlowId
      ? lane.events.filter((event) => event.flowId === selectedFlowId).length
      : 0;
    if (
      focusedLaneMode === "only-matching" &&
      !laneMeetsFocusedThreshold(focusedCount, lane.events.length) &&
      !pinnedLaneIds.has(lane.id)
    ) {
      return false;
    }
    if (pinnedLaneIds.size > 0 && pinnedLaneIds.has(lane.id)) {
      return true;
    }
    if (!laneSearch) {
      return pinnedLaneIds.size === 0 || !pinnedLaneIds.has(lane.id);
    }
    const haystack = [lane.label, lane.meta].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(laneSearch);
  });
  const summaryChips = [
    sessionIds.length > 1 ? `sessions: ${sessionIds.length}` : null,
    analysisEnabled ? `analysis: ${state.captureQueryPreset}` : "raw only",
    state.captureViewMode === "timeline"
      ? `timeline: ${state.captureTimelineLaneMode}`
      : "view: list",
    state.captureViewMode === "timeline" ? `sort: ${state.captureTimelineLaneSort}` : null,
    state.captureViewMode === "timeline" ? `zoom: ${state.captureTimelineZoom}%` : null,
    activeFilters.length > 0 ? `filters: ${activeFilters.length}` : null,
    normalizedSearch ? `search` : null,
  ].filter((value): value is string => Boolean(value));
  const summaryMeta = [
    `${filteredEvents.length} visible`,
    selectedSessions.length > 0 ? `${selectedSessionEventCount} stored` : null,
    state.captureViewMode === "timeline" && activeWindowLabel
      ? `window ${activeWindowLabel}`
      : null,
    state.captureViewMode === "timeline"
      ? `${visibleTimelineLanes.length}/${timelineLanes.length} lanes${pinnedLaneIds.size > 0 ? ` · ${pinnedLaneIds.size} pinned` : ""}`
      : null,
    state.captureTimelineFocusSelectedFlow && selectedEvent?.flowId
      ? `focus ${selectedEvent.flowId}`
      : null,
  ].filter((value): value is string => Boolean(value));
  const groupedEvents =
    state.captureGroupMode === "none" || state.captureGroupMode === "burst"
      ? [{ id: "__all__", label: "All Events", meta: "", events: filteredEvents }]
      : Array.from(
          filteredEvents.reduce((groups, event) => {
            const key =
              state.captureGroupMode === "flow"
                ? event.flowId || "(no flow)"
                : [event.host || "(no host)", event.path || "/"].join(" ");
            const label =
              state.captureGroupMode === "flow"
                ? event.flowId || "(no flow id)"
                : [event.host || "(no host)", event.path || "/"].join(" ");
            const existing = groups.get(key);
            if (existing) {
              existing.events.push(event);
              return groups;
            }
            groups.set(key, {
              id: key,
              label,
              meta:
                state.captureGroupMode === "flow"
                  ? [event.host, event.path].filter(Boolean).join(" ")
                  : event.flowId || "",
              events: [event],
            });
            return groups;
          }, new Map()),
        ).map(([, group]) => group);
  const clusterEventBursts = (eventsForGroup: CaptureEventView[]) => {
    const sorted = [...eventsForGroup].toSorted(
      (left, right) =>
        left.ts - right.ts || captureEventKey(left).localeCompare(captureEventKey(right)),
    );
    const clusters: Array<{
      key: string;
      representative: CaptureEventView;
      events: CaptureEventView[];
      count: number;
      startTs: number;
      endTs: number;
    }> = [];
    for (const event of sorted) {
      const previous = clusters.at(-1);
      const sameShape =
        previous &&
        previous.representative.kind === event.kind &&
        previous.representative.direction === event.direction &&
        (previous.representative.provider || "") === (event.provider || "") &&
        (previous.representative.host || "") === (event.host || "") &&
        (previous.representative.path || "") === (event.path || "") &&
        (previous.representative.method || "") === (event.method || "") &&
        (previous.representative.status || 0) === (event.status || 0) &&
        event.ts - previous.endTs <= 1500;
      if (!sameShape) {
        clusters.push({
          key: captureEventKey(event),
          representative: event,
          events: [event],
          count: 1,
          startTs: event.ts,
          endTs: event.ts,
        });
        continue;
      }
      previous.events.push(event);
      previous.count += 1;
      previous.endTs = event.ts;
      previous.representative = event;
    }
    return clusters;
  };
  const selectedHeaders = parseJsonObject(selectedEvent?.headersJson);
  const selectedHeaderCount = selectedHeaders ? Object.keys(selectedHeaders).length : 0;
  const selectedSensitiveHeaderCount = selectedHeaders
    ? Object.keys(selectedHeaders).filter((label) => isSensitiveCaptureField(label)).length
    : 0;
  const selectedPayload = renderCapturePayload(
    selectedEvent?.dataText,
    selectedEvent?.contentType,
    {
      payloadEventSort: state.capturePayloadEventSort,
      payloadEventFilter: state.capturePayloadEventFilter,
    },
  );
  const selectedMetaRows = selectedEvent
    ? [
        { label: "provider", value: selectedEvent.provider ?? "unlabeled" },
        { label: "model", value: selectedEvent.model ?? "n/a" },
        { label: "api", value: selectedEvent.api ?? "n/a" },
        { label: "peer host", value: selectedEvent.host ?? "n/a" },
        { label: "path", value: selectedEvent.path ?? "n/a" },
        { label: "flow id", value: selectedEvent.flowId },
        { label: "capture origin", value: selectedEvent.captureOrigin ?? "runtime/default" },
        { label: "content-type", value: selectedEvent.contentType ?? "n/a" },
      ].filter((row) => row.value.trim().length > 0)
    : [];
  const rawPayloadBody = selectedEvent?.dataText?.length
    ? `<pre class="report-pre capture-pre">${esc(redactCaptureScalar(selectedEvent.dataText))}</pre>`
    : '<div class="empty-state">No inline payload preview for this event.</div>';
  const availableDetailViews: Array<{
    value: UiState["captureDetailView"];
    label: string;
    available: boolean;
    recommended: boolean;
  }> = [
    { value: "overview", label: "Overview", available: true, recommended: false },
    {
      value: "flow",
      label: "Flow",
      available: selectedFlowEvents.length > 0 || pairedEvent != null,
      recommended:
        (selectedEvent?.kind === "request" || selectedEvent?.kind === "response") &&
        (selectedFlowEvents.length > 1 || pairedEvent != null),
    },
    {
      value: "payload",
      label: "Payload",
      available: Boolean(selectedEvent?.dataText?.length || selectedEvent?.dataBlobId),
      recommended: selectedPayload.byteLength > 0,
    },
    {
      value: "headers",
      label: "Headers",
      available: selectedHeaderCount > 0,
      recommended: !selectedPayload.byteLength && selectedHeaderCount > 0,
    },
  ];
  if (!availableDetailViews.some((view) => view.recommended && view.available)) {
    availableDetailViews[0].recommended = true;
  }
  const preferredDetailView = state.capturePreferredDetailView;
  const effectiveDetailView = availableDetailViews.some(
    (view) => view.value === preferredDetailView && view.available,
  )
    ? (preferredDetailView ?? "overview")
    : availableDetailViews.some((view) => view.value === state.captureDetailView && view.available)
      ? state.captureDetailView
      : (availableDetailViews.find((view) => view.recommended && view.available)?.value ??
        "overview");
  const effectiveFlowLayout =
    state.captureFlowDetailLayout ??
    ((selectedEvent?.kind === "request" || selectedEvent?.kind === "response") && pairedEvent
      ? "pair-first"
      : "nav-first");
  const effectivePayloadLayout =
    state.capturePayloadDetailLayout ?? (selectedPayload.looksStructured ? "formatted" : "raw");
  const effectivePayloadExtent = state.capturePayloadExtent;
  const flowSections = {
    navigation:
      selectedFlowEvents.length > 0
        ? `<section class="capture-detail-section">
            <div class="capture-summary-header">
              <div class="capture-summary-label">Flow Navigation</div>
              <div class="capture-detail-mini-meta">
                <span class="capture-chip">${selectedFlowIndex + 1} / ${selectedFlowEvents.length}</span>
                <span class="capture-chip capture-chip-muted">${esc(selectedEvent?.flowId || "")}</span>
              </div>
            </div>
            <div class="capture-nav-row">
              ${
                previousFlowEvent
                  ? `<button class="capture-nav-button" data-capture-event="${esc(captureEventKey(previousFlowEvent))}" type="button">
                      <span class="capture-nav-label">Previous on flow</span>
                      <span class="capture-nav-meta">${esc(previousFlowEvent.kind)} · ${esc(new Date(previousFlowEvent.ts).toLocaleTimeString())}${
                        previousFlowEventVisible ? "" : " · outside current view"
                      }</span>
                    </button>`
                  : '<div class="capture-nav-placeholder">No earlier event on this flow.</div>'
              }
              ${
                nextFlowEvent
                  ? `<button class="capture-nav-button" data-capture-event="${esc(captureEventKey(nextFlowEvent))}" type="button">
                      <span class="capture-nav-label">Next on flow</span>
                      <span class="capture-nav-meta">${esc(nextFlowEvent.kind)} · ${esc(new Date(nextFlowEvent.ts).toLocaleTimeString())}${
                        nextFlowEventVisible ? "" : " · outside current view"
                      }</span>
                    </button>`
                  : '<div class="capture-nav-placeholder">No later event on this flow.</div>'
              }
            </div>
          </section>`
        : '<div class="empty-state">This event does not have a usable flow.</div>',
    pair: pairedEvent
      ? `<section class="capture-detail-section">
            <div class="capture-summary-header">
              <div class="capture-summary-label">Paired ${esc(selectedPairing.role || "counterpart")}</div>
              <div class="capture-detail-mini-meta">
                ${pairingLatencyMs != null ? `<span class="capture-chip">${formatDuration(pairingLatencyMs)}</span>` : ""}
                ${
                  pairedEventVisible
                    ? '<span class="capture-chip capture-chip-strong">visible now</span>'
                    : '<span class="capture-chip capture-chip-muted">outside current window/filter</span>'
                }
              </div>
            </div>
            <button class="capture-pair-card" data-capture-event="${esc(captureEventKey(pairedEvent))}" type="button">
              <div class="capture-pair-card-top">
                <strong>${esc(pairedEvent.kind)}</strong>
                <span class="text-dimmed text-sm">${esc(new Date(pairedEvent.ts).toLocaleTimeString())}</span>
                ${pairedEvent.status ? `<span class="text-dimmed text-sm">status ${pairedEvent.status}</span>` : ""}
              </div>
              <div class="capture-pair-card-target">${esc(
                [pairedEvent.method, pairedEvent.host, pairedEvent.path]
                  .filter(Boolean)
                  .join(" ") || pairedEvent.flowId,
              )}</div>
              <div class="text-dimmed text-sm">${esc(
                [pairedEvent.provider, pairedEvent.model, pairedEvent.api]
                  .filter(Boolean)
                  .join(" · ") || "same flow",
              )}</div>
            </button>
          </section>`
      : selectedEvent?.kind === "request" || selectedEvent?.kind === "response"
        ? `<section class="capture-detail-section">
              <div class="capture-summary-label">Paired ${esc(
                selectedEvent.kind === "request" ? "response" : "request",
              )}</div>
              <div class="empty-state">No unambiguous counterpart was found on this flow.</div>
            </section>`
        : "",
  };
  const renderDetailView = () => {
    if (!selectedEvent) {
      return "";
    }
    if (effectiveDetailView === "flow") {
      return `
        <div class="capture-detail-stack">
          <div class="capture-subview-switch" role="radiogroup" aria-label="Flow layout">
            <label class="capture-detail-view-option">
              <input type="radio" name="capture-flow-layout" value="nav-first"${
                effectiveFlowLayout === "nav-first" ? " checked" : ""
              } />
              <span>Nav first</span>
            </label>
            <label class="capture-detail-view-option">
              <input type="radio" name="capture-flow-layout" value="pair-first"${
                effectiveFlowLayout === "pair-first" ? " checked" : ""
              } />
              <span>Pair first</span>
            </label>
          </div>
          ${effectiveFlowLayout === "pair-first" ? flowSections.pair + flowSections.navigation : flowSections.navigation + flowSections.pair}
        </div>`;
    }
    if (effectiveDetailView === "payload") {
      return `
        <section class="capture-detail-section">
          <div class="capture-subview-switch" role="radiogroup" aria-label="Payload layout">
            <label class="capture-detail-view-option">
              <input type="radio" name="capture-payload-layout" value="formatted"${
                effectivePayloadLayout === "formatted" ? " checked" : ""
              } />
              <span>Formatted</span>
            </label>
            <label class="capture-detail-view-option">
              <input type="radio" name="capture-payload-layout" value="raw"${
                effectivePayloadLayout === "raw" ? " checked" : ""
              } />
              <span>Raw preview</span>
            </label>
          </div>
          <div class="capture-subview-switch" role="radiogroup" aria-label="Payload extent">
            <label class="capture-detail-view-option">
              <input type="radio" name="capture-payload-extent" value="preview"${
                effectivePayloadExtent === "preview" ? " checked" : ""
              } />
              <span>Preview</span>
            </label>
            <label class="capture-detail-view-option">
              <input type="radio" name="capture-payload-extent" value="full"${
                effectivePayloadExtent === "full" ? " checked" : ""
              } />
              <span>Full inline</span>
            </label>
          </div>
          <div class="capture-summary-header">
            <div class="capture-summary-label">Payload</div>
            <div class="capture-detail-mini-meta">
              <span class="capture-chip">${esc(selectedPayload.mode)}</span>
              <span class="capture-chip">${esc(selectedEvent.contentType || "unknown content-type")}</span>
              ${selectedPayload.byteLength > 0 ? `<span class="capture-chip">${selectedPayload.byteLength.toLocaleString()} bytes previewed</span>` : ""}
              ${
                selectedPayload.mode === "sse" && selectedPayload.itemCount != null
                  ? `<span class="capture-chip capture-chip-muted">${selectedPayload.visibleItemCount ?? selectedPayload.itemCount}/${selectedPayload.itemCount} frames</span>`
                  : ""
              }
              ${selectedEvent.dataBlobId ? '<span class="capture-chip capture-chip-strong">blob-backed</span>' : ""}
            </div>
          </div>
          ${
            selectedPayload.mode === "sse"
              ? `<div class="capture-payload-toolbar">
                  <div class="capture-detail-radio-row" role="radiogroup" aria-label="Payload event sort">
                    <label class="capture-detail-view-option">
                      <input type="radio" name="capture-payload-event-sort" value="stream"${
                        state.capturePayloadEventSort === "stream" ? " checked" : ""
                      } />
                      <span>Stream order</span>
                    </label>
                    <label class="capture-detail-view-option">
                      <input type="radio" name="capture-payload-event-sort" value="name"${
                        state.capturePayloadEventSort === "name" ? " checked" : ""
                      } />
                      <span>Name</span>
                    </label>
                    <label class="capture-detail-view-option">
                      <input type="radio" name="capture-payload-event-sort" value="size"${
                        state.capturePayloadEventSort === "size" ? " checked" : ""
                      } />
                      <span>Largest first</span>
                    </label>
                  </div>
                  <label class="capture-search-field capture-payload-filter-field">Filter
                    <input
                      id="capture-payload-event-filter"
                      type="search"
                      value="${esc(state.capturePayloadEventFilter)}"
                      placeholder="event name, field, payload text..."
                      spellcheck="false"
                    />
                  </label>
                </div>`
              : ""
          }
          <div class="capture-detail-payload capture-detail-payload--${effectivePayloadExtent}">
            ${effectivePayloadLayout === "raw" ? rawPayloadBody : selectedPayload.body}
            ${
              effectivePayloadLayout !== "raw" && selectedPayload.looksStructured
                ? '<div class="text-dimmed text-sm capture-detail-note">Structured payloads are pretty-printed and secret-like fields are redacted for the UI.</div>'
                : ""
            }
          </div>
        </section>
        ${
          selectedEvent.dataBlobId
            ? `<section class="capture-detail-section">
                <div class="capture-summary-header">
                  <div class="capture-summary-label">Stored Blob</div>
                  <div class="capture-detail-mini-meta">
                    <span class="capture-chip">full payload</span>
                  </div>
                </div>
                <div class="capture-detail-actions">
                  <span class="capture-mono">${esc(selectedEvent.dataBlobId)}</span>
                  <a class="btn-sm" href="/api/capture/blob?id=${encodeURIComponent(selectedEvent.dataBlobId)}" target="_blank" rel="noreferrer">Open blob</a>
                </div>
                <div class="text-dimmed text-sm capture-detail-note">Blob access is intentionally raw and may contain unredacted content.</div>
              </section>`
            : ""
        }`;
    }
    if (effectiveDetailView === "headers") {
      return `
        <section class="capture-detail-section">
          <div class="capture-summary-header">
            <div class="capture-summary-label">Headers</div>
            <div class="capture-detail-mini-meta">
              <span class="capture-chip">${selectedHeaderCount} captured</span>
              ${selectedSensitiveHeaderCount > 0 ? `<span class="capture-chip capture-chip-warn">${selectedSensitiveHeaderCount} redacted</span>` : ""}
              <span class="capture-chip capture-chip-muted">${esc(state.captureHeaderMode)}</span>
            </div>
          </div>
          ${renderCaptureHeaders(selectedEvent.headersJson, state.captureHeaderMode)}
          ${
            state.captureHeaderMode !== "hidden" && selectedSensitiveHeaderCount > 0
              ? '<div class="text-dimmed text-sm capture-detail-note">Sensitive header values are redacted in the UI.</div>'
              : ""
          }
        </section>
        ${
          selectedHeaders && state.captureHeaderMode !== "hidden"
            ? `<details class="capture-detail-raw">
                <summary class="text-dimmed text-sm">Redacted headers JSON</summary>
                <pre class="report-pre capture-pre capture-pre-json">${esc(
                  JSON.stringify(redactCaptureValue(selectedHeaders), null, 2),
                )}</pre>
              </details>`
            : ""
        }`;
    }
    return `
      <div class="capture-detail-stack">
        <section class="capture-detail-section">
          <div class="capture-summary-label">Overview</div>
          ${renderCaptureKeyValueGrid([
            { label: "time", value: new Date(selectedEvent.ts).toLocaleString() },
            {
              label: "target",
              value:
                [selectedEvent.method, selectedEvent.host, selectedEvent.path]
                  .filter(Boolean)
                  .join(" ") || "n/a",
            },
            {
              label: "provider route",
              value:
                [selectedEvent.provider, selectedEvent.model, selectedEvent.api]
                  .filter(Boolean)
                  .join(" · ") || "unlabeled",
            },
            { label: "capture origin", value: selectedEvent.captureOrigin || "runtime/default" },
          ])}
        </section>
        <section class="capture-detail-section">
          <div class="capture-summary-label">Fields</div>
          ${renderCaptureKeyValueGrid(selectedMetaRows)}
        </section>
        ${
          selectedEvent.errorText
            ? `<section class="capture-detail-section"><div class="capture-summary-label">Error</div><div class="capture-error">${esc(selectedEvent.errorText)}</div></section>`
            : ""
        }
      </div>`;
  };
  return `
    <div class="events-view">
      <div class="events-header">
        <span class="events-header-title">Proxy Capture</span>
        <span class="text-dimmed text-sm">${sessions.length} sessions · ${filteredEvents.length}/${events.length} events shown</span>
      </div>
      <div class="text-dimmed text-sm" style="margin-bottom:14px">
        Raw traffic always appears in <strong>Recent Events</strong>. The preset only controls the optional analysis panel.
      </div>
      <div class="capture-controls-shell">
        <div class="capture-controls-toolbar">
          <div class="capture-controls-summary">
            <span class="capture-chip capture-chip-muted">${selectedSessions.length || 0} session${selectedSessions.length === 1 ? "" : "s"}</span>
            <span class="capture-chip capture-chip-muted">${state.captureViewMode}</span>
            ${
              state.captureQueryPreset !== "none"
                ? `<span class="capture-chip capture-chip-muted">analysis: ${esc(state.captureQueryPreset)}</span>`
                : `<span class="capture-chip capture-chip-muted">raw only</span>`
            }
            <span class="capture-chip capture-chip-muted">${activeFilters.length} filter${activeFilters.length === 1 ? "" : "s"}</span>
            ${
              state.captureViewMode === "timeline"
                ? `<span class="capture-chip capture-chip-muted">lanes: ${esc(state.captureTimelineLaneMode)}</span>`
                : ""
            }
          </div>
          <div class="capture-controls-actions">
            ${
              selectedSessions.length > 0
                ? `<button class="btn-sm" type="button" id="capture-summary-toggle">
                    ${state.captureSummaryExpanded ? "Hide summary" : "Show summary"}
                  </button>`
                : ""
            }
            ${
              activeFilters.length > 0
                ? `<button
                    id="capture-clear-filters"
                    class="secondary-button capture-clear-filters"
                    type="button"
                  >Clear filters</button>`
                : ""
            }
            <button class="btn-sm" type="button" id="capture-controls-toggle">
              ${state.captureControlsExpanded ? "Collapse controls" : "Show controls"}
            </button>
          </div>
        </div>
        ${
          state.captureControlsExpanded
            ? `<div class="capture-controls-panel">
      <div class="capture-controls-grid">
        <label class="capture-session-filter">Session
          <select id="capture-session" multiple size="${Math.min(3, Math.max(2, sessions.length || 2))}">
            ${sessions
              .map(
                (session) =>
                  `<option value="${esc(session.id)}"${
                    sessionIds.includes(session.id) ? " selected" : ""
                  }>${esc(new Date(session.startedAt).toLocaleString())} · ${esc(session.mode)} · ${session.eventCount} events</option>`,
              )
              .join("")}
          </select>
        </label>
        <div class="capture-inline-actions">
          <label class="capture-saved-view-filter">Saved view
            <select id="capture-saved-view">
              <option value="">apply saved view…</option>
              ${state.captureSavedViews
                .map((view) => `<option value="${esc(view.id)}">${esc(view.name)}</option>`)
                .join("")}
            </select>
          </label>
          <button id="capture-save-view" class="btn-sm" type="button">Save view</button>
          <button
            id="capture-delete-view"
            class="btn-sm"
            type="button"${state.captureSavedViews.length === 0 ? " disabled" : ""}
          >Delete view</button>
        </div>
        ${
          selectedSessions.length > 0
            ? `<div class="capture-selected-sessions-shell">
                <div class="capture-selected-sessions-summary">
                  <span class="capture-chip capture-chip-muted">${selectedSessions.length} selected</span>
                  ${
                    selectedSessions.length > 1
                      ? `<button
                          id="capture-toggle-selected-sessions"
                          class="btn-sm"
                          type="button"
                        >${state.captureSelectedSessionsExpanded ? "Hide selected" : "Manage selected"}</button>`
                      : ""
                  }
                </div>
                ${
                  state.captureSelectedSessionsExpanded || selectedSessions.length === 1
                    ? `<div class="capture-selected-sessions">
                        ${selectedSessions
                          .map(
                            (session) => `<button
                              type="button"
                              class="capture-selected-session-chip"
                              data-capture-session-remove="${esc(session.id)}"
                              title="Remove ${esc(new Date(session.startedAt).toLocaleString())}"
                            >
                              <span class="capture-selected-session-chip-label">${esc(new Date(session.startedAt).toLocaleString())}</span>
                              <span class="capture-selected-session-chip-x">×</span>
                            </button>`,
                          )
                          .join("")}
                      </div>`
                    : ""
                }
              </div>`
            : ""
        }
        <div class="capture-inline-actions">
          <button
            id="capture-delete-selected-sessions"
            class="btn-sm"
            type="button"${selectedSessions.length === 0 ? " disabled" : ""}
          >Delete selected data</button>
          <button
            id="capture-purge-all"
            class="btn-sm"
            type="button"${sessions.length === 0 ? " disabled" : ""}
          >Purge all data</button>
        </div>
        <label>Analysis
          <select id="capture-preset">
            ${(
              [
                "none",
                "double-sends",
                "retry-storms",
                "cache-busting",
                "ws-duplicate-frames",
                "missing-ack",
                "error-bursts",
              ] as CaptureQueryPreset[]
            )
              .map(
                (preset) =>
                  `<option value="${preset}"${
                    preset === state.captureQueryPreset ? " selected" : ""
                  }>${preset === "none" ? "none (show raw events only)" : preset}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label>Kind
          <select id="capture-kind-filter" multiple size="${Math.min(6, Math.max(3, availableKinds.length || 3))}">
            ${availableKinds
              .map(
                (kind) =>
                  `<option value="${esc(kind)}"${
                    state.captureKindFilter.includes(kind) ? " selected" : ""
                  }>${esc(kind)}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label>Provider
          <select id="capture-provider-filter" multiple size="${Math.min(6, Math.max(3, availableProviders.length || 3))}">
            ${availableProviders
              .map(
                (provider) =>
                  `<option value="${esc(provider)}"${
                    state.captureProviderFilter.includes(provider) ? " selected" : ""
                  }>${esc(provider)}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label>Host
          <select id="capture-host-filter" multiple size="${Math.min(6, Math.max(3, availableHosts.length || 3))}">
            ${availableHosts
              .map(
                (host) =>
                  `<option value="${esc(host)}"${
                    state.captureHostFilter.includes(host) ? " selected" : ""
                  }>${esc(host)}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label>View
          <select id="capture-view-mode">
            <option value="list"${state.captureViewMode === "list" ? " selected" : ""}>list</option>
            <option value="timeline"${state.captureViewMode === "timeline" ? " selected" : ""}>timeline</option>
          </select>
        </label>
        ${
          state.captureViewMode === "timeline"
            ? `
        <label>Timeline Lanes
          <select id="capture-timeline-lane-mode">
            <option value="domain"${state.captureTimelineLaneMode === "domain" ? " selected" : ""}>domain</option>
            <option value="provider"${state.captureTimelineLaneMode === "provider" ? " selected" : ""}>provider</option>
            <option value="flow"${state.captureTimelineLaneMode === "flow" ? " selected" : ""}>flow</option>
          </select>
        </label>
        <label>Lane Sort
          <select id="capture-timeline-lane-sort">
            <option value="most-events"${state.captureTimelineLaneSort === "most-events" ? " selected" : ""}>most events</option>
            <option value="most-errors"${state.captureTimelineLaneSort === "most-errors" ? " selected" : ""}>most errors</option>
            <option value="severity"${state.captureTimelineLaneSort === "severity" ? " selected" : ""}>severity</option>
            <option value="alphabetical"${state.captureTimelineLaneSort === "alphabetical" ? " selected" : ""}>alphabetical</option>
          </select>
        </label>
        <label class="capture-search-field">Lane Search
          <input
            id="capture-timeline-lane-search"
            type="search"
            value="${esc(state.captureTimelineLaneSearch)}"
            placeholder="provider, host, flow..."
            spellcheck="false"
          />
        </label>
        <label>Timeline Zoom
          <select id="capture-timeline-zoom">
            <option value="75"${state.captureTimelineZoom === 75 ? " selected" : ""}>75%</option>
            <option value="100"${state.captureTimelineZoom === 100 ? " selected" : ""}>100%</option>
            <option value="150"${state.captureTimelineZoom === 150 ? " selected" : ""}>150%</option>
            <option value="200"${state.captureTimelineZoom === 200 ? " selected" : ""}>200%</option>
            <option value="300"${state.captureTimelineZoom === 300 ? " selected" : ""}>300%</option>
          </select>
        </label>
        <label>Sparkline
          <select id="capture-timeline-sparkline-mode">
            <option value="session-relative"${state.captureTimelineSparklineMode === "session-relative" ? " selected" : ""}>session-relative</option>
            <option value="lane-relative"${state.captureTimelineSparklineMode === "lane-relative" ? " selected" : ""}>lane-relative</option>
          </select>
        </label>
        <button
          id="capture-timeline-clear-window"
          class="secondary-button capture-clear-filters"
          type="button"${
            activeWindowStartPct == null && draftWindowStartPct == null ? " disabled" : ""
          }
        >Clear window</button>
        <label class="capture-checkbox">
          <input
            id="capture-timeline-focus-flow"
            type="checkbox"${
              state.captureTimelineFocusSelectedFlow ? " checked" : ""
            }${selectedEvent?.flowId ? "" : " disabled"}
          />
          <span>focus selected flow</span>
        </label>
        <label>Focused Lanes
          <select id="capture-timeline-focused-lane-mode"${state.captureTimelineFocusSelectedFlow && selectedEvent?.flowId ? "" : " disabled"}>
            <option value="all"${state.captureTimelineFocusedLaneMode === "all" ? " selected" : ""}>show all</option>
            <option value="only-matching"${state.captureTimelineFocusedLaneMode === "only-matching" ? " selected" : ""}>only matching</option>
            <option value="collapse-background"${state.captureTimelineFocusedLaneMode === "collapse-background" ? " selected" : ""}>collapse background</option>
          </select>
        </label>
        <label>Focus Threshold
          <select id="capture-timeline-focused-lane-threshold"${state.captureTimelineFocusSelectedFlow && selectedEvent?.flowId ? "" : " disabled"}>
            <option value="any"${state.captureTimelineFocusedLaneThreshold === "any" ? " selected" : ""}>any presence</option>
            <option value="events-2"${state.captureTimelineFocusedLaneThreshold === "events-2" ? " selected" : ""}>2+ events</option>
            <option value="percent-10"${state.captureTimelineFocusedLaneThreshold === "percent-10" ? " selected" : ""}>10%+ of lane</option>
            <option value="percent-25"${state.captureTimelineFocusedLaneThreshold === "percent-25" ? " selected" : ""}>25%+ of lane</option>
          </select>
        </label>`
            : `
        <label>Group
          <select id="capture-group-mode">
            <option value="none"${state.captureGroupMode === "none" ? " selected" : ""}>flat stream</option>
            <option value="burst"${state.captureGroupMode === "burst" ? " selected" : ""}>burst clusters</option>
            <option value="flow"${state.captureGroupMode === "flow" ? " selected" : ""}>flow id</option>
            <option value="host-path"${state.captureGroupMode === "host-path" ? " selected" : ""}>host + path</option>
          </select>
        </label>`
        }
        <label>Detail Pane
          <select id="capture-detail-placement">
            <option value="right"${state.captureDetailPlacement === "right" ? " selected" : ""}>right</option>
            <option value="bottom"${state.captureDetailPlacement === "bottom" ? " selected" : ""}>bottom</option>
          </select>
        </label>
        <label>Headers
          <select id="capture-header-mode">
            <option value="key"${state.captureHeaderMode === "key" ? " selected" : ""}>key only</option>
            <option value="all"${state.captureHeaderMode === "all" ? " selected" : ""}>all</option>
            <option value="hidden"${state.captureHeaderMode === "hidden" ? " selected" : ""}>hidden</option>
          </select>
        </label>
        <label class="capture-search-field">Search
          <input
            id="capture-search-filter"
            type="search"
            value="${esc(state.captureSearchText)}"
            placeholder="host, path, method, status, payload..."
            spellcheck="false"
          />
        </label>
        <label class="capture-checkbox">
          <input id="capture-errors-only" type="checkbox"${state.captureErrorsOnly ? " checked" : ""} />
          <span>errors only</span>
        </label>
      </div></div>`
            : ""
        }
      </div>
      ${
        state.captureControlsExpanded && activeFilters.length > 0
          ? `<div class="capture-active-filters">
              <span class="capture-summary-label" style="margin:0">Active Filters</span>
              <div class="capture-chip-row">
                ${activeFilters.map((filter) => `<span class="capture-chip capture-chip-muted">${esc(filter)}</span>`).join("")}
              </div>
            </div>`
          : ""
      }
      ${
        selectedSessions.length > 0 && state.captureSummaryExpanded
          ? `<div class="capture-summary capture-summary--expanded">
              <div class="capture-summary-card">
                <div class="capture-summary-label">Session</div>
                <div class="capture-summary-value">${
                  singleSelectedSession
                    ? esc(new Date(singleSelectedSession.startedAt).toLocaleString())
                    : `${selectedSessions.length} sessions selected`
                }</div>
                <div class="text-dimmed text-sm">${
                  singleSelectedSession
                    ? `${esc(singleSelectedSession.mode)} · ${singleSelectedSession.eventCount} stored events`
                    : `${selectedSessionEventCount} stored events across ${selectedSessions.length} sessions`
                }</div>
              </div>
              <div class="capture-summary-card">
                <div class="capture-summary-label">What You’re Seeing</div>
                <div class="capture-chip-row">
                  ${summaryChips.map((chip) => `<span class="capture-chip">${esc(chip)}</span>`).join("")}
                </div>
                ${
                  summaryMeta.length > 0
                    ? `<div class="capture-summary-meta text-dimmed text-sm">${summaryMeta.map((part) => esc(part)).join(" · ")}</div>`
                    : ""
                }
                ${
                  state.captureQueryPreset !== "none" && sessionIds.length > 1
                    ? '<div class="capture-summary-note text-dimmed text-sm">Analysis presets currently run on a single session only. Raw traffic below is merged across the selected sessions.</div>'
                    : ""
                }
                ${
                  state.captureViewMode === "timeline"
                    ? '<div class="capture-summary-note text-dimmed text-sm">Keys: 1-4 views · ←/→ markers · Home/End jump · Esc clears brush · drag sparkline bins · Shift+drag widens.</div>'
                    : ""
                }
              </div>
              <div class="capture-summary-card">
                <div class="capture-summary-label">Visible Event Kinds</div>
                <div class="capture-chip-row">
                  ${
                    topKinds.length > 0
                      ? topKinds
                          .map(
                            ([kind, count]) =>
                              `<span class="capture-chip">${esc(kind)} · ${count}</span>`,
                          )
                          .join("")
                      : '<span class="text-dimmed text-sm">No events match the current filters.</span>'
                  }
                </div>
              </div>
              <div class="capture-summary-card">
                <div class="capture-summary-label">Observed Providers</div>
                <div class="capture-chip-row">
                  ${
                    topProviders.length > 0
                      ? topProviders
                          .map(
                            (provider) =>
                              `<span class="capture-chip">${esc(provider.value)} · ${provider.count}</span>`,
                          )
                          .join("")
                      : '<span class="text-dimmed text-sm">No provider metadata captured for this session yet.</span>'
                  }
                </div>
                ${
                  topModels.length > 0
                    ? `<div class="capture-summary-meta text-dimmed text-sm">Top models: ${topModels
                        .map((model) => `${esc(model.value)} (${model.count})`)
                        .join(", ")}</div>`
                    : ""
                }
                ${
                  state.captureCoverage
                    ? `<div class="capture-summary-meta text-dimmed text-sm">${state.captureCoverage.totalEvents} total events · ${state.captureCoverage.unlabeledEventCount} unlabeled by provider/model/api</div>`
                    : ""
                }
              </div>
            </div>`
          : ""
      }
      <div class="results-view"${analysisEnabled ? ' style="grid-template-columns: minmax(420px, 1.7fr) minmax(280px, 0.9fr);"' : ""}>
        <div class="results-inspector">
          <div
            class="capture-body capture-body--detail-${state.captureDetailPlacement}"
            data-capture-detail-split-root
            style="--capture-detail-pane-width:${state.captureDetailSplitPct.toFixed(2)}%;"
          >
            <section class="capture-main-panel">
              <div class="inspector-section-title">${state.captureViewMode === "timeline" ? "Timeline" : "Recent Events"}</div>
              <div class="events-scroll capture-events-scroll">
                ${
                  events.length === 0
                    ? `<div style="padding:20px">${renderCaptureStartupInstructions(state.captureStartupStatus)}</div>`
                    : filteredEvents.length === 0
                      ? '<div class="empty-state" style="padding:20px">No events match the current filters or search text.</div>'
                      : state.captureViewMode === "timeline"
                        ? `<div class="capture-timeline" style="${timelineWidthStyle}">
                        <div class="capture-timeline-legend">
                          <span class="capture-timeline-legend-item"><span class="capture-timeline-legend-dot capture-timeline-legend-dot-request"></span>request</span>
                          <span class="capture-timeline-legend-item"><span class="capture-timeline-legend-dot capture-timeline-legend-dot-response"></span>response</span>
                          <span class="capture-timeline-legend-item"><span class="capture-timeline-legend-dot capture-timeline-legend-dot-error"></span>error</span>
                          <span class="capture-timeline-legend-item"><span class="capture-timeline-legend-dot capture-timeline-legend-dot-ws"></span>ws</span>
                          <span class="capture-timeline-legend-item"><span class="capture-timeline-legend-line"></span>flow trail</span>
                          ${
                            activeWindowStartPct != null && activeWindowEndPct != null
                              ? '<span class="capture-timeline-legend-item"><span class="capture-timeline-legend-window"></span>active window</span>'
                              : ""
                          }
                        </div>
                        <div class="capture-timeline-axis-grid">
                          <div class="capture-timeline-axis-spacer"></div>
                          <div class="capture-timeline-viewport capture-timeline-brush-surface" data-capture-timeline-brush-surface="axis" data-capture-timeline-track-width="${timelineTrackWidthPx}">
                            <div class="capture-timeline-axis">
                              ${renderTimelineWindow(activeWindowStartPct, activeWindowEndPct, "capture-timeline-window")}
                              ${renderTimelineWindow(draftWindowStartPct, draftWindowEndPct, "capture-timeline-window capture-timeline-window-draft")}
                              ${timelineAxisTicks
                                .map(
                                  (
                                    tick,
                                  ) => `<div class="capture-timeline-axis-tick ${tick.edgeClass}" style="left:${tick.pct.toFixed(2)}%">
                                    <span class="capture-timeline-axis-tick-line"></span>
                                    <span class="capture-timeline-axis-tick-label">${esc(tick.label)}</span>
                                  </div>`,
                                )
                                .join("")}
                            </div>
                          </div>
                        </div>
                        ${
                          visibleTimelineLanes.length === 0
                            ? '<div class="empty-state" style="padding:20px">No timeline lanes match the current lane search.</div>'
                            : visibleTimelineLanes
                                .map((lane) => {
                                  const laneErrorCount = lane.events.filter(
                                    (event) =>
                                      Boolean(event.errorText) || (event.status ?? 0) >= 400,
                                  ).length;
                                  const laneRequestCount = lane.events.filter(
                                    (event) => event.kind === "request",
                                  ).length;
                                  const laneResponseCount = lane.events.filter(
                                    (event) => event.kind === "response",
                                  ).length;
                                  const collapsed = collapsedLaneIds.has(lane.id);
                                  const pinned = pinnedLaneIds.has(lane.id);
                                  const sortedLaneEvents = [...lane.events].toSorted(
                                    (left, right) => left.ts - right.ts,
                                  );
                                  const markerGapPx = 16;
                                  const rowStridePx = 18;
                                  const baselineTopPx = 18;
                                  const rowRightEdges: number[] = [];
                                  const packedMarkers = sortedLaneEvents.map((event) => {
                                    const key = captureEventKey(event);
                                    const leftPct = ((event.ts - minTs) / totalSpanMs) * 100;
                                    const leftPx = (leftPct / 100) * timelineTrackWidthPx;
                                    let rowIndex = 0;
                                    while (
                                      rowIndex < rowRightEdges.length &&
                                      rowRightEdges[rowIndex] > leftPx - markerGapPx
                                    ) {
                                      rowIndex += 1;
                                    }
                                    rowRightEdges[rowIndex] = leftPx + markerGapPx;
                                    const topPx = baselineTopPx + rowIndex * rowStridePx;
                                    return { event, key, leftPct, leftPx, rowIndex, topPx };
                                  });
                                  const laneRowCount = Math.max(
                                    1,
                                    packedMarkers.reduce(
                                      (max, marker) => Math.max(max, marker.rowIndex + 1),
                                      1,
                                    ),
                                  );
                                  const laneTrackHeightPx = collapsed
                                    ? 18
                                    : Math.max(
                                        42,
                                        baselineTopPx + (laneRowCount - 1) * rowStridePx + 18,
                                      );
                                  const selectedLaneEvent =
                                    lane.events.find((event) => {
                                      const key = captureEventKey(event);
                                      return key === selectedEventKey;
                                    }) ?? null;
                                  const selectedFlowId =
                                    selectedLaneEvent?.flowId || selectedEvent?.flowId || "";
                                  const focusSelectedFlow =
                                    state.captureTimelineFocusSelectedFlow &&
                                    selectedFlowId.length > 0;
                                  const laneFocusedEventCount = focusSelectedFlow
                                    ? lane.events.filter((event) => event.flowId === selectedFlowId)
                                        .length
                                    : 0;
                                  const laneBackgroundEventCount = focusSelectedFlow
                                    ? lane.events.length - laneFocusedEventCount
                                    : 0;
                                  const laneFocusedPercent =
                                    focusSelectedFlow && lane.events.length > 0
                                      ? Math.round(
                                          (laneFocusedEventCount / lane.events.length) * 100,
                                        )
                                      : 0;
                                  const laneSelected = selectedLaneEvent != null;
                                  const laneSeverity = describeLaneSeverity(lane.events);
                                  const laneMeetsThreshold = focusSelectedFlow
                                    ? laneMeetsFocusedThreshold(
                                        laneFocusedEventCount,
                                        lane.events.length,
                                      )
                                    : false;
                                  const autoCollapsed =
                                    focusSelectedFlow &&
                                    focusedLaneMode === "collapse-background" &&
                                    !laneMeetsThreshold;
                                  const laneCompactMetaParts = [
                                    focusSelectedFlow
                                      ? `${laneFocusedPercent}% focus${laneBackgroundEventCount > 0 ? ` · ${laneBackgroundEventCount} bg` : ""}`
                                      : null,
                                    laneErrorCount > 0 ? `${laneErrorCount} err` : null,
                                    state.captureTimelineLaneSort === "severity"
                                      ? laneSeverity.summary
                                      : null,
                                    autoCollapsed ? "auto-collapsed" : null,
                                  ].filter((value): value is string => Boolean(value));
                                  const previousIndex = previousLanePosition.get(lane.id);
                                  const currentIndex = timelineLanes.findIndex(
                                    (candidate) => candidate.id === lane.id,
                                  );
                                  const laneMovement =
                                    previousIndex == null ? null : previousIndex - currentIndex;
                                  const laneIsCollapsed = collapsed || autoCollapsed;
                                  const flowLinks = laneIsCollapsed
                                    ? ""
                                    : Array.from(
                                        packedMarkers.reduce<Map<string, typeof packedMarkers>>(
                                          (flows, marker) => {
                                            const flowId = marker.event.flowId?.trim();
                                            if (!flowId) {
                                              return flows;
                                            }
                                            const existing = flows.get(flowId) ?? [];
                                            existing.push(marker);
                                            flows.set(flowId, existing);
                                            return flows;
                                          },
                                          new Map(),
                                        ),
                                      )
                                        .flatMap(([, markers]) => {
                                          if (markers.length < 2) {
                                            return [];
                                          }
                                          return markers.slice(1).map((marker, index) => {
                                            const previous = markers[index];
                                            const dx = marker.leftPx - previous.leftPx;
                                            const dy = marker.topPx - previous.topPx;
                                            const length = Math.sqrt(dx * dx + dy * dy);
                                            const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
                                            const selected =
                                              selectedFlowId.length > 0 &&
                                              marker.event.flowId === selectedFlowId;
                                            const dimmed =
                                              focusSelectedFlow &&
                                              marker.event.flowId !== selectedFlowId;
                                            const paired =
                                              pairedEventKey != null &&
                                              captureEventKey(marker.event) === pairedEventKey;
                                            return `<div
                                        class="capture-timeline-flow-link${selected ? " selected" : ""}${dimmed ? " dimmed" : ""}${paired ? " paired" : ""}"
                                        style="left:${previous.leftPct.toFixed(2)}%;top:${previous.topPx}px;width:${length.toFixed(2)}px;transform:translateY(-50%) rotate(${angle.toFixed(2)}deg)"
                                      ></div>`;
                                          });
                                        })
                                        .join("");
                                  const laneGuides = timelineAxisTicks
                                    .slice(1, -1)
                                    .map(
                                      (tick) => `<div
                                  class="capture-timeline-guide"
                                  style="left:${tick.pct.toFixed(2)}%"
                                  aria-hidden="true"
                                ></div>`,
                                    )
                                    .join("");
                                  const markers = packedMarkers
                                    .map(({ event, key, leftPct, topPx }) => {
                                      const selected =
                                        selectedEventKey != null && key === selectedEventKey;
                                      const kindClass = `capture-timeline-marker-${event.kind.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
                                      const dimmed =
                                        focusSelectedFlow && event.flowId !== selectedFlowId;
                                      const paired =
                                        pairedEventKey != null && key === pairedEventKey;
                                      const label = [
                                        formatTime(event.ts),
                                        event.provider,
                                        event.model,
                                        event.kind,
                                        event.method,
                                        event.host,
                                        event.path,
                                        event.status ? `status ${event.status}` : "",
                                        event.errorText ?? "",
                                      ]
                                        .filter(Boolean)
                                        .join(" · ");
                                      return `<button
                                  class="capture-timeline-marker ${kindClass}${selected ? " selected" : ""}${dimmed ? " dimmed" : ""}${paired ? " paired" : ""}"
                                  data-capture-event="${esc(key)}"
                                  type="button"
                                  style="left:${leftPct.toFixed(2)}%;top:${topPx}px"
                                  title="${esc(label)}"
                                ></button>`;
                                    })
                                    .join("");
                                  const collapsedMarkers = laneIsCollapsed
                                    ? packedMarkers
                                        .map(({ event, key, leftPct }) => {
                                          const selected =
                                            selectedEventKey != null && key === selectedEventKey;
                                          const kindClass = `capture-timeline-marker-${event.kind
                                            .replace(/[^a-z0-9]+/gi, "-")
                                            .toLowerCase()}`;
                                          const dimmed =
                                            focusSelectedFlow && event.flowId !== selectedFlowId;
                                          const paired =
                                            pairedEventKey != null && key === pairedEventKey;
                                          return `<button
                                      class="capture-timeline-marker capture-timeline-marker-mini ${kindClass}${
                                        selected ? " selected" : ""
                                      }${dimmed ? " dimmed" : ""}${paired ? " paired" : ""}"
                                      data-capture-event="${esc(key)}"
                                      type="button"
                                      style="left:${leftPct.toFixed(2)}%;top:${baselineTopPx}px"
                                      title="${esc(
                                        [formatTime(event.ts), event.kind, event.host, event.path]
                                          .filter(Boolean)
                                          .join(" · "),
                                      )}"
                                    ></button>`;
                                        })
                                        .join("")
                                    : "";
                                  const selectedLaneLeft =
                                    selectedLaneEvent == null
                                      ? 50
                                      : Math.min(
                                          84,
                                          Math.max(
                                            16,
                                            ((selectedLaneEvent.ts - minTs) / totalSpanMs) * 100,
                                          ),
                                        );
                                  const quickPreview =
                                    selectedLaneEvent && !laneIsCollapsed
                                      ? `<div class="capture-timeline-quick-preview" style="left:${selectedLaneLeft.toFixed(2)}%">
                                    <div class="capture-timeline-quick-preview-row">
                                      <span class="capture-chip">${esc(selectedLaneEvent.kind)}</span>
                                      ${
                                        selectedLaneEvent.provider
                                          ? `<span class="capture-chip">${esc(selectedLaneEvent.provider)}</span>`
                                          : ""
                                      }
                                      ${
                                        selectedLaneEvent.status
                                          ? `<span class="capture-chip capture-chip-muted">status ${selectedLaneEvent.status}</span>`
                                          : ""
                                      }
                                    </div>
                                    <div class="capture-timeline-quick-preview-title">${esc(
                                      [
                                        selectedLaneEvent.method,
                                        selectedLaneEvent.host,
                                        selectedLaneEvent.path,
                                      ]
                                        .filter(Boolean)
                                        .join(" ") || selectedLaneEvent.flowId,
                                    )}</div>
                                    <div class="capture-timeline-quick-preview-meta">${esc(
                                      [
                                        new Date(selectedLaneEvent.ts).toLocaleTimeString(),
                                        selectedLaneEvent.model,
                                        selectedLaneEvent.api,
                                      ]
                                        .filter(Boolean)
                                        .join(" · "),
                                    )}</div>
                                    ${
                                      selectedLaneEvent.errorText
                                        ? `<div class="capture-timeline-quick-preview-error">${esc(selectedLaneEvent.errorText)}</div>`
                                        : selectedLaneEvent.payloadPreview
                                          ? `<div class="capture-timeline-quick-preview-snippet">${esc(selectedLaneEvent.payloadPreview)}</div>`
                                          : ""
                                    }
                                  </div>`
                                      : "";
                                  return `<div class="capture-timeline-lane${laneSelected ? " selected" : ""}">
                                <div class="capture-timeline-lane-label${laneSelected ? " selected" : ""}">
                                  <div class="capture-timeline-lane-toolbar">
                                    <button class="capture-timeline-lane-toggle" data-capture-lane-toggle="${esc(lane.id)}" type="button">
                                      <span class="capture-timeline-lane-chevron">${laneIsCollapsed ? "▸" : "▾"}</span>
                                      <span class="capture-timeline-lane-title">${esc(lane.label)}</span>
                                    </button>
                                    <button class="capture-timeline-lane-pin${pinned ? " pinned" : ""}" data-capture-lane-pin="${esc(lane.id)}" type="button" title="${pinned ? "Unpin lane" : "Pin lane"}">
                                      ${pinned ? "★" : "☆"}
                                    </button>
                                  </div>
                                  <div class="capture-timeline-lane-meta">${lane.events.length} event${lane.events.length === 1 ? "" : "s"}${
                                    lane.meta ? ` · ${esc(lane.meta)}` : ""
                                  }</div>
                                  ${
                                    focusSelectedFlow && laneSelected
                                      ? `<div class="capture-timeline-lane-focus-meta">
                                          <span class="capture-mono">${esc(selectedFlowId)}</span>
                                          <span>·</span>
                                          <span>${laneFocusedEventCount}/${lane.events.length} events focused</span>
                                          <span>·</span>
                                          <span>${laneFocusedPercent}% of lane</span>
                                          ${
                                            laneBackgroundEventCount > 0
                                              ? `<span>·</span><span>${laneBackgroundEventCount} background</span>`
                                              : ""
                                          }
                                          ${
                                            focusSelectedFlow && !laneMeetsThreshold
                                              ? `<span>·</span><span>below threshold</span>`
                                              : ""
                                          }
                                        </div>`
                                      : ""
                                  }
                                  ${
                                    autoCollapsed && laneSelected
                                      ? '<div class="capture-timeline-lane-meta">Auto-collapsed because the focused flow is not present in this lane.</div>'
                                      : ""
                                  }
                                  ${
                                    !laneSelected && laneCompactMetaParts.length > 0
                                      ? `<div class="capture-timeline-lane-compact-meta">${esc(laneCompactMetaParts.join(" · "))}</div>`
                                      : ""
                                  }
                                  ${renderLaneSparkline(lane.events, lane.id)}
                                  <div class="capture-timeline-lane-stats">
                                    <span class="capture-timeline-stat" title="requests">
                                      <span class="capture-timeline-stat-key capture-timeline-stat-key-request">R</span>
                                      <span class="capture-timeline-stat-value">${laneRequestCount}</span>
                                    </span>
                                    <span class="capture-timeline-stat" title="responses">
                                      <span class="capture-timeline-stat-key capture-timeline-stat-key-response">S</span>
                                      <span class="capture-timeline-stat-value">${laneResponseCount}</span>
                                    </span>
                                    ${
                                      laneMovement == null || laneMovement === 0
                                        ? ""
                                        : `<span class="capture-chip capture-chip-movement capture-timeline-inline-chip ${
                                            laneMovement > 0 ? "up" : "down"
                                          }">${laneMovement > 0 ? `up ${laneMovement}` : `down ${Math.abs(laneMovement)}`}</span>`
                                    }
                                    ${
                                      state.captureTimelineLaneSort === "severity"
                                        ? `<span class="capture-chip capture-chip-severity capture-timeline-inline-chip">severity ${laneSeverity.score.toFixed(1)}</span>`
                                        : ""
                                    }
                                    ${
                                      focusSelectedFlow
                                        ? `<span class="capture-timeline-stat" title="focused flow events">
                                            <span class="capture-timeline-stat-key capture-timeline-stat-key-focus">F</span>
                                            <span class="capture-timeline-stat-value">${laneFocusedEventCount}</span>
                                          </span>`
                                        : ""
                                    }
                                    ${
                                      focusSelectedFlow && laneBackgroundEventCount > 0
                                        ? `<span class="capture-timeline-stat" title="background events">
                                            <span class="capture-timeline-stat-key capture-timeline-stat-key-background">B</span>
                                            <span class="capture-timeline-stat-value">${laneBackgroundEventCount}</span>
                                          </span>`
                                        : ""
                                    }
                                    ${
                                      laneErrorCount > 0
                                        ? `<span class="capture-timeline-stat capture-timeline-stat-danger" title="errors">
                                            <span class="capture-timeline-stat-key capture-timeline-stat-key-error">!</span>
                                            <span class="capture-timeline-stat-value">${laneErrorCount}</span>
                                          </span>`
                                        : ""
                                    }
                                  </div>
                                  ${
                                    laneSelected &&
                                    (state.captureTimelineLaneSort === "severity" ||
                                      laneMovement != null)
                                      ? `<div class="capture-timeline-lane-severity">${
                                          laneMovement == null || laneMovement === 0
                                            ? ""
                                            : `<span class="capture-timeline-lane-movement-copy">${
                                                laneMovement > 0
                                                  ? `Moved up ${laneMovement} from ${state.captureTimelinePreviousLaneSort}`
                                                  : `Moved down ${Math.abs(laneMovement)} from ${state.captureTimelinePreviousLaneSort}`
                                              }</span>${
                                                state.captureTimelineLaneSort === "severity"
                                                  ? " · "
                                                  : ""
                                              }`
                                        }${
                                          state.captureTimelineLaneSort === "severity"
                                            ? esc(laneSeverity.summary)
                                            : ""
                                        }</div>`
                                      : ""
                                  }
                                </div>
                                <div class="capture-timeline-viewport">
                                  <div class="capture-timeline-lane-track${laneIsCollapsed ? " collapsed" : ""}${laneSelected ? " selected" : ""}" style="height:${laneTrackHeightPx}px">
                                    ${renderTimelineWindow(activeWindowStartPct, activeWindowEndPct, "capture-timeline-window")}
                                    ${renderTimelineWindow(draftWindowStartPct, draftWindowEndPct, "capture-timeline-window capture-timeline-window-draft")}
                                    ${laneGuides}
                                    <div class="capture-timeline-track-line" style="top:${baselineTopPx}px"></div>
                                    ${flowLinks}
                                    ${quickPreview}
                                    ${laneIsCollapsed ? collapsedMarkers : markers}
                                  </div>
                                </div>
                              </div>`;
                                })
                                .join("")
                        }
                      </div>`
                        : groupedEvents
                            .map((group) => {
                              const groupMeta = [
                                `${group.events.length} event${group.events.length === 1 ? "" : "s"}`,
                                group.meta,
                              ]
                                .filter(Boolean)
                                .join(" · ");
                              const rows =
                                state.captureGroupMode === "burst"
                                  ? clusterEventBursts(group.events)
                                      .map((cluster) => {
                                        const event = cluster.representative;
                                        const key = cluster.key;
                                        const selected =
                                          selectedEvent != null &&
                                          key === captureEventKey(selectedEvent);
                                        const paired =
                                          pairedEventKey != null && key === pairedEventKey;
                                        const glyph = captureEventGlyph(event);
                                        return `
                                        <button class="capture-event-card capture-event-card-compact${selected ? " selected" : ""}${paired ? " paired" : ""}" data-capture-event="${esc(key)}" type="button">
                                          <div class="capture-event-card-rail">
                                            <span class="capture-glyph capture-glyph-${glyph.cls}">${esc(glyph.label)}</span>
                                          </div>
                                          <div class="capture-event-card-body">
                                            <div class="capture-event-card-header">
                                              <div class="capture-event-card-title-row">
                                                <strong>${esc(event.host || event.provider || event.kind)}</strong>
                                                <span class="text-dimmed text-sm">${esc(
                                                  [event.method, event.path]
                                                    .filter(Boolean)
                                                    .join(" ") || event.kind,
                                                )}</span>
                                              </div>
                                              <div class="capture-event-card-meta-row">
                                                <span class="text-dimmed text-sm">${cluster.count} events</span>
                                                <span class="text-dimmed text-sm">${esc(formatTime(cluster.startTs))} → ${esc(formatTime(cluster.endTs))}</span>
                                                ${event.status ? `<span class="text-dimmed text-sm">status ${event.status}</span>` : ""}
                                              </div>
                                            </div>
                                            ${
                                              event.provider || event.model
                                                ? `<div class="text-dimmed text-sm">${esc(
                                                    [event.provider, event.model]
                                                      .filter(Boolean)
                                                      .join(" · "),
                                                  )}</div>`
                                                : ""
                                            }
                                            ${paired ? '<div class="capture-pair-badge">paired counterpart</div>' : ""}
                                            ${
                                              event.payloadPreview
                                                ? `<div class="capture-event-card-preview">${esc(event.payloadPreview)}</div>`
                                                : ""
                                            }
                                          </div>
                                        </button>`;
                                      })
                                      .join("")
                                  : group.events
                                      .map((event: CaptureEventView) => {
                                        const key = captureEventKey(event);
                                        const selected =
                                          selectedEvent != null &&
                                          key === captureEventKey(selectedEvent);
                                        const paired =
                                          pairedEventKey != null && key === pairedEventKey;
                                        const glyph = captureEventGlyph(event);
                                        return `
                                  <button class="capture-event-card capture-event-card-compact${selected ? " selected" : ""}${paired ? " paired" : ""}" data-capture-event="${esc(key)}" type="button">
                                    <div class="capture-event-card-rail">
                                      <span class="capture-glyph capture-glyph-${glyph.cls}">${esc(glyph.label)}</span>
                                    </div>
                                    <div class="capture-event-card-body">
                                      <div class="capture-event-card-header">
                                        <div class="capture-event-card-title-row">
                                          <strong>${esc(event.host || event.provider || event.kind)}</strong>
                                          <span class="text-dimmed text-sm">${esc(
                                            [event.method, event.path].filter(Boolean).join(" ") ||
                                              event.kind,
                                          )}</span>
                                        </div>
                                        <div class="capture-event-card-meta-row">
                                          <span class="text-dimmed text-sm">${esc(new Date(event.ts).toLocaleTimeString())}</span>
                                          ${event.status ? `<span class="text-dimmed text-sm">status ${event.status}</span>` : ""}
                                          ${event.closeCode ? `<span class="text-dimmed text-sm">close ${event.closeCode}</span>` : ""}
                                          <span class="text-dimmed text-sm">${esc(event.direction)} · ${esc(event.protocol)}</span>
                                        </div>
                                      </div>
                                    ${paired ? '<div class="capture-pair-badge">paired counterpart</div>' : ""}
                                    ${
                                      event.provider || event.api || event.captureOrigin
                                        ? `<div class="text-dimmed text-sm">${esc(
                                            [event.provider, event.api, event.captureOrigin]
                                              .filter(Boolean)
                                              .join(" · "),
                                          )}</div>`
                                        : ""
                                    }
                                    ${
                                      event.payloadPreview
                                        ? `<div class="capture-event-card-preview">${esc(event.payloadPreview)}</div>`
                                        : ""
                                    }
                                    ${event.errorText ? `<div class="capture-error" style="margin-top:8px">${esc(event.errorText)}</div>` : ""}
                                    </div>
                                  </button>`;
                                      })
                                      .join("");
                              return state.captureGroupMode === "none"
                                ? rows
                                : `<section class="capture-group">
                                  <div class="capture-group-header">
                                    <div class="capture-group-title">${esc(group.label)}</div>
                                    <div class="capture-group-meta">${esc(groupMeta)}</div>
                                  </div>
                                  ${rows}
                                </section>`;
                            })
                            .join("")
                }
              </div>
            </section>
            ${
              state.captureDetailPlacement === "right"
                ? `<div class="capture-detail-splitter${state.captureDetailSplitDragging ? " dragging" : ""}" data-capture-detail-splitter role="separator" aria-orientation="vertical" aria-label="Resize detail pane">
                    <span class="capture-detail-splitter-label">${Math.round(state.captureDetailSplitPct)}%</span>
                  </div>`
                : ""
            }
            <aside class="capture-detail-pane">
              <div class="inspector-section-title">Selected Event</div>
              ${
                selectedEvent == null
                  ? '<div class="empty-state">Select an event to inspect its details.</div>'
                  : `
                  <div class="capture-detail-card">
                    <div class="capture-detail-view-switch" role="radiogroup" aria-label="Detail view">
                      ${availableDetailViews
                        .filter((view) => view.available)
                        .map(
                          (view) => `<label class="capture-detail-view-option">
                            <input type="radio" name="capture-detail-view" value="${view.value}"${
                              effectiveDetailView === view.value ? " checked" : ""
                            } />
                            <span>${view.label}${view.recommended ? ' <em class="capture-detail-view-hint">recommended</em>' : ""}</span>
                          </label>`,
                        )
                        .join("")}
                    </div>
                    <div class="capture-detail-meta">
                      <span class="capture-chip">${esc(selectedEvent.kind)}</span>
                      <span class="capture-chip">${esc(selectedEvent.direction)}</span>
                      <span class="capture-chip">${esc(selectedEvent.protocol)}</span>
                      ${selectedEvent.provider ? `<span class="capture-chip">${esc(selectedEvent.provider)}</span>` : ""}
                      ${selectedEvent.api ? `<span class="capture-chip">${esc(selectedEvent.api)}</span>` : ""}
                      ${selectedEvent.model ? `<span class="capture-chip">${esc(selectedEvent.model)}</span>` : ""}
                      ${selectedEvent.status ? `<span class="capture-chip">status ${selectedEvent.status}</span>` : ""}
                      ${selectedEvent.closeCode ? `<span class="capture-chip">close ${selectedEvent.closeCode}</span>` : ""}
                    </div>
                    <div class="capture-detail-view-body">
                      ${renderDetailView()}
                    </div>
                  </div>`
              }
            </aside>
          </div>
        </div>
        <div class="results-sidebar"${analysisEnabled ? "" : ' style="display:none"'}>
          <div class="inspector-section-title">Analysis Results</div>
          <div class="text-dimmed text-sm" style="margin-bottom:10px">
            ${
              analysisEnabled
                ? `Preset: ${esc(state.captureQueryPreset)}`
                : "Analysis disabled. Select a preset to group the raw events."
            }
          </div>
          <div class="events-scroll" style="max-height: 520px">
            ${
              rows.length === 0
                ? '<div class="empty-state" style="padding:20px">This session has raw traffic, but nothing matched the selected analysis preset.</div>'
                : rows
                    .map(
                      (row) =>
                        `<pre class="report-pre" style="margin:0 0 10px 0">${esc(JSON.stringify(row, null, 2))}</pre>`,
                    )
                    .join("")
            }
          </div>
        </div>
      </div>
    </div>`;
}

/* ===== Render: Active tab switch ===== */

function renderActiveTab(state: UiState): string {
  switch (state.activeTab) {
    case "chat":
      return renderChatView(state);
    case "results":
      return renderResultsView(state);
    case "report":
      return renderReportView(state);
    case "events":
      return renderEventsView(state);
    case "capture":
      return renderCaptureView(state);
    default:
      return renderChatView(state);
  }
}

/* ===== Main render ===== */

export function renderQaLabUi(state: UiState): string {
  return `
    <div class="app-shell${state.sidebarCollapsed ? " app-shell--sidebar-collapsed" : ""}" data-theme="${state.theme}">
      ${renderHeader(state)}
      <div class="layout">
        ${renderSidebar(state)}
        <main class="main-content">
          ${renderTabBar(state)}
          <div class="tab-content">
            ${renderActiveTab(state)}
          </div>
        </main>
      </div>
    </div>`;
}
