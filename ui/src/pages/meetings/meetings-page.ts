import { consume } from "@lit/context";
import type {
  TranscriptSessionSummary,
  TranscriptsGetResult,
  TranscriptsListResult,
} from "@openclaw/gateway-protocol";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { t } from "../../i18n/index.ts";
import { registerMeetingsEnglish } from "../../i18n/locales/en-meetings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatDurationCompact } from "../../lib/format.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "./meetings.css";

registerMeetingsEnglish();

function meetingDay(startedAt: string) {
  return new Date(startedAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

class MeetingsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;
  @property({ attribute: false }) routeSearch = "";
  @state() private sessions: TranscriptSessionSummary[] | null = null;
  @state() private detail: TranscriptsGetResult | null = null;
  @state() private listLoading = false;
  @state() private detailLoading = false;
  @state() private listError: string | null = null;
  @state() private detailError: string | null = null;
  private detailGeneration = 0;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => {
      this.detailGeneration++;
      this.sessions = null;
      this.detail = null;
      this.listLoading = false;
      this.detailLoading = false;
      this.listError = null;
      this.detailError = null;
    },
    ensureInitialData: () => this.refresh(),
  });

  private get selector() {
    return new URLSearchParams(this.routeSearch).get("selector");
  }

  override updated(changed: PropertyValues) {
    if (changed.has("routeSearch")) {
      this.detailGeneration++;
      this.detail = null;
      this.detailLoading = false;
      this.detailError = null;
      void this.loadDetail();
    }
  }

  private refresh() {
    void this.loadList();
    void this.loadDetail();
  }

  private async loadList() {
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (!client || !scope || this.listLoading) {
      return;
    }
    this.listLoading = true;
    this.listError = null;
    try {
      const result = await client.request<TranscriptsListResult>("transcripts.list", {
        limit: 200,
      });
      if (this.gateway.isCurrent(scope)) {
        this.sessions = result.sessions;
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.listError = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.listLoading = false;
      }
    }
  }

  private async loadDetail() {
    const selector = this.selector;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (!selector || !client || !scope) {
      return;
    }
    const generation = ++this.detailGeneration;
    const current = () =>
      this.gateway.isCurrent(scope) &&
      generation === this.detailGeneration &&
      this.selector === selector;
    this.detailLoading = true;
    this.detailError = null;
    try {
      const result = await client.request<TranscriptsGetResult>("transcripts.get", {
        selector,
      });
      if (current()) {
        this.detail = result;
      }
    } catch (error) {
      if (current()) {
        this.detailError = formatUiError(error);
      }
    } finally {
      if (current()) {
        this.detailLoading = false;
      }
    }
  }

  private selectMeeting(selector: string) {
    this.context.navigate("meetings", { search: `?${new URLSearchParams({ selector })}` });
  }

  private renderRow(session: TranscriptSessionSummary) {
    const silent = session.utteranceCount === 0;
    const participants = session.participants.slice(0, 3).join(", ");
    const extra = session.participants.length - 3;
    const duration = session.stoppedAt
      ? formatDurationCompact(
          Math.max(0, Date.parse(session.stoppedAt) - Date.parse(session.startedAt)),
        )
      : null;
    return html`<button
      class="meetings-row ${this.selector === session.selector ? "selected" : ""} ${silent
        ? "meetings-row--silent"
        : ""}"
      type="button"
      aria-current=${this.selector === session.selector ? "true" : nothing}
      @click=${() => this.selectMeeting(session.selector)}
    >
      <span class="meetings-row__title"
        >${session.title || session.providerName || session.providerId}</span
      >
      <span class="meetings-row__meta"
        >${session.providerName || session.providerId} ·
        ${new Date(session.startedAt).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        })}
        ${session.active
          ? html`<span class="meetings-live">${t("meetings.inProgress")}</span>`
          : duration
            ? html` · ${duration}`
            : nothing}
      </span>
      ${participants
        ? html`<span class="meetings-row__meta meetings-row__participants"
            >${participants}${extra > 0 ? ` +${extra}` : ""}</span
          >`
        : nothing}
      <span class="meetings-row__meta"
        >${t("meetings.utterances", { count: String(session.utteranceCount) })}</span
      >
      ${silent || session.overview
        ? html`<span class="meetings-row__overview"
            >${silent ? t("meetings.noSpeech") : session.overview}</span
          >`
        : nothing}
    </button>`;
  }

  private renderList() {
    const days = new Map<string, TranscriptSessionSummary[]>();
    for (const session of (this.sessions ?? []).toSorted((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    )) {
      const day = meetingDay(session.startedAt);
      const meetings = days.get(day) ?? [];
      meetings.push(session);
      days.set(day, meetings);
    }
    return html`<aside class="meetings-list" aria-label=${t("meetings.listLabel")}>
      ${Array.from(
        days,
        ([day, meetings]) =>
          html`<section class="meetings-day">
            <h2>${day}</h2>
            ${meetings.map((session) => this.renderRow(session))}
          </section>`,
      )}
    </aside>`;
  }

  private renderDetail() {
    const detail = this.detail;
    return html`<section class="meetings-detail" aria-busy=${this.detailLoading}>
      ${this.detailError
        ? html`<div class="callout danger" role="alert">${this.detailError}</div>`
        : nothing}
      ${!detail
        ? html`<p class="muted">
            ${t(this.detailLoading ? "meetings.loadingNotes" : "meetings.select")}
          </p>`
        : html`
            <div class="meetings-detail__meta">
              ${detail.session.summarySource
                ? html`<span
                    >${t("meetings.notesSource", { source: detail.session.summarySource })}</span
                  >`
                : nothing}
              ${detail.session.active
                ? html`<span class="meetings-live">${t("meetings.inProgress")}</span>`
                : nothing}
            </div>
            ${detail.summary
              ? html`<div class="meetings-notes markdown">
                  ${unsafeHTML(toSanitizedMarkdownHtml(detail.summary.markdown))}
                </div>`
              : html`<h2>
                    ${detail.session.title ||
                    detail.session.providerName ||
                    detail.session.providerId}
                  </h2>
                  <p>${t("meetings.noNotes")}</p>
                  ${detail.session.active ? html`<p>${t("meetings.activeNotes")}</p>` : nothing}`}
          `}
    </section>`;
  }

  override render() {
    return html`<section class="content-header content-header--page">
        <div>
          <div class="page-title">${titleForRoute("meetings")}</div>
          <div class="page-sub">${subtitleForRoute("meetings")}</div>
        </div>
        <button
          class="btn"
          type="button"
          ?disabled=${this.listLoading || !this.gateway.connected}
          @click=${() => this.refresh()}
        >
          ${t("meetings.refresh")}
        </button>
      </section>
      ${this.listError
        ? html`<div class="callout danger" role="alert">${this.listError}</div>`
        : nothing}
      ${this.sessions?.length || this.selector
        ? html`<div class="meetings-layout">${this.renderList()}${this.renderDetail()}</div>`
        : this.sessions && !this.listError
          ? html`<section class="meetings-empty" role="status">
              <h2>${t("meetings.emptyTitle")}</h2>
              <p>${t("meetings.emptyBody")}</p>
              <a
                href="https://docs.openclaw.ai/cli/transcripts"
                target="_blank"
                rel="noopener noreferrer"
                >${t("meetings.docs")}</a
              >
            </section>`
          : this.listLoading
            ? html`<p role="status">${t("meetings.loading")}</p>`
            : nothing}`;
  }
}

export const meetingsPageComponent = {
  header: true,
  render: (search: unknown) =>
    html`<openclaw-meetings-page
      .routeSearch=${typeof search === "string" ? search : ""}
    ></openclaw-meetings-page>`,
};
if (!customElements.get("openclaw-meetings-page")) {
  customElements.define("openclaw-meetings-page", MeetingsPage);
}
