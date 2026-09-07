import type {
  TranscriptSessionSummary,
  TranscriptsExportParams,
  TranscriptsGetResult,
  TranscriptsListResult,
} from "@openclaw/gateway-protocol";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { pathForRoute } from "../../app-route-paths.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { icons } from "../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { t } from "../../i18n/index.ts";
import { registerMeetingsEnglish } from "../../i18n/locales/en-meetings.ts";
import { registerTranscriptsEnglish } from "../../i18n/locales/en-transcripts.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatDurationCompact } from "../../lib/format.ts";
import { isArchiveAccessDeniedError } from "../../lib/gateway-errors.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { SETTINGS_SEARCH_TARGETS } from "../config/settings-targets.ts";
import {
  transcriptRouteSearch,
  TRANSCRIPT_QUERY_LIMIT,
  TRANSCRIPT_ADVANCED_FILTER_KEYS,
  TRANSCRIPT_FILTER_KEYS,
} from "./route-state.ts";

registerTranscriptsEnglish();
registerMeetingsEnglish();

export type TranscriptReadState = {
  summary: TranscriptsGetResult | null;
  pages: TranscriptsGetResult[];
  loading: boolean;
  error: unknown;
  trimmed: boolean;
};

type TranscriptsViewProps = {
  basePath: string;
  search: string;
  drafts: Readonly<Record<string, string>>;
  onDraft: (key: string, value: string) => void;
  connected: boolean;
  allowed: boolean;
  list: TranscriptsListResult | null;
  listLoading: boolean;
  listError: unknown;
  reader: TranscriptReadState;
  readerTab: "text" | "summary";
  exportState: { kind: "idle" | "loading" | "done" | "error"; message?: string };
  onNavigate: (patch: Record<string, string | null>) => void;
  onRefresh: () => void;
  onReaderRetry: () => void;
  onReaderTab: (tab: "text" | "summary") => void;
  onLoadMore: () => void;
  onReaderStart: () => void;
  onDownload: (format: TranscriptsExportParams["format"]) => void;
};

function transcriptTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : t("transcripts.unknown");
}

function renderSourceTime(value: string | undefined) {
  const label = t("transcripts.sourceTime", { time: transcriptTime(value) });
  return html`<time datetime=${value ?? nothing} title=${label} aria-label=${label}
    >${value ? new Date(value).toLocaleTimeString() : t("transcripts.unknown")}</time
  >`;
}

function transcriptSourceLabel(source: TranscriptSessionSummary["source"]) {
  return [
    source.providerId,
    source.accountId,
    source.guildId,
    source.channelId,
    source.meetingUrl,
    source.threadTs,
    source.fileId,
  ]
    .filter(Boolean)
    .join(" · ");
}

function renderReadError(error: unknown, retry: () => void) {
  const forbidden = isArchiveAccessDeniedError(error);
  return html`<div class="transcripts-notice" role="alert" tabindex="-1">
    <h2>${t(forbidden ? "transcripts.forbidden" : "transcripts.loadError")}</h2>
    <p>${forbidden ? t("transcripts.forbiddenHint") : formatUiError(error)}</p>
    <button class="btn" @click=${retry}>${t("common.retry")}</button>
  </div>`;
}

