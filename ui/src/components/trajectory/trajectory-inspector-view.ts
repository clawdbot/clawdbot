import type { TrajectoryRecord } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { formatTrajectoryDuration } from "./trajectory-presentation.ts";

function finiteMetric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageMetric(usage: unknown, keys: readonly string[]): number {
  if (!isRecord(usage)) {
    return 0;
  }
  for (const key of keys) {
    const value = finiteMetric(usage[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return 0;
}

function cumulativeUsage(records: readonly TrajectoryRecord[], selectedId: string) {
  const selectedIndex = records.findIndex((record) => record.id === selectedId);
  const window = selectedIndex < 0 ? records : records.slice(0, selectedIndex + 1);
  return window.reduce(
    (total, record) => ({
      input: total.input + usageMetric(record.usage, ["input", "inputTokens"]),
      cacheRead: total.cacheRead + usageMetric(record.usage, ["cacheRead", "cachedInput"]),
      cacheWrite: total.cacheWrite + usageMetric(record.usage, ["cacheWrite", "cacheCreated"]),
      output: total.output + usageMetric(record.usage, ["output", "outputTokens"]),
      reasoning: total.reasoning + usageMetric(record.usage, ["reasoning", "reasoningTokens"]),
    }),
    { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
  );
}

function detailData(detail: unknown): Record<string, unknown> | undefined {
  if (!isRecord(detail)) {
    return undefined;
  }
  return isRecord(detail.data) ? detail.data : detail;
}

function renderJson(value: unknown) {
  return html`<pre>${JSON.stringify(value ?? { unavailable: true }, null, 2)}</pre>`;
}

export function renderTrajectoryDetailTab(params: {
  record: TrajectoryRecord;
  tab: string;
  detail: unknown;
  records: readonly TrajectoryRecord[];
}) {
  const { record, tab } = params;
  const data = detailData(params.detail);
  if (tab === "Summary") {
    return html`<dl class="trajectory-summary">
      <div>
        <dt>Status</dt>
        <dd>${record.status}</dd>
      </div>
      ${record.provider
        ? html`<div>
            <dt>Provider</dt>
            <dd>${record.provider}</dd>
          </div>`
        : nothing}
      ${record.model
        ? html`<div>
            <dt>Model</dt>
            <dd>${record.model}</dd>
          </div>`
        : nothing}
      ${record.requestId
        ? html`<div>
            <dt>Request</dt>
            <dd>${record.requestId}</dd>
          </div>`
        : nothing}
      ${record.parentId
        ? html`<div>
            <dt>Parent</dt>
            <dd>${record.parentId}</dd>
          </div>`
        : nothing}
      <div>
        <dt>Started</dt>
        <dd>${new Date(record.timestamp).toLocaleString()}</dd>
      </div>
      <div>
        <dt>Duration</dt>
        <dd>${formatTrajectoryDuration(record.durationMs)}</dd>
      </div>
      <div class="trajectory-summary__preview">
        <dt>Preview</dt>
        <dd>${record.preview || "Unavailable"}</dd>
      </div>
    </dl>`;
  }
  if (tab === "Timing") {
    const timing = isRecord(record.timing) ? record.timing : {};
    const ttft = finiteMetric(timing.timeToFirstByteMs ?? timing.ttftMs);
    const generation =
      record.durationMs !== undefined && ttft !== undefined
        ? Math.max(0, record.durationMs - ttft)
        : undefined;
    const output = usageMetric(record.usage, ["output", "outputTokens"]);
    const throughput = generation && output ? output / (generation / 1000) : undefined;
    return html`<dl class="trajectory-summary">
      <div>
        <dt>Started</dt>
        <dd>${new Date(record.timestamp).toLocaleString()}</dd>
      </div>
      <div>
        <dt>Total duration</dt>
        <dd>${formatTrajectoryDuration(record.durationMs)}</dd>
      </div>
      <div>
        <dt>TTFT</dt>
        <dd>${formatTrajectoryDuration(ttft)}</dd>
      </div>
      <div>
        <dt>Decoding</dt>
        <dd>${formatTrajectoryDuration(generation)}</dd>
      </div>
      <div>
        <dt>Throughput</dt>
        <dd>${throughput ? `${throughput.toFixed(1)} tok/s` : "—"}</dd>
      </div>
    </dl>`;
  }
  if (tab === "Usage") {
    return html`<h4>This request</h4>
      ${renderJson(record.usage)}
      <h4>Session cumulative (loaded window)</h4>
      ${renderJson(cumulativeUsage(params.records, record.id))}`;
  }
  if (tab === "System Prompt") {
    return html`<pre>
${typeof data?.systemPrompt === "string"
        ? data.systemPrompt
        : "System prompt was not recorded."}</pre>`;
  }
  if (tab === "Tools") {
    return renderJson(data?.tools ?? { unavailable: "Tool catalog was not recorded." });
  }
  if (tab === "Payload" || tab === "Options") {
    return renderJson(data?.arguments ?? data?.options ?? data);
  }
  if (tab === "Result" || tab === "Raw Output") {
    return renderJson(data?.result ?? data?.message ?? data);
  }
  if (tab === "Schema") {
    return data?.schema !== undefined
      ? renderJson(data.schema)
      : html`<p>Tool schema was not recorded for this call.</p>`;
  }
  return renderJson(params.detail);
}
