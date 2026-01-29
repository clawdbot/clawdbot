import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { CronJob } from "../services/rpc-client.js";

type SortKey = "name" | "status" | "nextRun" | "lastRun";
type Filter = "all" | "enabled" | "disabled" | "failed";

@customElement("cron-job-list")
export class CronJobList extends LitElement {
  static styles = css`
    :host {
      display: block;
    }
    
    .toolbar {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1rem;
      flex-wrap: wrap;
    }
    
    h2 {
      margin: 0;
      font-size: 1.5rem;
      font-weight: 600;
    }
    
    .filter-group {
      display: flex;
      gap: 0.25rem;
      margin-left: auto;
    }
    
    .filter-btn {
      padding: 0.375rem 0.75rem;
      border: 1px solid #3f3f46;
      background: transparent;
      color: #a1a1aa;
      cursor: pointer;
      font-size: 0.75rem;
      transition: all 0.15s;
    }
    
    .filter-btn:first-child {
      border-radius: 0.375rem 0 0 0.375rem;
    }
    .filter-btn:last-child {
      border-radius: 0 0.375rem 0.375rem 0;
    }
    
    .filter-btn.active {
      background: #3b82f6;
      border-color: #3b82f6;
      color: white;
    }
    
    .filter-btn:hover:not(.active) {
      background: #3f3f46;
      color: #fafafa;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
    }
    
    th {
      text-align: left;
      padding: 0.75rem 1rem;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #71717a;
      border-bottom: 1px solid #3f3f46;
      cursor: pointer;
      user-select: none;
    }
    
    th:hover {
      color: #a1a1aa;
    }
    th .sort-arrow {
      margin-left: 0.25rem;
      font-size: 0.625rem;
    }
    
    td {
      padding: 0.75rem 1rem;
      border-bottom: 1px solid #27272a;
      font-size: 0.875rem;
    }
    
    tr {
      transition: background 0.1s;
    }
    
    tr:hover {
      background: #27272a;
    }
    
    tr.clickable {
      cursor: pointer;
    }
    
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.25rem 0.625rem;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 500;
    }
    
    .status-badge.ok {
      background: #14532d;
      color: #86efac;
    }
    .status-badge.error {
      background: #7f1d1d;
      color: #fecaca;
    }
    .status-badge.skipped {
      background: #713f12;
      color: #fef08a;
    }
    .status-badge.running {
      background: #1e3a5f;
      color: #93c5fd;
    }
    .status-badge.disabled {
      background: #27272a;
      color: #71717a;
    }
    .status-badge.pending {
      background: #27272a;
      color: #a1a1aa;
    }
    
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    
    .schedule {
      color: #a1a1aa;
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 0.8125rem;
    }
    
    .time {
      color: #a1a1aa;
      font-size: 0.8125rem;
    }
    
    .actions {
      display: flex;
      gap: 0.5rem;
    }
    
    .action-btn {
      padding: 0.25rem 0.5rem;
      border: 1px solid #3f3f46;
      background: transparent;
      color: #a1a1aa;
      cursor: pointer;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      transition: all 0.15s;
    }
    
    .action-btn:hover {
      background: #3f3f46;
      color: #fafafa;
    }
    
    .action-btn.danger:hover {
      background: #7f1d1d;
      border-color: #991b1b;
      color: #fecaca;
    }
    
    .action-btn.primary:hover {
      background: #1d4ed8;
      border-color: #2563eb;
      color: white;
    }
    
    .empty {
      text-align: center;
      color: #71717a;
      padding: 3rem;
    }
    
    .toggle {
      width: 40px;
      height: 22px;
      border-radius: 11px;
      border: none;
      cursor: pointer;
      position: relative;
      transition: background 0.2s;
      flex-shrink: 0;
    }
    
    .toggle.on {
      background: #22c55e;
    }
    .toggle.off {
      background: #3f3f46;
    }
    
    .toggle:hover.on {
      background: #16a34a;
    }
    .toggle:hover.off {
      background: #52525b;
    }
    
    .toggle::after {
      content: "";
      position: absolute;
      top: 2px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: white;
      transition: left 0.2s;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    }
    
    .toggle.on::after {
      left: 20px;
    }
    .toggle.off::after {
      left: 2px;
    }
  `;

  @property({ type: Array }) jobs: CronJob[] = [];
  @state() private sortKey: SortKey = "nextRun";
  @state() private sortAsc = true;
  @state() private filter: Filter = "all";

  private get filteredJobs(): CronJob[] {
    let list = [...this.jobs];

    // Filter
    switch (this.filter) {
      case "enabled":
        list = list.filter((j) => j.enabled);
        break;
      case "disabled":
        list = list.filter((j) => !j.enabled);
        break;
      case "failed":
        list = list.filter((j) => j.state.lastStatus === "error");
        break;
    }

    // Sort
    list.sort((a, b) => {
      let cmp = 0;
      switch (this.sortKey) {
        case "name":
          cmp = (a.name || "").localeCompare(b.name || "");
          break;
        case "status":
          cmp = (a.state.lastStatus || "").localeCompare(b.state.lastStatus || "");
          break;
        case "nextRun":
          cmp = (a.state.nextRunAtMs || Infinity) - (b.state.nextRunAtMs || Infinity);
          break;
        case "lastRun":
          cmp = (b.state.lastRunAtMs || 0) - (a.state.lastRunAtMs || 0);
          break;
      }
      return this.sortAsc ? cmp : -cmp;
    });

    return list;
  }