function renderFilters(props: TranscriptsViewProps) {
  const params = new URLSearchParams(props.search);
  const advancedActive = TRANSCRIPT_ADVANCED_FILTER_KEYS.some((key) => params.get(key));
  const field = (key: string, label: string, type = "search") => html`<label class="field">
    <span>${label}</span
    ><input
      name=${key}
      type=${type}
      aria-label=${label}
      maxlength=${TRANSCRIPT_QUERY_LIMIT}
      .value=${live(props.drafts[key] ?? "")}
      @input=${(event: Event) =>
        // SAFETY: This native input emits the input event handled by its own binding.
        props.onDraft(key, (event.target as HTMLInputElement).value)}
    />
  </label>`;
  return html`<form
    class="transcripts-filters"
    aria-label=${t("transcripts.filters")}
    @submit=${(event: SubmitEvent) => {
      event.preventDefault();
      // SAFETY: This synchronous submit handler is bound directly to the native form above.
      const data = new FormData(event.currentTarget as HTMLFormElement);
      const patch: Record<string, string | null> = { cursor: null };
      for (const key of TRANSCRIPT_FILTER_KEYS) {
        patch[key] = normalizeNullableString(data.get(key));
      }
      props.onNavigate(patch);
    }}
  >
    ${field("query", t("transcripts.titleFilter"))}
    <details ?open=${advancedActive}>
      <summary>${t("transcripts.advancedFilters")}</summary>
      <div class="transcripts-filters__advanced">
        ${field("providerId", t("transcripts.sourceFilter"))}
        ${field("accountId", t("transcripts.accountFilter"))}
        ${field("agentId", t("transcripts.agentFilter"))}
        ${field("startedAfter", t("transcripts.afterFilter"), "date")}
        ${field("startedBefore", t("transcripts.beforeFilter"), "date")}
      </div>
      <p class="transcripts-caption">${t("transcripts.filterHint")}</p>
    </details>
    <div class="transcripts-actions">
      <button type="submit" class="btn">${icons.search}${t("transcripts.filter")}</button>
      <button
        type="button"
        class="btn"
        @click=${() =>
          props.onNavigate(
            Object.fromEntries([...TRANSCRIPT_FILTER_KEYS, "cursor"].map((key) => [key, null])),
          )}
      >
        ${t("transcripts.clearFilters")}
      </button>
    </div>
  </form>`;
}

function renderMeetingRow(entry: TranscriptSessionSummary, props: TranscriptsViewProps) {
  const selected = new URLSearchParams(props.search).get("selector");
  const silent = entry.utteranceCount === 0;
  const participants = entry.participants.slice(0, 3).join(", ");
  const extra = entry.participants.length - 3;
  const duration = entry.stoppedAt
    ? formatDurationCompact(Math.max(0, Date.parse(entry.stoppedAt) - Date.parse(entry.startedAt)))
    : null;
  const selection = { selector: entry.selector, find: null, tab: null };
  return html`<li>
    <a
      class="transcripts-list__entry meetings-row ${silent ? "meetings-row--silent" : ""}"
      aria-current=${entry.selector === selected ? "page" : nothing}
      href=${pathForRoute("meetings", props.basePath) + transcriptRouteSearch(props.search, selection)}
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        props.onNavigate(selection);
      }}
    >
      <span class="meetings-row__title"
        >${entry.title || entry.providerName || entry.providerId}</span
      >
      <span class="meetings-row__meta">
        ${entry.providerName || entry.providerId} ·
        <time datetime=${entry.startedAt}
          >${new Date(entry.startedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time
        >
        ${entry.active ? html`<span class="meetings-live">${t("meetings.inProgress")}</span>` : duration ? html` · ${duration}` : nothing}
      </span>
      ${participants ? html`<span class="meetings-row__meta meetings-row__participants">${participants}${extra > 0 ? ` +${extra}` : ""}</span>` : nothing}
      <span class="meetings-row__meta"
        >${t("transcripts.savedCount", { count: String(entry.utteranceCount) })}</span
      >
      ${silent || entry.overview ? html`<span class="meetings-row__overview">${silent ? t("meetings.noSpeech") : entry.overview}</span>` : nothing}
    </a>
  </li>`;
}

