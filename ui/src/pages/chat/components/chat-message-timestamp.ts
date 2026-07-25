import { html } from "lit";
import { t } from "../../../i18n/index.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import {
  formatCompactTokenCount,
  formatTimeAgo,
  resolveUiHourCycleOptions,
} from "../../../lib/format.ts";

type ChatTimestampDisplay = {
  label: string;
  title: string;
  dateTime: string;
};

function formatChatTimestampForDisplay(timestamp: number): ChatTimestampDisplay {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return {
      label: t("chat.messages.unknownDate"),
      title: t("chat.messages.unknownDate"),
      dateTime: "",
    };
  }

  const hourCycle = resolveUiHourCycleOptions();
  return {
    label: date.toLocaleString([], {
      ...hourCycle,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }),
    title: date.toLocaleString([], {
      ...hourCycle,
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    }),
    dateTime: date.toISOString(),
  };
}

const CHAT_RELATIVE_TIMESTAMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CHAT_RELATIVE_TIMESTAMP_FUTURE_SKEW_MS = 2 * 60 * 1000;

/** Footer label: relative for recent messages, compact date beyond a week. */
function formatChatRelativeTimestampLabel(timestamp: number, nowMs = Date.now()): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return t("chat.messages.unknownDate");
  }
  const ageMs = nowMs - date.getTime();
  // Derive from ageMs so the injected clock stays the single time source.
  // Slightly-future (clock-skewed) messages clamp to "just now"; anything
  // further out falls through to the compact date instead of lying forever.
  if (
    ageMs >= -CHAT_RELATIVE_TIMESTAMP_FUTURE_SKEW_MS &&
    ageMs < CHAT_RELATIVE_TIMESTAMP_MAX_AGE_MS
  ) {
    return formatTimeAgo(Math.max(0, ageMs));
  }
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(nowMs).getFullYear() ? {} : { year: "numeric" }),
  });
}

// Footer times read relative ("5m ago"); the absolute timestamp lives in the
// tooltip, or in the msg-meta popover when usage metadata makes the
// timestamp interactive (a nested tooltip would fight the popover).
export function renderChatTimestamp(timestamp: number, interactive = false) {
  const display = formatChatTimestampForDisplay(timestamp);
  const timeEl = html`
    <time class="chat-group-timestamp" datetime=${display.dateTime} aria-live="off">
      ${formatChatRelativeTimestampLabel(timestamp)}
    </time>
  `;
  if (interactive) {
    return timeEl;
  }
  return html`<openclaw-tooltip content=${display.label}>${timeEl}</openclaw-tooltip>`;
}

function resolveMessageMetaDetails(target: EventTarget | null): HTMLDetailsElement | null {
  if (target instanceof HTMLDetailsElement) {
    return target;
  }
  return target instanceof HTMLElement
    ? target.closest<HTMLDetailsElement>("details.msg-meta")
    : null;
}

function previewMessageMeta(event: PointerEvent | FocusEvent) {
  const details = resolveMessageMetaDetails(event.currentTarget);
  if (!details || details.open || ("pointerType" in event && event.pointerType === "touch")) {
    return;
  }
  details.dataset.preview = "true";
  details.open = true;
}

function closeMessageMetaPreview(event: PointerEvent | FocusEvent) {
  const details = resolveMessageMetaDetails(event.currentTarget);
  if (!details || details.dataset.preview !== "true" || details.matches(":hover, :focus-within")) {
    return;
  }
  delete details.dataset.preview;
  details.open = false;
}

function pinMessageMetaPreview(event: MouseEvent) {
  const details = resolveMessageMetaDetails(event.currentTarget);
  if (details?.dataset.preview !== "true") {
    return;
  }
  event.preventDefault();
  delete details.dataset.preview;
}

type GroupMeta = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  model: string | null;
  contextPercent: number | null;
};