  private toggleSort(key: SortKey) {
    if (this.sortKey === key) {
      this.sortAsc = !this.sortAsc;
    } else {
      this.sortKey = key;
      this.sortAsc = true;
    }
  }

  private dispatchEvent2(name: string, detail: Record<string, unknown>) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  render() {
    const jobs = this.filteredJobs;

    return html`
      <div class="toolbar">
        <h2>Jobs (${this.jobs.length})</h2>
        <div class="filter-group">
          ${(["all", "enabled", "disabled", "failed"] as Filter[]).map(
            (f) => html`
              <button
                class="filter-btn ${this.filter === f ? "active" : ""}"
                @click=${() => (this.filter = f)}
              >
                ${f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            `,
          )}
        </div>
      </div>

      ${
        jobs.length === 0
          ? html`
              <div class="empty">No jobs match filter</div>
            `
          : html`
            <table>
              <thead>
                <tr>
                  <th style="width:36px"></th>
                  <th @click=${() => this.toggleSort("name")}>
                    Name ${this.sortKey === "name" ? html`<span class="sort-arrow">${this.sortAsc ? "▲" : "▼"}</span>` : ""}
                  </th>
                  <th>Schedule</th>
                  <th @click=${() => this.toggleSort("status")}>
                    Status ${this.sortKey === "status" ? html`<span class="sort-arrow">${this.sortAsc ? "▲" : "▼"}</span>` : ""}
                  </th>
                  <th @click=${() => this.toggleSort("nextRun")}>
                    Next Run ${this.sortKey === "nextRun" ? html`<span class="sort-arrow">${this.sortAsc ? "▲" : "▼"}</span>` : ""}
                  </th>
                  <th @click=${() => this.toggleSort("lastRun")}>
                    Last Run ${this.sortKey === "lastRun" ? html`<span class="sort-arrow">${this.sortAsc ? "▲" : "▼"}</span>` : ""}
                  </th>
                  <th>Duration</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${jobs.map((j) => this.renderRow(j))}
              </tbody>
            </table>
          `
      }
    `;
  }

  private renderRow(job: CronJob) {
    const running = typeof job.state.runningAtMs === "number";
    const statusClass = !job.enabled
      ? "disabled"
      : running
        ? "running"
        : job.state.lastStatus || "pending";

    return html`
      <tr class="clickable" @click=${() => this.dispatchEvent2("select-job", { id: job.id })}>
        <td @click=${(e: Event) => e.stopPropagation()}>
          <button
            class="toggle ${job.enabled ? "on" : "off"}"
            @click=${() => this.dispatchEvent2("toggle-job", { id: job.id, enabled: !job.enabled })}
          ></button>
        </td>
        <td>
          <div style="font-weight:500">${job.name || job.id.slice(0, 8)}</div>
          ${job.description ? html`<div style="font-size:0.75rem;color:#71717a;margin-top:2px">${job.description}</div>` : ""}
        </td>
        <td><span class="schedule">${this.formatSchedule(job.schedule)}</span></td>
        <td><span class="status-badge ${statusClass}"><span class="status-dot"></span>${this.statusLabel(job, running)}</span></td>
        <td class="time">${job.state.nextRunAtMs ? this.timeAgo(job.state.nextRunAtMs) : "—"}</td>
        <td class="time">${job.state.lastRunAtMs ? this.timeAgo(job.state.lastRunAtMs) : "—"}</td>
        <td class="time">${job.state.lastDurationMs != null ? this.formatMs(job.state.lastDurationMs) : "—"}</td>
        <td @click=${(e: Event) => e.stopPropagation()}>
          <div class="actions">
            <button class="action-btn primary" @click=${() => this.dispatchEvent2("run-job", { id: job.id })} title="Run now">▶</button>
            <button class="action-btn danger" @click=${() => this.dispatchEvent2("delete-job", { id: job.id })} title="Delete">✕</button>
          </div>
        </td>
      </tr>
    `;
  }

  private statusLabel(job: CronJob, running: boolean): string {
    if (!job.enabled) return "Disabled";
    if (running) return "Running";
    switch (job.state.lastStatus) {
      case "ok":
        return "OK";
      case "error":
        return "Error";
      case "skipped":
        return "Skipped";
      default:
        return "Pending";
    }
  }

  private formatSchedule(s: CronJob["schedule"]): string {
    if (s.kind === "cron") return s.expr || "cron";
    if (s.kind === "every") return `⏱ ${this.formatMs(s.everyMs || 0)}`;
    if (s.kind === "at") return `📅 ${new Date(s.atMs || 0).toLocaleString()}`;
    return "—";
  }

  private formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
  }

  private timeAgo(ms: number): string {
    const now = Date.now();
    const diff = now - ms;

    if (diff < 0) {
      // Future
      const abs = -diff;
      if (abs < 60_000) return `in ${Math.round(abs / 1000)}s`;
      if (abs < 3_600_000) return `in ${Math.round(abs / 60_000)}m`;
      if (abs < 86_400_000) return `in ${Math.round(abs / 3_600_000)}h`;
      return `in ${Math.round(abs / 86_400_000)}d`;
    }

    if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    return `${Math.round(diff / 86_400_000)}d ago`;
  }
}