function renderLibrary(props: TranscriptsViewProps) {
  if (props.listError) {
    return renderReadError(props.listError, props.onRefresh);
  }
  if (props.listLoading || !props.list) {
    return html`<p role="status" class="transcripts-notice">${t("common.loading")}</p>`;
  }
  const days = new Map<string, TranscriptSessionSummary[]>();
  for (const entry of props.list.sessions) {
    const day = new Date(entry.startedAt).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const entries = days.get(day) ?? [];
    entries.push(entry);
    days.set(day, entries);
  }
  return html` ${
      days.size
        ? html`<div aria-label=${t("meetings.listLabel")}>
            ${repeat(
              days,
              ([day]) => day,
              ([day, entries]) => html`<section class="meetings-day">
                <h2>${day}</h2>
                <ol class="transcripts-list">
                  ${repeat(
                    entries,
                    (entry) => entry.selector,
                    (entry) => renderMeetingRow(entry, props),
                  )}
                </ol>
              </section>`,
            )}
          </div>`
        : html`<div class="transcripts-notice" role="status">
            <h2>${t("meetings.emptyTitle")}</h2>
            <p>${t("transcripts.emptyHint")}</p>
            <a
              href="https://docs.openclaw.ai/cli/transcripts"
              target="_blank"
              rel="noopener noreferrer"
              >${t("meetings.docs")}</a
            >
          </div>`
    }
    <nav class="transcripts-actions" aria-label=${t("transcripts.pagination")}>
      ${
        new URLSearchParams(props.search).has("cursor")
          ? html`<button class="btn" @click=${() => props.onNavigate({ cursor: null })}>
              ${t("transcripts.firstPage")}
            </button>`
          : nothing
      }
      ${
        props.list.nextCursor
          ? html`<button
              class="btn"
              @click=${() => props.onNavigate({ cursor: props.list?.nextCursor ?? null })}
            >
              ${t("transcripts.nextPage")}${icons.chevronRight}
            </button>`
          : nothing
      }
    </nav>`;
}

function renderSummary(page: TranscriptsGetResult) {
  const summary = page.summary;
  const titleLine = `# ${page.session.title || page.session.sessionId}\n`;
  // The reader header already renders the stored summary's leading title.
  const markdown = summary
    ? summary.markdown.startsWith(titleLine)
      ? summary.markdown.slice(titleLine.length)
      : summary.markdown
    : "";
  return html`<section class="transcripts-summary">
    ${
      summary
        ? html`<p class="transcripts-caption">
              ${summary.source ? html`${t(summary.source === "model" ? "transcripts.modelNotes" : "transcripts.heuristicNotes")}${summary.model ? ` · ${summary.model}` : nothing} · ` : nothing}
              ${t("transcripts.generatedAt", { time: transcriptTime(summary.generatedAt) })}
            </p>
            <div class="meetings-notes markdown">
              ${unsafeHTML(toSanitizedMarkdownHtml(markdown))}
            </div>
            <p class="transcripts-caption">${t("transcripts.summaryHint")}</p>`
        : html`<p role="status">${t("transcripts.noSummary")}</p>
            ${page.session.active ? html`<p>${t("meetings.activeNotes")}</p>` : nothing}`
    }
  </section>`;
}