export function extractGroupMeta(
  group: MessageGroup,
  contextWindow: number | null,
): GroupMeta | null {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let model: string | null = null;
  let hasUsage = false;
  let maxPromptTokens = 0;

  for (const { message } of group.messages) {
    const m = message as Record<string, unknown>;
    if (m.role !== "assistant") {
      continue;
    }
    const usage = m.usage as Record<string, number> | undefined;
    if (usage) {
      hasUsage = true;
      const callInput = usage.input ?? usage.inputTokens ?? 0;
      const callOutput = usage.output ?? usage.outputTokens ?? 0;
      const callCacheRead = usage.cacheRead ?? usage.cache_read_input_tokens ?? 0;
      const callCacheWrite = usage.cacheWrite ?? usage.cache_creation_input_tokens ?? 0;
      input += callInput;
      output += callOutput;
      cacheRead += callCacheRead;
      cacheWrite += callCacheWrite;
      maxPromptTokens = Math.max(maxPromptTokens, callInput + callCacheRead + callCacheWrite);
    }
    const c = m.cost as Record<string, number> | undefined;
    if (c?.total) {
      cost += c.total;
    }
    if (typeof m.model === "string" && m.model !== "gateway-injected") {
      model = m.model;
    }
  }

  if (!hasUsage && !model) {
    return null;
  }

  const contextPercent =
    contextWindow && maxPromptTokens > 0
      ? Math.min(Math.round((maxPromptTokens / contextWindow) * 100), 100)
      : null;

  return { input, output, cacheRead, cacheWrite, cost, model, contextPercent };
}

export function renderMessageMeta(timestamp: number, meta: GroupMeta | null) {
  if (!meta) {
    return renderChatTimestamp(timestamp);
  }

  const parts: Array<ReturnType<typeof html>> = [];

  // Token counts: ↑input ↓output
  if (meta.input) {
    parts.push(html`<span class="msg-meta__tokens">↑${formatCompactTokenCount(meta.input)}</span>`);
  }
  if (meta.output) {
    parts.push(
      html`<span class="msg-meta__tokens">↓${formatCompactTokenCount(meta.output)}</span>`,
    );
  }

  // Cache: R/W
  if (meta.cacheRead) {
    parts.push(
      html`<span class="msg-meta__cache">R${formatCompactTokenCount(meta.cacheRead)}</span>`,
    );
  }
  if (meta.cacheWrite) {
    parts.push(
      html`<span class="msg-meta__cache">W${formatCompactTokenCount(meta.cacheWrite)}</span>`,
    );
  }

  // Cost
  if (meta.cost > 0) {
    parts.push(html`<span class="msg-meta__cost">$${meta.cost.toFixed(4)}</span>`);
  }

  // Context %
  if (meta.contextPercent !== null) {
    const pct = meta.contextPercent;
    const cls =
      pct >= 90
        ? "msg-meta__ctx msg-meta__ctx--danger"
        : pct >= 75
          ? "msg-meta__ctx msg-meta__ctx--warn"
          : "msg-meta__ctx";
    parts.push(html`<span class="${cls}">${pct}% ctx</span>`);
  }

  // Model
  if (meta.model) {
    // Shorten model name: strip provider prefix if present (e.g. "anthropic/claude-3.5-sonnet" → "claude-3.5-sonnet")
    const shortModel = meta.model.includes("/") ? meta.model.split("/").pop()! : meta.model;
    parts.push(html`<span class="msg-meta__model">${shortModel}</span>`);
  }

  if (parts.length === 0) {
    return renderChatTimestamp(timestamp);
  }

  const display = formatChatTimestampForDisplay(timestamp);
  // Absolute time leads the popover; the summary label itself stays relative.
  parts.unshift(html`<span class="msg-meta__time">${display.label}</span>`);

  return html`
    <details
      class="msg-meta"
      @pointerenter=${previewMessageMeta}
      @pointerleave=${closeMessageMetaPreview}
      @focusin=${previewMessageMeta}
      @focusout=${closeMessageMetaPreview}
    >
      <summary
        class="msg-meta__summary"
        aria-label=${`Message context for ${display.title}`}
        @click=${pinMessageMetaPreview}
      >
        ${renderChatTimestamp(timestamp, true)}
      </summary>
      <span class="msg-meta__details">${parts}</span>
    </details>
  `;
}
