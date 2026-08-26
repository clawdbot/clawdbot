import type {
  SessionsTrajectoryDetailResult,
  SessionsTrajectoryPageResult,
  TrajectoryRecord,
} from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { renderTrajectoryDetailTab } from "./trajectory-inspector-view.ts";
import {
  formatTrajectoryClock,
  formatTrajectoryDuration,
  trajectoryDetailTabs,
  trajectoryRecordMatches,
} from "./trajectory-presentation.ts";

type LedgerRow =
  | { kind: "turn"; key: string; turn: number; summary: string }
  | { kind: "group"; key: string; label: string; description?: string }
  | { kind: "record"; key: string; record: TrajectoryRecord; requestNumber?: number };

const ROW_HEIGHT = 52;
const OVERSCAN = 7;

function eventSessionKey(event: GatewayEventFrame): string | undefined {
  const payload = isRecord(event.payload) ? event.payload : undefined;
  return typeof payload?.sessionKey === "string" ? payload.sessionKey : undefined;
}

class TrajectoryPanel extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property() sessionKey = "";
  @property() agentId: string | null = null;
  @property({ type: Boolean }) presented = false;

  @state() private records: TrajectoryRecord[] = [];
  @state() private cursor: string | null = null;
  @state() private hasMore = false;
  @state() private capture: SessionsTrajectoryPageResult["capture"] = "empty";
  @state() private trimmedPrefix = false;
  @state() private loading = false;
  @state() private loadingEarlier = false;
  @state() private error: string | null = null;
  @state() private search = "";
  @state() private durationProjection = false;
  @state() private turnsCollapsed = false;
  @state() private callsCollapsed = false;
  @state() private selectedId: string | null = null;
  @state() private selectedDetail: unknown = null;
  @state() private detailLoading = false;
  @state() private detailTab = "Summary";
  @state() private range: [number, number] | null = null;
  @state() private timelineZoom = 1;
  @state() private virtualStart = 0;
  @state() private virtualEnd = 30;
  @state() private followTail = true;
  @state() private inspectorWidth = 360;

  private scrollElement: HTMLDivElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private refreshTimer: number | null = null;
  private loadGeneration = 0;
  private dragStart: number | null = null;
  private hydratedKey = "";

  override connectedCallback() {
    super.connectedCallback();
    this.bindClient();
  }

  override disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    super.disconnectedCallback();
  }

  protected override updated(changed: Map<PropertyKey, unknown>) {
    if (changed.has("client")) {
      this.bindClient();
    }
    if (changed.has("sessionKey") || changed.has("agentId") || changed.has("client")) {
      const key = `${this.agentId ?? ""}\0${this.sessionKey}`;
      if (key !== this.hydratedKey) {
        this.hydratedKey = key;
        void this.loadTail();
        return;
      }
    }
    if (changed.has("presented") && this.presented && this.records.length === 0) {
      void this.loadTail();
    }
  }

  private bindClient() {
    this.unsubscribe?.();
    this.unsubscribe = this.client?.addEventListener((event) => this.onGatewayEvent(event)) ?? null;
  }

  private onGatewayEvent(event: GatewayEventFrame) {
    if (!this.presented || (event.event !== "agent" && event.event !== "session.message")) {
      return;
    }
    const key = eventSessionKey(event);
    if (key && key !== this.sessionKey) {
      return;
    }
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshTail();
    }, 120);
  }

  private requestParams(cursor?: string) {
    return {
      sessionKey: this.sessionKey,
      ...(this.agentId ? { agentId: this.agentId } : {}),
      ...(cursor ? { cursor } : {}),
      limit: 100,
    };
  }

  private async loadTail() {
    const client = this.client;
    const generation = ++this.loadGeneration;
    if (!client || !this.sessionKey) {
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const result = await client.request<SessionsTrajectoryPageResult>(
        "sessions.trajectory.page",
        this.requestParams(),
      );
      if (generation !== this.loadGeneration) {
        return;
      }
      this.records = result.records;
      this.cursor = result.cursor ?? null;
      this.hasMore = result.hasMore;
      this.capture = result.capture;
      this.trimmedPrefix = result.trimmedPrefix;
      this.loading = false;
      await this.updateComplete;
      if (generation === this.loadGeneration) {
        this.scrollToLatest();
      }
    } catch (error) {
      if (generation === this.loadGeneration) {
        this.error = formatUiError(error);
      }
    } finally {
      if (generation === this.loadGeneration && this.loading) {
        this.loading = false;
      }
    }
  }

  private async refreshTail() {
    const client = this.client;
    if (!client || !this.sessionKey) {
      return;
    }
    const wasFollowing = this.followTail;
    try {
      const result = await client.request<SessionsTrajectoryPageResult>(
        "sessions.trajectory.page",
        this.requestParams(),
      );
      const known = new Map(this.records.map((record) => [record.id, record]));
      for (const record of result.records) {
        known.set(record.id, record);
      }
      this.records = [...known.values()].toSorted(
        (left, right) => left.timestamp - right.timestamp || left.sourceSeq - right.sourceSeq,
      );
      this.capture = result.capture;
      this.trimmedPrefix = result.trimmedPrefix;
      await this.updateComplete;
      if (wasFollowing) {
        this.scrollToLatest();
      }
    } catch {
      // Keep already loaded rows interactive; explicit page loads surface errors.
    }
  }

  private async loadEarlier() {
    const client = this.client;
    const cursor = this.cursor;
    const scroll = this.scrollElement;
    if (!client || !cursor || this.loadingEarlier) {
      return;
    }
    this.loadingEarlier = true;
    const beforeHeight = scroll?.scrollHeight ?? 0;
    const beforeTop = scroll?.scrollTop ?? 0;
    try {
      const result = await client.request<SessionsTrajectoryPageResult>(
        "sessions.trajectory.page",
        this.requestParams(cursor),
      );
      const known = new Set(this.records.map((record) => record.id));
      const earlier = result.records.filter((record) => !known.has(record.id));
      this.records = [...earlier, ...this.records];
      this.cursor = result.cursor ?? null;
      this.hasMore = result.hasMore;
      this.trimmedPrefix ||= result.trimmedPrefix;
      await this.updateComplete;
      if (scroll) {
        scroll.scrollTop = beforeTop + scroll.scrollHeight - beforeHeight;
      }
    } catch (error) {
      this.error = formatUiError(error);
    } finally {
      this.loadingEarlier = false;
    }
  }

  private ledgerRows(): LedgerRow[] {
    const searched = this.records.filter((record) => trajectoryRecordMatches(record, this.search));
    const ranged = this.range ? searched.slice(this.range[0], this.range[1] + 1) : searched;
    const rows: LedgerRow[] = [];
    let turn = 0;
    let step = 0;
    let requestNumber = 0;
    let hiddenInTurn = 0;
    let hiddenCalls = 0;
    let betweenTurnsShown = false;
    const pushTurnSummary = () => {
      if (hiddenInTurn > 0) {
        rows.push({
          kind: "group",
          key: `turn:${turn}:summary`,
          label: `${hiddenInTurn} records collapsed`,
        });
        hiddenInTurn = 0;
      }
    };
    const pushCallSummary = () => {
      if (hiddenCalls > 0) {
        rows.push({
          kind: "group",
          key: `calls:${rows.length}:summary`,
          label: `${hiddenCalls} tool ${hiddenCalls === 1 ? "call" : "calls"} collapsed`,
        });
        hiddenCalls = 0;
      }
    };
    for (const record of ranged) {
      if (record.kind === "user") {
        pushTurnSummary();
        pushCallSummary();
        turn += 1;
        step = 0;
        hiddenInTurn = 0;
        rows.push({ kind: "turn", key: `turn:${turn}`, turn, summary: `Turn ${turn}` });
      }
      if (record.kind === "request") {
        requestNumber += 1;
      }
      if (this.turnsCollapsed && turn > 0 && record.kind !== "user") {
        hiddenInTurn += 1;
        continue;
      }
      if (this.callsCollapsed && (record.kind === "tool" || record.kind === "subtool")) {
        hiddenCalls += 1;
        continue;
      }
      pushCallSummary();
      if (record.kind === "request") {
        step += 1;
        rows.push({
          kind: "group",
          key: `step:${record.id}`,
          label: `Step ${step}`,
          description:
            record.provider && record.model ? `${record.provider} · ${record.model}` : undefined,
        });
      } else if (record.kind === "compacted" && turn === 0 && !betweenTurnsShown) {
        betweenTurnsShown = true;
        rows.push({ kind: "group", key: "between-turns", label: "Between turns" });
      }
      rows.push({
        kind: "record",
        key: record.id,
        record,
        ...(record.kind === "request" ? { requestNumber } : {}),
      });
    }
    pushCallSummary();
    pushTurnSummary();
    return rows;
  }

  private syncVirtualWindow() {
    const scroll = this.scrollElement;
    if (!scroll) {
      return;
    }
    this.followTail = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 48;
    const prefixRows = this.hasMore || this.trimmedPrefix ? 1 : 0;
    this.virtualStart = Math.max(
      0,
      Math.floor(scroll.scrollTop / ROW_HEIGHT) - OVERSCAN - prefixRows,
    );
    this.virtualEnd = Math.ceil((scroll.scrollTop + scroll.clientHeight) / ROW_HEIGHT) + OVERSCAN;
  }

  private scrollToLatest() {
    if (this.scrollElement) {
      this.scrollElement.scrollTop = this.scrollElement.scrollHeight;
      this.followTail = true;
      this.syncVirtualWindow();
    }
  }

  private async selectRecord(record: TrajectoryRecord) {
    this.selectedId = record.id;
    this.selectedDetail = null;
    this.detailLoading = true;
    this.detailTab = trajectoryDetailTabs(record, null)[0] ?? "Summary";
    try {
      const result = await this.client?.request<SessionsTrajectoryDetailResult>(
        "sessions.trajectory.detail",
        {
          sessionKey: this.sessionKey,
          ...(this.agentId ? { agentId: this.agentId } : {}),
          recordId: record.id,
        },
      );
      if (this.selectedId === record.id && result?.ok) {
        this.selectedDetail = result.detail;
      }
    } catch (error) {
      if (this.selectedId === record.id) {
        this.selectedDetail = { error: formatUiError(error) };
      }
    } finally {
      if (this.selectedId === record.id) {
        this.detailLoading = false;
      }
    }
  }

  private selectedRecord(): TrajectoryRecord | undefined {
    return this.records.find((record) => record.id === this.selectedId);
  }

  private renderTimeline() {
    const records = this.records.filter((record) => trajectoryRecordMatches(record, this.search));
    const maxDuration = Math.max(1, ...records.map((record) => record.durationMs ?? 0));
    const width = Math.max(100, records.length * 18 * this.timelineZoom);
    const lanes = ["input", "model", "tools"] as const;
    return html`<div
      class="trajectory-timeline"
      role="img"
      aria-label="Trajectory timeline"
      @wheel=${(event: WheelEvent) => {
        event.preventDefault();
        this.timelineZoom = Math.min(4, Math.max(0.6, this.timelineZoom - event.deltaY * 0.002));
      }}
      @pointerdown=${(event: PointerEvent) => {
        if (event.button !== 2 || !(event.currentTarget instanceof HTMLElement)) {
          return;
        }
        const timeline = event.currentTarget;
        const startX = event.clientX;
        const startScroll = timeline.scrollLeft;
        const move = (moveEvent: PointerEvent) => {
          timeline.scrollLeft = startScroll + startX - moveEvent.clientX;
        };
        const stop = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", stop);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop, { once: true });
      }}
      @contextmenu=${(event: MouseEvent) => {
        event.preventDefault();
        this.range = null;
      }}
    >
      <div class="trajectory-timeline__canvas" style=${`width:${width}%`}>
        ${lanes.map(
          (lane) => html`<div class="trajectory-timeline__lane">
            <span class="trajectory-timeline__label"
              >${lane === "input" ? "Input" : lane === "model" ? "Model" : "Tools"}</span
            >
            <div class="trajectory-timeline__track">
              ${records.map((record, index) => {
                if (record.lane !== lane) {
                  return nothing;
                }
                const left = (index / Math.max(1, records.length)) * 100;
                const span = this.durationProjection
                  ? Math.max(0.6, ((record.durationMs ?? 0) / maxDuration) * 8)
                  : Math.max(0.6, 80 / Math.max(1, records.length));
                const rangeSelected =
                  this.range && index >= this.range[0] && index <= this.range[1];
                return html`<button
                  class="trajectory-timeline__mark trajectory-timeline__mark--${record.lane} ${record.id ===
                  this.selectedId
                    ? "is-selected"
                    : ""} ${rangeSelected ? "is-range" : ""}"
                  style=${`left:${left}%;width:${span}%`}
                  title=${`${record.title} · ${formatTrajectoryClock(record.timestamp)} · ${formatTrajectoryDuration(record.durationMs)}`}
                  @pointerdown=${(event: PointerEvent) => {
                    if (event.button === 0) {
                      this.dragStart = index;
                      if (event.currentTarget instanceof HTMLElement) {
                        event.currentTarget.setPointerCapture(event.pointerId);
                      }
                    }
                  }}
                  @pointerenter=${(event: PointerEvent) => {
                    if (event.buttons === 1 && this.dragStart !== null) {
                      this.range = [
                        Math.min(this.dragStart, index),
                        Math.max(this.dragStart, index),
                      ];
                    }
                  }}
                  @pointerup=${() => {
                    this.dragStart = null;
                    void this.selectRecord(record);
                  }}
                  aria-label=${record.title}
                ></button>`;
              })}
            </div>
          </div>`,
        )}
      </div>
    </div>`;
  }

  private renderLedger() {
    const rows = this.ledgerRows();
    const prefixRows = this.hasMore || this.trimmedPrefix ? 1 : 0;
    const visible = rows.slice(this.virtualStart, Math.min(rows.length, this.virtualEnd));
    return html`<div
      class="trajectory-ledger"
      role="table"
      aria-rowcount=${rows.length}
      ${ref((element) => {
        this.scrollElement = element instanceof HTMLDivElement ? element : null;
        this.syncVirtualWindow();
      })}
      @scroll=${() => this.syncVirtualWindow()}
      @click=${(event: MouseEvent) => {
        if (event.target === event.currentTarget) {
          this.selectedId = null;
        }
      }}
    >
      <div
        class="trajectory-ledger__sizer"
        style=${`height:${(rows.length + prefixRows) * ROW_HEIGHT}px`}
      >
        ${prefixRows
          ? html`<div class="trajectory-load-earlier-row">
              ${this.hasMore
                ? html`<button
                    class="trajectory-load-earlier"
                    ?disabled=${this.loadingEarlier}
                    aria-busy=${String(this.loadingEarlier)}
                    @click=${() => void this.loadEarlier()}
                  >
                    ${this.loadingEarlier
                      ? t("chat.trajectory.loadingEarlier")
                      : t("chat.trajectory.loadEarlier")}
                  </button>`
                : html`<span>${t("chat.trajectory.trimmed")}</span>`}
            </div>`
          : nothing}
        ${visible.map((row, offset) => {
          const index = this.virtualStart + offset;
          return html`<div
            class="trajectory-ledger__virtual-row"
            style=${`transform:translateY(${(index + prefixRows) * ROW_HEIGHT}px)`}
            role="row"
            aria-rowindex=${index + 1}
          >
            ${row.kind === "turn"
              ? html`<div class="trajectory-turn-header" role="rowheader">
                  <strong>${row.summary}</strong>
                  <span>Input · Output · Think · Time</span>
                </div>`
              : row.kind === "group"
                ? html`<div class="trajectory-group-header" role="rowheader">
                    <strong>${row.label}</strong>
                    ${row.description ? html`<span>${row.description}</span>` : nothing}
                  </div>`
                : this.renderRecordRow(row.record, row.requestNumber)}
          </div>`;
        })}
      </div>
    </div>`;
  }

  private renderRecordRow(record: TrajectoryRecord, requestNumber?: number) {
    return html`<button
      class="trajectory-record trajectory-record--${record.kind} ${record.id === this.selectedId
        ? "is-selected"
        : ""}"
      role="row"
      aria-selected=${String(record.id === this.selectedId)}
      @click=${() => void this.selectRecord(record)}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void this.selectRecord(record);
        }
      }}
    >
      <span class="trajectory-record__rail trajectory-record__rail--${record.status}"></span>
      <span class="trajectory-record__event">
        ${requestNumber
          ? html`<span class="trajectory-request-pill">Request #${requestNumber}</span>`
          : nothing}
        <span class="trajectory-kind">${record.kind}</span>
      </span>
      <span class="trajectory-record__content">
        <strong>${record.title}</strong>
        <span
          >${record.preview ||
          (record.kind === "assistant" ? "(tool call only)" : "No preview")}</span
        >
      </span>
      <span class="trajectory-record__meta">
        <time>${formatTrajectoryClock(record.timestamp)}</time>
        <span>${formatTrajectoryDuration(record.durationMs)}</span>
      </span>
    </button>`;
  }

  private renderInspector() {
    const record = this.selectedRecord();
    if (!record) {
      return nothing;
    }
    const tabs = trajectoryDetailTabs(record, this.selectedDetail);
    const active = tabs.includes(this.detailTab) ? this.detailTab : (tabs[0] ?? "Summary");
    return html`<aside
      class="trajectory-inspector"
      style=${`--trajectory-inspector-width:${this.inspectorWidth}px`}
      aria-label=${t("chat.trajectory.eventDetails")}
    >
      <div
        class="trajectory-inspector__resize"
        role="separator"
        aria-label="Resize event details"
        tabindex="0"
        @pointerdown=${(event: PointerEvent) => {
          const startX = event.clientX;
          const startWidth = this.inspectorWidth;
          const move = (moveEvent: PointerEvent) => {
            this.inspectorWidth = Math.min(
              620,
              Math.max(280, startWidth + startX - moveEvent.clientX),
            );
          };
          const stop = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", stop, { once: true });
        }}
      ></div>
      <header>
        <div>
          <span class="trajectory-kind">${record.kind}</span><strong>${record.title}</strong>
        </div>
        <button
          type="button"
          aria-label="Close event details"
          @click=${() => (this.selectedId = null)}
        >
          ×
        </button>
      </header>
      <div class="trajectory-inspector__tabs" role="tablist">
        ${tabs.map(
          (tab) => html`<button
            role="tab"
            aria-selected=${String(active === tab)}
            @click=${() => (this.detailTab = tab)}
          >
            ${tab}
          </button>`,
        )}
      </div>
      <div class="trajectory-inspector__body" role="tabpanel">
        ${this.detailLoading
          ? html`<div class="trajectory-state">Loading details…</div>`
          : renderTrajectoryDetailTab({
              record,
              tab: active,
              detail: this.selectedDetail,
              records: this.records,
            })}
      </div>
    </aside>`;
  }

  override render() {
    return html`<section class="trajectory-panel">
      <div class="trajectory-toolbar" role="toolbar" aria-label="Trajectory controls">
        <button
          type="button"
          aria-pressed=${String(this.durationProjection)}
          @click=${() => (this.durationProjection = !this.durationProjection)}
        >
          ${t("chat.trajectory.duration")}
        </button>
        <button
          type="button"
          aria-pressed=${String(this.turnsCollapsed)}
          @click=${() => (this.turnsCollapsed = !this.turnsCollapsed)}
        >
          ${t("chat.trajectory.turns")}
        </button>
        <button
          type="button"
          aria-pressed=${String(this.callsCollapsed)}
          @click=${() => (this.callsCollapsed = !this.callsCollapsed)}
        >
          ${t("chat.trajectory.calls")}
        </button>
        <input
          type="search"
          aria-label=${t("chat.trajectory.search")}
          placeholder=${t("chat.trajectory.search")}
          .value=${this.search}
          @input=${(event: InputEvent) => {
            if (event.currentTarget instanceof HTMLInputElement) {
              this.search = event.currentTarget.value;
            }
            this.virtualStart = 0;
          }}
        />
      </div>
      ${this.renderTimeline()}
      <div class="trajectory-main">
        <div class="trajectory-ledger-column">
          ${this.loading
            ? html`<div class="trajectory-state" role="status">
                ${t("chat.trajectory.loading")}
              </div>`
            : this.error
              ? html`<div class="trajectory-state trajectory-state--error" role="alert">
                  ${t("chat.trajectory.failed", { error: this.error })}
                </div>`
              : this.capture === "disabled"
                ? html`<div class="trajectory-state">${t("chat.trajectory.disabled")}</div>`
                : this.records.length === 0
                  ? html`<div class="trajectory-state">${t("chat.trajectory.empty")}</div>`
                  : this.renderLedger()}
          ${!this.followTail && this.records.length > 0
            ? html`<button class="trajectory-jump-latest" @click=${() => this.scrollToLatest()}>
                ${t("chat.trajectory.jumpLatest")}
              </button>`
            : nothing}
        </div>
        ${this.renderInspector()}
      </div>
    </section>`;
  }
}

if (!customElements.get("openclaw-trajectory-panel")) {
  customElements.define("openclaw-trajectory-panel", TrajectoryPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-trajectory-panel": TrajectoryPanel;
  }
}