function renderReader(props: TranscriptsViewProps) {
  const params = new URLSearchParams(props.search);
  const selected = params.get("selector");
  if (!selected) {
    return html`<div class="transcripts-notice transcripts-reader__placeholder">
      <h2>${t("transcripts.choose")}</h2>
      <p>${t("transcripts.chooseHint")}</p>
    </div>`;
  }
  const transcriptPage = props.reader.pages.at(-1);
  const page = transcriptPage ?? props.reader.summary;
  return html`<article
    class="transcripts-reader"
    aria-label=${t("transcripts.reader")}
    aria-busy=${props.reader.loading}
  >
    <a
      class="transcripts-back"
      href=${
        pathForRoute("meetings", props.basePath) +
        transcriptRouteSearch(props.search, { selector: null, find: null, tab: null })
      }
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        props.onNavigate({ selector: null, find: null, tab: null });
      }}
      >${icons.arrowLeft}${t("transcripts.back")}</a
    >
    ${props.reader.error ? renderReadError(props.reader.error, props.onReaderRetry) : nothing}
    ${
      page
        ? html`
            <header class="transcripts-reader__header">
              <h1 tabindex="-1">${page.session.title || page.session.sessionId}</h1>
              <p class="transcripts-caption">
                ${page.session.providerName || page.session.providerId} ·
                <time datetime=${page.session.startedAt}
                  >${transcriptTime(page.session.startedAt)}</time
                >
                · ${t("transcripts.savedCount", { count: String(page.session.utteranceCount) })}
                ${page.session.active ? html`<span class="meetings-live">${t("meetings.inProgress")}</span>` : nothing}
              </p>
              <details class="transcripts-source-details">
                <summary>${t("transcripts.sourceDetails")}</summary>
                <p class="transcripts-caption">${transcriptSourceLabel(page.session.source)}</p>
                <p class="transcripts-caption">
                  ${page.session.agentId ?? t("transcripts.unattributed")}
                </p>
                <p class="transcripts-caption">
                  ${t("transcripts.lastUtterance", { time: transcriptTime(page.session.lastUtteranceAt) })}
                </p>
                <p class="transcripts-caption">
                  ${t(page.session.activeSubscription ? "transcripts.armedHint" : "transcripts.inactiveHint")}
                </p>
              </details>
              <div class="transcripts-actions">
                ${(["markdown", "jsonl"] as const).map(
                  (format) =>
                    html`<button
                      class="btn"
                      ?disabled=${props.exportState.kind === "loading"}
                      @click=${() => props.onDownload(format)}
                    >
                      ${icons.download}${t(`transcripts.download.${format}`)}
                    </button>`,
                )}
              </div>
              ${
                props.exportState.kind === "error"
                  ? html`<p role="alert">
                      ${t("transcripts.exportError")} ${props.exportState.message}
                    </p>`
                  : nothing
              }
              ${
                props.exportState.kind === "loading" || props.exportState.kind === "done"
                  ? html`<p role="status">
                      ${t(
                        props.exportState.kind === "loading"
                          ? "transcripts.exporting"
                          : "transcripts.downloadStarted",
                      )}
                    </p>`
                  : nothing
              }
            </header>
            ${renderHubTabs({
              id: "transcript-reader",
              active: props.readerTab,
              tabs: [
                { value: "summary", label: t("transcripts.summary") },
                { value: "text", label: t("transcripts.text") },
              ],
              ariaLabel: t("transcripts.reader"),
              panelId: "transcript-reader-panel",
              variant: "sub",
              onSelect: props.onReaderTab,
            })}
            <div
              id="transcript-reader-panel"
              role="tabpanel"
              aria-labelledby=${`transcript-reader-tab-${props.readerTab}`}
            >
              ${
                props.readerTab === "summary"
                  ? props.reader.summary
                    ? renderSummary(props.reader.summary)
                    : nothing
                  : html`
                      <form
                        class="transcripts-search"
                        role="search"
                        @submit=${(event: SubmitEvent) => {
                          event.preventDefault();
                          const query = normalizeNullableString(
                            // SAFETY: This synchronous submit handler is bound to the native search form.
                            new FormData(event.currentTarget as HTMLFormElement).get("find"),
                          );
                          props.onNavigate({ find: query, tab: "transcript" });
                        }}
                      >
                        <label class="field">
                          <input
                            type="search"
                            name="find"
                            aria-label=${t("transcripts.searchWithin")}
                            placeholder=${t("transcripts.searchWithin")}
                            maxlength=${TRANSCRIPT_QUERY_LIMIT}
                            .value=${live(props.drafts.find ?? "")}
                            @input=${(event: Event) =>
                              // SAFETY: This native input emits the input event handled by its own binding.
                              props.onDraft("find", (event.target as HTMLInputElement).value)}
                          />
                        </label>
                        <button class="btn" type="submit">
                          ${icons.search}${t("transcripts.search")}
                        </button>
                        ${
                          params.get("find")
                            ? html`<button
                                class="btn"
                                type="button"
                                @click=${() => props.onNavigate({ find: null })}
                              >
                                ${t("transcripts.clearSearch")}
                              </button>`
                            : nothing
                        }
                      </form>
                      ${
                        params.get("find")
                          ? html`<p class="transcripts-caption" role="status">
                              ${t("transcripts.searchResults", { query: params.get("find") ?? "" })}
                            </p>`
                          : nothing
                      }
                      ${
                        props.reader.trimmed
                          ? html`<p class="transcripts-caption">
                              ${t("transcripts.windowHint")}
                              <button class="btn btn--xs" @click=${props.onReaderStart}>
                                ${t("transcripts.readerStart")}
                              </button>
                            </p>`
                          : nothing
                      }
                      <ol class="transcripts-utterances">
                        ${props.reader.pages
                          .flatMap((result) => result.utterances ?? [])
                          .map(
                            (utterance) => html`<li>
                              <div class="transcripts-utterance__byline">
                                <strong
                                  >${
                                    utterance.speakerLabel ??
                                    utterance.speakerId ??
                                    t("transcripts.unknownSpeaker")
                                  }</strong
                                >
                                ${renderSourceTime(utterance.startedAt ?? utterance.endedAt)}
                              </div>
                              <p>${utterance.text}</p>
                            </li>`,
                          )}
                      </ol>
                      ${
                        transcriptPage &&
                        !props.reader.loading &&
                        !props.reader.error &&
                        !props.reader.pages.some((result) => result.utterances?.length)
                          ? html`<p role="status">
                              ${t(
                                params.get("find")
                                  ? "transcripts.noMatches"
                                  : "transcripts.noUtterances",
                              )}
                            </p>`
                          : nothing
                      }
                      ${
                        transcriptPage?.nextCursor
                          ? html`<button
                              class="btn"
                              ?disabled=${props.reader.loading}
                              @click=${props.onLoadMore}
                            >
                              ${t("transcripts.loadMore")}
                            </button>`
                          : nothing
                      }
                    `
              }
            </div>
          `
        : nothing
    }
    ${props.reader.loading ? html`<p role="status">${t("common.loading")}</p>` : nothing}
  </article>`;
}

