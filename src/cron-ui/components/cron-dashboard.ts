import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { CronJob, QueueStatus } from "../services/rpc-client.js";

@customElement("cron-dashboard")
export class CronDashboard extends LitElement {
  static styles = css`
    :host {
      display: block;
    }
    
    h2 {
      margin: 0 0 1.5rem;
      font-size: 1.5rem;
      font-weight: 600;
    }
    
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    
    .stat-card {
      background: #27272a;
      border: 1px solid #3f3f46;
      border-radius: 0.75rem;
      padding: 1.25rem;
    }
    
    .stat-label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #71717a;
      margin-bottom: 0.5rem;
    }
    
    .stat-value {
      font-size: 2rem;
      font-weight: 700;
    }
    
    .stat-value.green {
      color: #22c55e;
    }
    .stat-value.blue {
      color: #3b82f6;
    }
    .stat-value.yellow {
      color: #eab308;
    }
    .stat-value.red {
      color: #ef4444;
    }
    .stat-value.gray {
      color: #71717a;
    }
    .stat-value.cyan {
      color: #06b6d4;
    }
    
    .section {
      margin-top: 2rem;
    }
    
    .section h3 {
      font-size: 1rem;
      font-weight: 600;
      margin: 0 0 1rem;
      color: #a1a1aa;
    }
    
    .job-summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 0.75rem;
    }
    
    .job-card {
      background: #27272a;
      border: 1px solid #3f3f46;
      border-radius: 0.5rem;
      padding: 1rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    
    .job-status {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    
    .job-status.ok {
      background: #22c55e;
    }
    .job-status.error {
      background: #ef4444;
    }
    .job-status.skipped {
      background: #eab308;
    }
    .job-status.running {
      background: #3b82f6;
      animation: pulse 1.5s infinite;
    }
    .job-status.disabled {
      background: #52525b;
    }
    
    @keyframes pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.4;
      }
    }
    
    .job-info {
      flex: 1;
      min-width: 0;
    }
    
    .job-name {
      font-weight: 500;
      font-size: 0.875rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .job-meta {
      font-size: 0.75rem;
      color: #71717a;
      margin-top: 0.25rem;
    }
    
    .empty {
      text-align: center;
      color: #71717a;
      padding: 3rem;
    }
  `;

  @property({ type: Object }) status: QueueStatus | null = null;
  @property({ type: Array }) jobs: CronJob[] = [];

  private get enabledJobs() {
    return this.jobs.filter((j) => j.enabled);
  }

  private get recentFailed() {
    return this.jobs.filter((j) => j.state.lastStatus === "error");
  }

  private get runningJobs() {
    return this.jobs.filter((j) => typeof j.state.runningAtMs === "number");
  }

  render() {
    const bm = this.status?.bullmq;

    return html`
      <h2>Dashboard</h2>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Jobs</div>
          <div class="stat-value blue">${this.jobs.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Enabled</div>
          <div class="stat-value green">${this.enabledJobs.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Active</div>
          <div class="stat-value cyan">${bm?.active ?? this.runningJobs.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Schedulers</div>
          <div class="stat-value blue">${bm?.schedulers ?? "—"}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Completed</div>
          <div class="stat-value green">${bm?.completed ?? "—"}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Failed</div>
          <div class="stat-value red">${bm?.failed ?? this.recentFailed.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Waiting</div>
          <div class="stat-value yellow">${bm?.waiting ?? "—"}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Delayed</div>
          <div class="stat-value gray">${bm?.delayed ?? "—"}</div>
        </div>
      </div>

      ${
        this.runningJobs.length > 0
          ? html`
            <div class="section">
              <h3>🔄 Running Now</h3>
              <div class="job-summary">
                ${this.runningJobs.map((j) => this.renderJobCard(j, "running"))}
              </div>
            </div>
          `
          : ""
      }

      ${
        this.recentFailed.length > 0
          ? html`
            <div class="section">
              <h3>❌ Recent Failures</h3>
              <div class="job-summary">
                ${this.recentFailed.map((j) => this.renderJobCard(j, "error"))}
              </div>
            </div>
          `
          : ""
      }

      ${
        this.jobs.length === 0
          ? html`
              <div class="empty">No cron jobs configured</div>
            `
          : ""
      }
    `;
  }

  private renderJobCard(job: CronJob, statusClass: string) {
    return html`
      <div class="job-card">
        <div class="job-status ${statusClass}"></div>
        <div class="job-info">
          <div class="job-name">${job.name || job.id}</div>
          <div class="job-meta">
            ${this.formatSchedule(job.schedule)}
            ${job.state.lastError ? html` · <span style="color:#ef4444">${job.state.lastError.slice(0, 60)}</span>` : ""}
          </div>
        </div>
      </div>
    `;
  }

  private formatSchedule(schedule: CronJob["schedule"]): string {
    if (schedule.kind === "cron") return schedule.expr || "cron";
    if (schedule.kind === "every") return `every ${this.formatMs(schedule.everyMs || 0)}`;
    if (schedule.kind === "at") return `at ${new Date(schedule.atMs || 0).toLocaleString()}`;
    return "unknown";
  }

  private formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 3_600_000)}h`;
  }
}
