import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  getCronRpcClient,
  type CronJob,
  type QueueStatus,
  type CronEvent,
} from "../services/rpc-client.js";

import "./cron-dashboard.js";
import "./cron-job-list.js";
import "./cron-job-detail.js";

type View = "dashboard" | "jobs" | "job-detail";

@customElement("cron-app")
export class CronApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #e4e4e7;
      background: #18181b;
      min-height: 100vh;
    }
    
    .header {
      background: #27272a;
      border-bottom: 1px solid #3f3f46;
      padding: 1rem 1.5rem;
      display: flex;
      align-items: center;
      gap: 2rem;
    }
    
    .logo {
      font-size: 1.25rem;
      font-weight: 600;
      color: #fafafa;
    }
    
    .nav {
      display: flex;
      gap: 0.5rem;
    }
    
    .nav-btn {
      padding: 0.5rem 1rem;
      border: none;
      background: transparent;
      color: #a1a1aa;
      cursor: pointer;
      border-radius: 0.375rem;
      font-size: 0.875rem;
      transition: all 0.15s;
    }
    
    .nav-btn:hover {
      background: #3f3f46;
      color: #fafafa;
    }
    
    .nav-btn.active {
      background: #3b82f6;
      color: white;
    }
    
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-left: auto;
    }
    
    .status-dot.connected {
      background: #22c55e;
    }
    
    .status-dot.disconnected {
      background: #ef4444;
    }
    
    .content {
      padding: 1.5rem;
      max-width: 1400px;
      margin: 0 auto;
    }
    
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 200px;
      color: #71717a;
    }
    
    .error {
      background: #7f1d1d;
      color: #fecaca;
      padding: 1rem;
      border-radius: 0.5rem;
      margin-bottom: 1rem;
    }
  `;

  @state() private view: View = "dashboard";
  @state() private jobs: CronJob[] = [];
  @state() private status: QueueStatus | null = null;
  @state() private selectedJobId: string | null = null;
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private connected = false;

  private client = getCronRpcClient();
  private unsubscribe: (() => void) | null = null;

  async connectedCallback() {
    super.connectedCallback();
    await this.connect();
    this.unsubscribe = this.client.onCronEvent((evt) => this.handleCronEvent(evt));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribe?.();
  }

  private async connect() {
    try {
      await this.client.connect();
      this.connected = true;
      await this.refresh();
    } catch {
      this.error = "Failed to connect to gateway";
      this.connected = false;
    }
  }

  private async refresh() {
    this.loading = true;
    this.error = null;
    try {
      const [jobs, status] = await Promise.all([
        this.client.list({ includeDisabled: true }),
        this.client.status(),
      ]);
      this.jobs = jobs;
      this.status = status;
    } catch (e) {
      this.error = e instanceof Error ? e.message : "Failed to load data";
    } finally {
      this.loading = false;
    }
  }

  private async handleCronEvent(evt: CronEvent) {
    const idx = this.jobs.findIndex((j) => j.id === evt.jobId);

    if (evt.action === "removed" && idx >= 0) {
      this.jobs = [...this.jobs.slice(0, idx), ...this.jobs.slice(idx + 1)];
      return;
    }

    if (evt.action === "added") {
      // Fetch the new job and add it
      try {
        const jobs = await this.client.list({ includeDisabled: true });
        const newJob = jobs.find((j) => j.id === evt.jobId);
        if (newJob) {
          this.jobs = [...this.jobs, newJob];
        }
      } catch {
        // Fallback to full refresh
        void this.refresh();
      }
      return;
    }

    if (evt.action === "updated" || evt.action === "started" || evt.action === "finished") {
      // Update the specific job in place without full refresh
      if (idx >= 0) {
        try {
          const jobs = await this.client.list({ includeDisabled: true });
          const updatedJob = jobs.find((j) => j.id === evt.jobId);
          if (updatedJob) {
            // Update in place to minimize re-renders
            this.jobs = this.jobs.map((j, i) => (i === idx ? updatedJob : j));
          }
          // Also update status on finished events
          if (evt.action === "finished") {
            this.status = await this.client.status();
          }
        } catch {
          // Ignore errors, job will update on next event
        }
      }
    }
  }

  private navigate(view: View, jobId?: string) {
    this.view = view;
    this.selectedJobId = jobId || null;
  }

  private handleRunJob = async (e: CustomEvent<{ id: string }>) => {
    try {
      await this.client.run(e.detail.id, "force");
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Failed to run job";
    }
  };

  private handleToggleJob = async (e: CustomEvent<{ id: string; enabled: boolean }>) => {
    try {
      await this.client.update(e.detail.id, { enabled: e.detail.enabled });
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Failed to update job";
    }
  };

  private handleDeleteJob = async (e: CustomEvent<{ id: string }>) => {
    if (!confirm("Delete this job?")) return;
    try {
      await this.client.remove(e.detail.id);
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Failed to delete job";
    }
  };

  private handleJobUpdated = async (e: CustomEvent<{ id: string }>) => {
    // Refresh the specific job after an update
    try {
      const jobs = await this.client.list({ includeDisabled: true });
      const updatedJob = jobs.find((j) => j.id === e.detail.id);
      if (updatedJob) {
        const idx = this.jobs.findIndex((j) => j.id === e.detail.id);
        if (idx >= 0) {
          this.jobs = this.jobs.map((j, i) => (i === idx ? updatedJob : j));
        }
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Failed to refresh job";
    }
  };

  render() {
    return html`
      <div class="header">
        <div class="logo">⚡ Cron Jobs</div>
        <nav class="nav">
          <button
            class="nav-btn ${this.view === "dashboard" ? "active" : ""}"
            @click=${() => this.navigate("dashboard")}
          >
            Dashboard
          </button>
          <button
            class="nav-btn ${this.view === "jobs" || this.view === "job-detail" ? "active" : ""}"
            @click=${() => this.navigate("jobs")}
          >
            Jobs
          </button>
        </nav>
        <div class="status-dot ${this.connected ? "connected" : "disconnected"}" title="${this.connected ? "Connected" : "Disconnected"}"></div>
      </div>

      <div class="content">
        ${this.error ? html`<div class="error">${this.error}</div>` : ""}
        ${
          this.loading
            ? html`
                <div class="loading">Loading...</div>
              `
            : this.renderView()
        }
      </div>
    `;
  }

  private renderView() {
    switch (this.view) {
      case "dashboard":
        return html`
          <cron-dashboard
            .status=${this.status}
            .jobs=${this.jobs}
          ></cron-dashboard>
        `;
      case "jobs":
        return html`
          <cron-job-list
            .jobs=${this.jobs}
            @select-job=${(e: CustomEvent) => this.navigate("job-detail", e.detail.id)}
            @run-job=${this.handleRunJob}
            @toggle-job=${this.handleToggleJob}
            @delete-job=${this.handleDeleteJob}
          ></cron-job-list>
        `;
      case "job-detail":
        const job = this.jobs.find((j) => j.id === this.selectedJobId);
        return html`
          <cron-job-detail
            .job=${job}
            .client=${this.client}
            @back=${() => this.navigate("jobs")}
            @run-job=${this.handleRunJob}
            @toggle-job=${this.handleToggleJob}
            @delete-job=${this.handleDeleteJob}
            @job-updated=${this.handleJobUpdated}
          ></cron-job-detail>
        `;
    }
  }
}