export function renderTranscripts(props: TranscriptsViewProps) {
  const selected = Boolean(new URLSearchParams(props.search).get("selector"));
  const captureTarget = SETTINGS_SEARCH_TARGETS.meetingCapture;
  return html`<section class="transcripts-workspace">
    <header class="content-header content-header--page">
      <div>
        <h1 class="page-title">${t("tabs.meetings")}</h1>
        <p class="page-sub">${t("subtitles.meetings")}</p>
      </div>
      <div class="transcripts-actions">
        <a
          class="btn"
          href=${
            pathForRoute(captureTarget.routeId, props.basePath) +
            captureTarget.search +
            captureTarget.hash
          }
          >${icons.settings}${t("meetingCapture.title")}</a
        >
        <button
          class="btn"
          ?disabled=${!props.connected || !props.allowed || props.listLoading}
          @click=${props.onRefresh}
        >
          ${icons.refresh}${t("common.refresh")}
        </button>
      </div>
    </header>
    ${
      !props.connected
        ? html`<div class="transcripts-notice" role="status">${t("transcripts.disconnected")}</div>`
        : !props.allowed
          ? html`<div class="transcripts-notice" role="alert">
              <h2>${t("transcripts.forbidden")}</h2>
              <p>${t("transcripts.forbiddenHint")}</p>
            </div>`
          : html`<div class="transcripts-layout ${selected ? "transcripts-layout--selected" : ""}">
              <section class="transcripts-library" aria-label=${t("transcripts.library")}>
                ${renderFilters(props)}${renderLibrary(props)}
              </section>
              ${renderReader(props)}
            </div>`
    }
  </section>`;
}
