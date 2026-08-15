import {
  formatCaptureFieldValue,
  isSensitiveCaptureField,
  redactCaptureInlineSecretPairs,
  redactCapturePayloadPreview,
  redactCaptureScalar,
  redactCaptureValue,
} from "./ui-render-capture-redaction.js";
import { esc, parseJsonObject } from "./ui-render-utils.js";
import type { CaptureStartupProbeStatus, CaptureStartupStatus, UiState } from "./ui-types.js";

export function renderCaptureKeyValueGrid(rows: Array<{ label: string; value: string }>): string {
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

export function renderCaptureHeaders(
  raw: string | undefined,
  mode: UiState["captureHeaderMode"],
): string {
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

function renderCaptureFormPayload(payload: string): string {
  const params = new URLSearchParams(payload.trim());
  const rows = Array.from(params.entries()).map(([label, value]) => ({
    label,
    value: redactCaptureScalar(value, label),
  }));
  return rows.length > 0
    ? renderCaptureKeyValueGrid(rows)
    : `<pre class="report-pre capture-pre">${esc(redactCapturePayloadPreview(payload))}</pre>`;
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
          return {
            label,
            value: redactCaptureScalar(redactCaptureInlineSecretPairs(value), label),
          };
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
      body: `<pre class="report-pre capture-pre">${esc(redactCapturePayloadPreview(payload))}</pre>`,
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

export function renderCapturePayload(
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
    body: `<pre class="report-pre capture-pre">${esc(redactCapturePayloadPreview(payload))}</pre>`,
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

export function renderCaptureStartupInstructions(status: CaptureStartupStatus | null): string {
  const proxyStart = "pnpm proxy:start --port 7799";
  const gatewayStart = `OPENCLAW_DEBUG_PROXY_ENABLED=1 \\
OPENCLAW_DEBUG_PROXY_REQUIRE=1 \\
OPENCLAW_DEBUG_PROXY_URL=http://127.0.0.1:7799 \\
pnpm openclaw gateway --port 18789 --bind loopback`;
  const qaStart = "pnpm qa:lab:ui --port 43124 --control-ui-url http://127.0.0.1:18789/";
  const caInstall = "pnpm proxy:install-ca";
  const caTrust =
    'sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$HOME/.openclaw/debug-proxy/certs/root-ca.pem"';
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
