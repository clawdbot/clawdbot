import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { CronJob, CronRpcClient, CronRunEntry } from "../services/rpc-client.js";

type PayloadForm = {
  kind: "systemEvent" | "agentTurn";
  text: string;
  message: string;
  model: string;
  deliver: boolean;
  channel: string;
  to: string;
  timeoutSeconds: string;
  thinking: string;
};

type ScheduleForm = {
  kind: "cron" | "every" | "at";
  cronExpr: string;
  cronTz: string;
  everyAmount: string;
  everyUnit: "seconds" | "minutes" | "hours" | "days";
  atDatetime: string;
  sessionTarget: "main" | "isolated";
};

@customElement("cron-job-detail")
export class CronJobDetail extends LitElement {
  static styles = css`
    :host {
      display: block;
    }
    
    .back-btn {
      background: none;
      border: none;
      color: #3b82f6;
      cursor: pointer;
      font-size: 0.875rem;
      padding: 0;
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .back-btn:hover {
      text-decoration: underline;
    }
    
    .header {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    
    h2 {
      margin: 0;
      font-size: 1.5rem;
      font-weight: 600;
    }
    
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.25rem 0.75rem;
      border-radius: 999px;
      font-size: 0.8125rem;
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
    
    .actions {
      display: flex;
      gap: 0.5rem;
      margin-left: auto;
    }
    
    .btn {
      padding: 0.5rem 1rem;
      border: 1px solid #3f3f46;
      background: transparent;
      color: #e4e4e7;
      cursor: pointer;
      border-radius: 0.375rem;
      font-size: 0.8125rem;
      transition: all 0.15s;
    }
    
    .btn:hover {
      background: #3f3f46;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn.primary {
      background: #2563eb;
      border-color: #2563eb;
      color: white;
    }
    .btn.primary:hover:not(:disabled) {
      background: #1d4ed8;
    }
    .btn.success {
      background: #16a34a;
      border-color: #16a34a;
      color: white;
    }
    .btn.success:hover:not(:disabled) {
      background: #15803d;
    }
    .btn.danger {
      color: #fca5a5;
    }
    .btn.danger:hover {
      background: #7f1d1d;
      border-color: #991b1b;
    }
    
    .toggle-container {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.5rem 1rem;
      border: 1px solid #3f3f46;
      border-radius: 0.375rem;
      background: transparent;
      transition: all 0.15s;
      cursor: pointer;
    }
    
    .toggle-container:hover {
      background: #27272a;
    }
    
    .toggle-label {
      font-size: 0.8125rem;
      color: #a1a1aa;
      user-select: none;
    }
    
    .toggle-switch {
      position: relative;
      width: 44px;
      height: 24px;
      background: #3f3f46;
      border-radius: 12px;
      cursor: pointer;
      transition: background-color 0.2s;
    }
    
    .toggle-switch.on {
      background: #22c55e;
    }
    
    .toggle-slider {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 20px;
      height: 20px;
      background: white;
      border-radius: 50%;
      transition: transform 0.2s;
    }
    
    .toggle-switch.on .toggle-slider {
      transform: translateX(20px);
    }
    
    .grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 1rem;
      margin-bottom: 2rem;
    }
    
    @media (max-width: 768px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
    
    .card {
      background: #27272a;
      border: 1px solid #3f3f46;
      border-radius: 0.75rem;
      padding: 1.25rem;
    }
    
    .card.full-width {
      grid-column: 1 / -1;
    }
    
    .card h3 {
      font-size: 0.8125rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #71717a;
      margin: 0 0 1rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    
    .field {
      margin-bottom: 0.75rem;
    }
    .field:last-child {
      margin-bottom: 0;
    }
    .field-label {
      font-size: 0.75rem;
      color: #71717a;
      margin-bottom: 0.25rem;
    }
    .field-value {
      font-size: 0.875rem;
    }
    .field-value.mono {
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 0.8125rem;
      background: #18181b;
      padding: 0.375rem 0.5rem;
      border-radius: 0.25rem;
    }
    
    .error-text {
      color: #fca5a5;
    }
    
    /* Edit Form Styles */
    .edit-form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    
    .form-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
    }
    
    .form-field {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
    }
    
    .form-field.full-width {
      grid-column: 1 / -1;
    }
    
    .form-label {
      font-size: 0.75rem;
      color: #a1a1aa;
      font-weight: 500;
    }
    
    .form-input,
    .form-select,
    .form-textarea {
      padding: 0.5rem 0.75rem;
      background: #18181b;
      border: 1px solid #3f3f46;
      border-radius: 0.375rem;
      color: #e4e4e7;
      font-size: 0.8125rem;
      font-family: inherit;
      transition: border-color 0.15s;
    }
    
    .form-input:focus,
    .form-select:focus,
    .form-textarea:focus {
      outline: none;
      border-color: #3b82f6;
    }
    
    .form-textarea {
      min-height: 100px;
      resize: vertical;
      font-family: "SF Mono", "Fira Code", monospace;
    }
    
    .form-select {
      cursor: pointer;
    }
    
    .form-checkbox-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .form-checkbox {
      width: 16px;
      height: 16px;
      accent-color: #3b82f6;
    }
    
    .form-hint {
      font-size: 0.6875rem;
      color: #71717a;
      margin-top: 0.25rem;
    }
    
    .form-actions {
      display: flex;
      gap: 0.5rem;
      margin-top: 0.5rem;
      padding-top: 1rem;
      border-top: 1px solid #3f3f46;
    }
    
    .form-error {
      color: #fca5a5;
      font-size: 0.75rem;
      padding: 0.5rem;
      background: rgba(239, 68, 68, 0.1);
      border-radius: 0.25rem;
    }
    
    /* Log Viewer Styles */
    .log-viewer {
      margin-top: 2rem;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 0.5rem;
      overflow: hidden;
    }
    
    .log-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      background: #161b22;
      border-bottom: 1px solid #30363d;
    }
    
    .log-title {
      font-size: 0.875rem;
      font-weight: 600;
      color: #e6edf3;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .log-count {
      font-size: 0.75rem;
      color: #7d8590;
      background: #30363d;
      padding: 0.125rem 0.5rem;
      border-radius: 999px;
    }
    
    .log-entries {
      max-height: 600px;
      overflow-y: auto;
    }
    
    .log-entry {
      border-bottom: 1px solid #21262d;
      transition: background 0.1s;
    }
    
    .log-entry:last-child {
      border-bottom: none;
    }
    .log-entry:hover {
      background: #161b22;
    }
    .log-entry.expanded {
      background: #161b22;
    }
    
    .log-entry-header {
      display: grid;
      grid-template-columns: 100px 1fr auto auto;
      gap: 1rem;
      padding: 0.625rem 1rem;
      cursor: pointer;
      align-items: center;
      font-size: 0.8125rem;
    }
    
    .log-timestamp {
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 0.75rem;
      color: #7d8590;
    }
    
    .log-message {
      color: #e6edf3;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .log-duration {
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 0.75rem;
      color: #7d8590;
    }
    
    .log-status {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.125rem 0.5rem;
      border-radius: 999px;
      font-size: 0.6875rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.025em;
    }
    
    .log-status.ok {
      background: rgba(35, 134, 54, 0.2);
      color: #3fb950;
    }
    
    .log-status.error {
      background: rgba(248, 81, 73, 0.2);
      color: #f85149;
    }
    
    .log-status.skipped {
      background: rgba(210, 153, 34, 0.2);
      color: #d29922;
    }
    
    .log-status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    
    .log-expand-icon {
      color: #7d8590;
      font-size: 0.625rem;
      transition: transform 0.15s;
      margin-right: 0.5rem;
    }
    
    .log-entry.expanded .log-expand-icon {
      transform: rotate(90deg);
    }
    
    .log-detail {
      border-top: 1px solid #21262d;
      background: #0d1117;
    }
    
    .log-output {
      position: relative;
    }
    
    .log-output-content {
      padding: 1rem;
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 0.75rem;
      line-height: 1.6;
      color: #e6edf3;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 400px;
      overflow-y: auto;
      background: #0d1117;
    }
    
    /* Scrollbar styles */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    ::-webkit-scrollbar-track {
      background: #161b22;
    }
    ::-webkit-scrollbar-thumb {
      background: #30363d;
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: #484f58;
    }
    
    .log-entries::-webkit-scrollbar-track {
      background: #0d1117;
    }
    .form-textarea::-webkit-scrollbar-track {
      background: #18181b;
    }
    
    .log-copy-btn {
      position: absolute;
      top: 0.5rem;
      right: 0.5rem;
      padding: 0.375rem 0.625rem;
      font-size: 0.6875rem;
      background: #21262d;
      border: 1px solid #30363d;
      color: #7d8590;
      border-radius: 0.25rem;
      cursor: pointer;
      transition: all 0.15s;
    }
    
    .log-copy-btn:hover {
      background: #30363d;
      color: #e6edf3;
    }
    
    .log-metadata {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      padding: 1rem;
      background: #161b22;
    }
    
    .log-meta-item {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    
    .log-meta-label {
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #7d8590;
    }
    
    .log-meta-value {
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 0.75rem;
      color: #e6edf3;
      word-break: break-all;
    }
    
    .log-meta-value.error {
      color: #f85149;
    }
    
    .empty {
      color: #7d8590;
      text-align: center;
      padding: 3rem;
      font-size: 0.875rem;
    }
  `;

  @property({ type: Object }) job: CronJob | undefined;
  @property({ type: Object }) client: CronRpcClient | undefined;
  @state() private runs: CronRunEntry[] = [];
  @state() private loadingRuns = false;
  @state() private expandedRuns = new Set<string>();
  @state() private isEditingPayload = false;
  @state() private isEditingSchedule = false;
  @state() private isSaving = false;
  @state() private editError: string | null = null;
  @state() private payloadForm: PayloadForm = this.getDefaultPayloadForm();
  @state() private scheduleForm: ScheduleForm = this.getDefaultScheduleForm();
  private currentJobId: string | null = null;

  private getDefaultPayloadForm(): PayloadForm {
    return {
      kind: "agentTurn",
      text: "",
      message: "",
      model: "",
      deliver: false,
      channel: "last",
      to: "",
      timeoutSeconds: "",
      thinking: "",
    };
  }

  private getDefaultScheduleForm(): ScheduleForm {
    return {
      kind: "cron",
      cronExpr: "",
      cronTz: "",
      everyAmount: "",
      everyUnit: "minutes",
      atDatetime: "",
      sessionTarget: "main",
    };
  }

  async connectedCallback() {
    super.connectedCallback();
    if (this.job && this.client) {
      this.currentJobId = this.job.id;
      void this.loadRuns();
    }
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("job") && this.job && this.client && this.job.id !== this.currentJobId) {
      this.currentJobId = this.job.id;
      this.expandedRuns.clear();
      this.isEditingPayload = false;
      this.isEditingSchedule = false;
      void this.loadRuns();
    }
  }

  private async loadRuns() {
    if (!this.job || !this.client) return;
    this.loadingRuns = true;
    try {
      this.runs = await this.client.runs(this.job.id, 25);
    } catch {
      this.runs = [];
    } finally {
      this.loadingRuns = false;
    }
  }

  private emit(name: string, detail: Record<string, unknown>) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private startEditingPayload() {
    if (!this.job) return;
    const p = this.job.payload;
    this.payloadForm = {
      kind: p.kind,
      text: p.kind === "systemEvent" ? p.text || "" : "",
      message: p.kind === "agentTurn" ? p.message || "" : "",
      model: p.kind === "agentTurn" ? p.model || "" : "",
      deliver: p.kind === "agentTurn" ? p.deliver === true : false,
      channel: p.kind === "agentTurn" ? p.channel || "last" : "last",
      to: p.kind === "agentTurn" ? p.to || "" : "",
      timeoutSeconds: p.kind === "agentTurn" && p.timeoutSeconds ? String(p.timeoutSeconds) : "",
      thinking: p.kind === "agentTurn" ? p.thinking || "" : "",
    };
    this.isEditingPayload = true;
    this.editError = null;
  }

  private cancelEditingPayload() {
    this.isEditingPayload = false;
    this.editError = null;
  }

  private startEditingSchedule() {
    if (!this.job) return;
    const s = this.job.schedule;

    // Convert everyMs to amount + unit
    let everyAmount = "";
    let everyUnit: ScheduleForm["everyUnit"] = "minutes";
    if (s.kind === "every" && s.everyMs) {
      const ms = s.everyMs;
      if (ms >= 86400000 && ms % 86400000 === 0) {
        everyAmount = String(ms / 86400000);
        everyUnit = "days";
      } else if (ms >= 3600000 && ms % 3600000 === 0) {
        everyAmount = String(ms / 3600000);
        everyUnit = "hours";
      } else if (ms >= 60000 && ms % 60000 === 0) {
        everyAmount = String(ms / 60000);
        everyUnit = "minutes";
      } else {
        everyAmount = String(ms / 1000);
        everyUnit = "seconds";
      }
    }

    // Format atMs for datetime-local input
    let atDatetime = "";
    if (s.kind === "at" && s.atMs) {
      const d = new Date(s.atMs);
      atDatetime = d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
    }

    this.scheduleForm = {
      kind: s.kind,
      cronExpr: s.kind === "cron" ? s.expr || "" : "",
      cronTz: s.kind === "cron" ? s.tz || "" : "",
      everyAmount,
      everyUnit,
      atDatetime,
      sessionTarget: this.job.sessionTarget || "main",
    };
    this.isEditingSchedule = true;
    this.editError = null;
  }

  private cancelEditingSchedule() {
    this.isEditingSchedule = false;
    this.editError = null;
  }

  private async savePayload() {
    if (!this.job || !this.client) return;

    this.isSaving = true;
    this.editError = null;

    try {
      const payload: Record<string, unknown> = { kind: this.payloadForm.kind };

      if (this.payloadForm.kind === "systemEvent") {
        if (!this.payloadForm.text.trim()) {
          throw new Error("System event text is required");
        }
        payload.text = this.payloadForm.text.trim();
      } else {
        if (!this.payloadForm.message.trim()) {
          throw new Error("Message is required");
        }
        payload.message = this.payloadForm.message.trim();
        if (this.payloadForm.model.trim()) {
          payload.model = this.payloadForm.model.trim();
        }
        if (this.payloadForm.deliver) {
          payload.deliver = true;
        }
        if (this.payloadForm.channel && this.payloadForm.channel !== "last") {
          payload.channel = this.payloadForm.channel;
        }
        if (this.payloadForm.to.trim()) {
          payload.to = this.payloadForm.to.trim();
        }
        if (this.payloadForm.timeoutSeconds.trim()) {
          const timeout = parseInt(this.payloadForm.timeoutSeconds, 10);
          if (!isNaN(timeout) && timeout > 0) {
            payload.timeoutSeconds = timeout;
          }
        }
        if (this.payloadForm.thinking.trim()) {
          payload.thinking = this.payloadForm.thinking.trim();
        }
      }

      await this.client.update(this.job.id, { payload: payload as CronJob["payload"] });
      this.isEditingPayload = false;

      // Emit event to trigger refresh in parent
      this.emit("job-updated", { id: this.job.id });
    } catch (err) {
      this.editError = err instanceof Error ? err.message : "Failed to save";
    } finally {
      this.isSaving = false;
    }
  }

  private async saveSchedule() {
    if (!this.job || !this.client) return;

    this.isSaving = true;
    this.editError = null;

    try {
      const schedule: Record<string, unknown> = { kind: this.scheduleForm.kind };

      if (this.scheduleForm.kind === "cron") {
        if (!this.scheduleForm.cronExpr.trim()) {
          throw new Error("Cron expression is required");
        }
        schedule.expr = this.scheduleForm.cronExpr.trim();
        if (this.scheduleForm.cronTz.trim()) {
          schedule.tz = this.scheduleForm.cronTz.trim();
        }
      } else if (this.scheduleForm.kind === "every") {
        const amount = parseInt(this.scheduleForm.everyAmount, 10);
        if (isNaN(amount) || amount <= 0) {
          throw new Error("Interval amount must be a positive number");
        }
        const multipliers: Record<string, number> = {
          seconds: 1000,
          minutes: 60000,
          hours: 3600000,
          days: 86400000,
        };
        schedule.everyMs = amount * multipliers[this.scheduleForm.everyUnit];
      } else if (this.scheduleForm.kind === "at") {
        if (!this.scheduleForm.atDatetime) {
          throw new Error("Date/time is required for one-shot schedule");
        }
        const atMs = new Date(this.scheduleForm.atDatetime).getTime();
        if (isNaN(atMs)) {
          throw new Error("Invalid date/time");
        }
        schedule.atMs = atMs;
      }

      await this.client.update(this.job.id, {
        schedule: schedule as CronJob["schedule"],
        sessionTarget: this.scheduleForm.sessionTarget,
      });
      this.isEditingSchedule = false;

      // Emit event to trigger refresh in parent
      this.emit("job-updated", { id: this.job.id });
    } catch (err) {
      this.editError = err instanceof Error ? err.message : "Failed to save";
    } finally {
      this.isSaving = false;
    }
  }

  render() {
    if (!this.job)
      return html`
        <div class="empty">Job not found</div>
      `;
    const j = this.job;
    const running = typeof j.state.runningAtMs === "number";
    const statusClass = !j.enabled
      ? "disabled"
      : running
        ? "running"
        : j.state.lastStatus || "disabled";

    return html`
      <button class="back-btn" @click=${() => this.emit("back", {})}>← Back to Jobs</button>

      <div class="header">
        <h2>${j.name || j.id.slice(0, 8)}</h2>
        <span class="status-badge ${statusClass}">
          ${!j.enabled ? "Disabled" : running ? "Running" : j.state.lastStatus || "Pending"}
        </span>
        <div class="actions">
          <button class="btn primary" @click=${() => this.emit("run-job", { id: j.id })}>▶ Run Now</button>
          <div class="toggle-container" @click=${() => this.emit("toggle-job", { id: j.id, enabled: !j.enabled })}>
            <span class="toggle-label">${j.enabled ? "Enabled" : "Disabled"}</span>
            <div class="toggle-switch ${j.enabled ? "on" : ""}">
              <div class="toggle-slider"></div>
            </div>
          </div>
          <button class="btn danger" @click=${() => this.emit("delete-job", { id: j.id })}>Delete</button>
        </div>
      </div>

      <div class="grid">
        <div class="card">
          <h3>
            Configuration
            ${
              !this.isEditingSchedule
                ? html`
              <button class="btn" @click=${() => this.startEditingSchedule()}>Edit Schedule</button>
            `
                : ""
            }
          </h3>
          ${
            this.isEditingSchedule
              ? this.renderScheduleForm()
              : html`
            <div class="field">
              <div class="field-label">ID</div>
              <div class="field-value mono">${j.id}</div>
            </div>
            <div class="field">
              <div class="field-label">Schedule</div>
              <div class="field-value mono">${this.formatScheduleFull(j.schedule)}</div>
            </div>
            <div class="field">
              <div class="field-label">Session Target</div>
              <div class="field-value">${j.sessionTarget}</div>
            </div>
            ${
              j.description
                ? html`
              <div class="field">
                <div class="field-label">Description</div>
                <div class="field-value">${j.description}</div>
              </div>
            `
                : ""
            }
          `
          }
        </div>

        <div class="card">
          <h3>State</h3>
          <div class="field">
            <div class="field-label">Next Run</div>
            <div class="field-value">${j.state.nextRunAtMs ? new Date(j.state.nextRunAtMs).toLocaleString() : "—"}</div>
          </div>
          <div class="field">
            <div class="field-label">Last Run</div>
            <div class="field-value">${j.state.lastRunAtMs ? new Date(j.state.lastRunAtMs).toLocaleString() : "Never"}</div>
          </div>
          <div class="field">
            <div class="field-label">Last Duration</div>
            <div class="field-value">${j.state.lastDurationMs != null ? `${(j.state.lastDurationMs / 1000).toFixed(1)}s` : "—"}</div>
          </div>
          <div class="field">
            <div class="field-label">Last Status</div>
            <div class="field-value">${j.state.lastStatus || "—"}</div>
          </div>
          ${
            j.state.lastError
              ? html`
            <div class="field">
              <div class="field-label">Last Error</div>
              <div class="field-value error-text">${j.state.lastError}</div>
            </div>
          `
              : ""
          }
          <div class="field">
            <div class="field-label">Created</div>
            <div class="field-value">${new Date(j.createdAtMs).toLocaleString()}</div>
          </div>
        </div>

        <div class="card full-width">
          <h3>
            Payload
            ${
              !this.isEditingPayload
                ? html`
              <button class="btn" @click=${() => this.startEditingPayload()}>Edit</button>
            `
                : ""
            }
          </h3>
          ${this.isEditingPayload ? this.renderPayloadForm() : this.renderPayloadDisplay()}
        </div>
      </div>

      <div class="log-viewer">
        <div class="log-header">
          <div class="log-title">
            <span>Run History</span>
            <span class="log-count">${this.runs.length} runs</span>
          </div>
        </div>
        <div class="log-entries">
          ${
            this.loadingRuns
              ? html`
                  <div class="empty">Loading runs...</div>
                `
              : this.runs.length === 0
                ? html`
                    <div class="empty">No runs yet</div>
                  `
                : this.runs.map((r, i) => this.renderLogEntry(r, i))
          }
        </div>
      </div>
    `;
  }

  private renderPayloadDisplay() {
    if (!this.job) return "";
    const p = this.job.payload;

    if (p.kind === "systemEvent") {
      return html`
        <div class="field">
          <div class="field-label">Type</div>
          <div class="field-value">System Event</div>
        </div>
        <div class="field">
          <div class="field-label">Text</div>
          <div class="field-value mono">${p.text || "—"}</div>
        </div>
      `;
    }

    return html`
      <div class="field">
        <div class="field-label">Type</div>
        <div class="field-value">Agent Turn</div>
      </div>
      <div class="field">
        <div class="field-label">Message</div>
        <div class="field-value mono">${p.message || "—"}</div>
      </div>
      ${
        p.model
          ? html`
        <div class="field">
          <div class="field-label">Model</div>
          <div class="field-value mono">${p.model}</div>
        </div>
      `
          : ""
      }
      ${
        p.thinking
          ? html`
        <div class="field">
          <div class="field-label">Thinking</div>
          <div class="field-value mono">${p.thinking}</div>
        </div>
      `
          : ""
      }
      ${
        p.deliver
          ? html`
        <div class="field">
          <div class="field-label">Deliver</div>
          <div class="field-value">Yes${p.channel ? ` via ${p.channel}` : ""}${p.to ? ` to ${p.to}` : ""}</div>
        </div>
      `
          : ""
      }
      ${
        p.timeoutSeconds
          ? html`
        <div class="field">
          <div class="field-label">Timeout</div>
          <div class="field-value">${p.timeoutSeconds}s</div>
        </div>
      `
          : ""
      }
    `;
  }

  private renderPayloadForm() {
    const isAgentTurn = this.payloadForm.kind === "agentTurn";

    return html`
      <div class="edit-form">
        ${this.editError ? html`<div class="form-error">${this.editError}</div>` : ""}

        <div class="form-row">
          <div class="form-field">
            <label class="form-label">Type</label>
            <select
              class="form-select"
              .value=${this.payloadForm.kind}
              @change=${(e: Event) => (this.payloadForm = { ...this.payloadForm, kind: (e.target as HTMLSelectElement).value as "systemEvent" | "agentTurn" })}
            >
              <option value="agentTurn">Agent Turn</option>
              <option value="systemEvent">System Event</option>
            </select>
            <div class="form-hint">${
              this.payloadForm.kind === "agentTurn"
                ? "Sends a message to the agent and gets a response"
                : "Injects context into the session without triggering a response"
            }</div>
          </div>

          ${
            isAgentTurn
              ? html`
            <div class="form-field">
              <label class="form-label">Model</label>
              <input
                type="text"
                class="form-input"
                placeholder="haiku, sonnet, opus, or provider/model"
                .value=${this.payloadForm.model}
                @input=${(e: Event) => (this.payloadForm = { ...this.payloadForm, model: (e.target as HTMLInputElement).value })}
              />
              <div class="form-hint">Leave empty for default model</div>
            </div>

            <div class="form-field">
              <label class="form-label">Thinking</label>
              <select
                class="form-select"
                .value=${this.payloadForm.thinking}
                @change=${(e: Event) => (this.payloadForm = { ...this.payloadForm, thinking: (e.target as HTMLSelectElement).value })}
              >
                <option value="">Default</option>
                <option value="off">Off</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
          `
              : ""
          }
        </div>

        <div class="form-field full-width">
          <label class="form-label">${isAgentTurn ? "Message" : "System Event Text"}</label>
          <textarea
            class="form-textarea"
            placeholder="${isAgentTurn ? "Enter the message for the agent..." : "Enter the system event text..."}"
            .value=${isAgentTurn ? this.payloadForm.message : this.payloadForm.text}
            @input=${(e: Event) => {
              const value = (e.target as HTMLTextAreaElement).value;
              if (isAgentTurn) {
                this.payloadForm = { ...this.payloadForm, message: value };
              } else {
                this.payloadForm = { ...this.payloadForm, text: value };
              }
            }}
          ></textarea>
        </div>

        ${
          isAgentTurn
            ? html`
          <div class="form-row">
            <div class="form-field">
              <div class="form-checkbox-row">
                <input
                  type="checkbox"
                  class="form-checkbox"
                  id="deliver-checkbox"
                  .checked=${this.payloadForm.deliver}
                  @change=${(e: Event) => (this.payloadForm = { ...this.payloadForm, deliver: (e.target as HTMLInputElement).checked })}
                />
                <label for="deliver-checkbox" class="form-label" style="margin: 0;">Deliver response</label>
              </div>
              <div class="form-hint">Send the agent's response to a channel</div>
            </div>

            ${
              this.payloadForm.deliver
                ? html`
              <div class="form-field">
                <label class="form-label">Channel</label>
                <input
                  type="text"
                  class="form-input"
                  placeholder="last, telegram, whatsapp, etc."
                  .value=${this.payloadForm.channel}
                  @input=${(e: Event) => (this.payloadForm = { ...this.payloadForm, channel: (e.target as HTMLInputElement).value })}
                />
              </div>

              <div class="form-field">
                <label class="form-label">To</label>
                <input
                  type="text"
                  class="form-input"
                  placeholder="+1555... or chat ID"
                  .value=${this.payloadForm.to}
                  @input=${(e: Event) => (this.payloadForm = { ...this.payloadForm, to: (e.target as HTMLInputElement).value })}
                />
              </div>
            `
                : ""
            }

            <div class="form-field">
              <label class="form-label">Timeout (seconds)</label>
              <input
                type="number"
                class="form-input"
                placeholder="300"
                .value=${this.payloadForm.timeoutSeconds}
                @input=${(e: Event) => (this.payloadForm = { ...this.payloadForm, timeoutSeconds: (e.target as HTMLInputElement).value })}
              />
            </div>
          </div>
        `
            : ""
        }

        <div class="form-actions">
          <button class="btn success" ?disabled=${this.isSaving} @click=${() => this.savePayload()}>
            ${this.isSaving ? "Saving..." : "Save Payload"}
          </button>
          <button class="btn" ?disabled=${this.isSaving} @click=${() => this.cancelEditingPayload()}>
            Cancel
          </button>
        </div>
      </div>
    `;
  }

  private renderScheduleForm() {
    return html`
      <div class="edit-form">
        ${this.editError ? html`<div class="form-error">${this.editError}</div>` : ""}

        <div class="form-row">
          <div class="form-field">
            <label class="form-label">Schedule Type</label>
            <select
              class="form-select"
              .value=${this.scheduleForm.kind}
              @change=${(e: Event) => (this.scheduleForm = { ...this.scheduleForm, kind: (e.target as HTMLSelectElement).value as "cron" | "every" | "at" })}
            >
              <option value="cron">Cron Expression</option>
              <option value="every">Interval</option>
              <option value="at">One-shot (at specific time)</option>
            </select>
          </div>

          <div class="form-field">
            <label class="form-label">Session Target</label>
            <select
              class="form-select"
              .value=${this.scheduleForm.sessionTarget}
              @change=${(e: Event) => (this.scheduleForm = { ...this.scheduleForm, sessionTarget: (e.target as HTMLSelectElement).value as "main" | "isolated" })}
            >
              <option value="main">Main Session</option>
              <option value="isolated">Isolated Session</option>
            </select>
            <div class="form-hint">${
              this.scheduleForm.sessionTarget === "main"
                ? "Runs in main session with full conversation history and context"
                : "Runs in a fresh session without prior context (fire-and-forget)"
            }</div>
          </div>
        </div>

        ${
          this.scheduleForm.kind === "cron"
            ? html`
          <div class="form-row">
            <div class="form-field">
              <label class="form-label">Cron Expression</label>
              <input
                type="text"
                class="form-input"
                placeholder="0 9 * * *"
                .value=${this.scheduleForm.cronExpr}
                @input=${(e: Event) => (this.scheduleForm = { ...this.scheduleForm, cronExpr: (e.target as HTMLInputElement).value })}
              />
              <div class="form-hint">Standard cron format: minute hour day month weekday</div>
            </div>
            <div class="form-field">
              <label class="form-label">Timezone</label>
              <input
                type="text"
                class="form-input"
                placeholder="America/New_York"
                .value=${this.scheduleForm.cronTz}
                @input=${(e: Event) => (this.scheduleForm = { ...this.scheduleForm, cronTz: (e.target as HTMLInputElement).value })}
              />
              <div class="form-hint">Leave empty for system timezone</div>
            </div>
          </div>
        `
            : ""
        }

        ${
          this.scheduleForm.kind === "every"
            ? html`
          <div class="form-row">
            <div class="form-field">
              <label class="form-label">Run every</label>
              <input
                type="number"
                class="form-input"
                min="1"
                placeholder="30"
                .value=${this.scheduleForm.everyAmount}
                @input=${(e: Event) => (this.scheduleForm = { ...this.scheduleForm, everyAmount: (e.target as HTMLInputElement).value })}
              />
            </div>
            <div class="form-field">
              <label class="form-label">Unit</label>
              <select
                class="form-select"
                .value=${this.scheduleForm.everyUnit}
                @change=${(e: Event) => (this.scheduleForm = { ...this.scheduleForm, everyUnit: (e.target as HTMLSelectElement).value as "seconds" | "minutes" | "hours" | "days" })}
              >
                <option value="seconds">Seconds</option>
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </select>
            </div>
          </div>
        `
            : ""
        }

        ${
          this.scheduleForm.kind === "at"
            ? html`
          <div class="form-field">
            <label class="form-label">Run at</label>
            <input
              type="datetime-local"
              class="form-input"
              .value=${this.scheduleForm.atDatetime}
              @input=${(e: Event) => (this.scheduleForm = { ...this.scheduleForm, atDatetime: (e.target as HTMLInputElement).value })}
            />
            <div class="form-hint">Job will run once at this time and then be removed</div>
          </div>
        `
            : ""
        }

        <div class="form-actions">
          <button class="btn success" ?disabled=${this.isSaving} @click=${() => this.saveSchedule()}>
            ${this.isSaving ? "Saving..." : "Save Schedule"}
          </button>
          <button class="btn" ?disabled=${this.isSaving} @click=${() => this.cancelEditingSchedule()}>
            Cancel
          </button>
        </div>
      </div>
    `;
  }

  private renderLogEntry(run: CronRunEntry) {
    const runKey = `${run.ts}`;
    const isExpanded = this.expandedRuns.has(runKey);
    const output = run.outputText || run.summary || "";
    const truncatedMessage =
      (run.summary || output || "—").slice(0, 80) +
      ((run.summary || output || "").length > 80 ? "…" : "");

    return html`
      <div class="log-entry ${isExpanded ? "expanded" : ""}">
        <div class="log-entry-header" @click=${() => this.toggleRunExpand(runKey)}>
          <div class="log-timestamp">
            <span class="log-expand-icon">▶</span>
            ${this.formatRelativeTime(run.ts)}
          </div>
          <div class="log-message">${truncatedMessage}</div>
          <div class="log-duration">${run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : "—"}</div>
          <div class="log-status ${run.status || ""}">
            <span class="log-status-dot"></span>
            ${run.status || "unknown"}
          </div>
        </div>
        ${isExpanded ? this.renderLogDetail(run) : ""}
      </div>
    `;
  }

  private renderLogDetail(run: CronRunEntry) {
    const output = run.outputText || run.summary || "";

    return html`
      <div class="log-detail">
        <div class="log-metadata">
          <div class="log-meta-item">
            <div class="log-meta-label">Timestamp</div>
            <div class="log-meta-value">${new Date(run.ts).toISOString()}</div>
          </div>
          <div class="log-meta-item">
            <div class="log-meta-label">Duration</div>
            <div class="log-meta-value">${run.durationMs != null ? `${run.durationMs}ms` : "—"}</div>
          </div>
          <div class="log-meta-item">
            <div class="log-meta-label">Status</div>
            <div class="log-meta-value">${run.status || "—"}</div>
          </div>
          <div class="log-meta-item">
            <div class="log-meta-label">Job ID</div>
            <div class="log-meta-value">${run.jobId}</div>
          </div>
          ${
            run.error
              ? html`
            <div class="log-meta-item" style="grid-column: 1 / -1;">
              <div class="log-meta-label">Error</div>
              <div class="log-meta-value error">${run.error}</div>
            </div>
          `
              : ""
          }
        </div>
        ${
          output
            ? html`
          <div class="log-output">
            <button class="log-copy-btn" @click=${() => this.copyToClipboard(output)}>Copy</button>
            <div class="log-output-content">${output}</div>
          </div>
        `
            : ""
        }
      </div>
    `;
  }

  private formatRelativeTime(ts: number): string {
    const now = Date.now();
    const diff = now - ts;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    if (seconds > 0) return `${seconds}s ago`;
    return "now";
  }

  private async copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
  }

  private toggleRunExpand(runKey: string) {
    if (this.expandedRuns.has(runKey)) {
      this.expandedRuns.delete(runKey);
    } else {
      this.expandedRuns.add(runKey);
    }
    this.requestUpdate();
  }

  private formatScheduleFull(s: CronJob["schedule"]): string {
    if (s.kind === "cron") return `cron: ${s.expr}${s.tz ? ` (${s.tz})` : ""}`;
    if (s.kind === "every") {
      const ms = s.everyMs || 0;
      if (ms < 60_000) return `every ${ms / 1000}s`;
      if (ms < 3_600_000) return `every ${ms / 60_000}m`;
      return `every ${(ms / 3_600_000).toFixed(1)}h`;
    }
    if (s.kind === "at") return `one-shot: ${new Date(s.atMs || 0).toLocaleString()}`;
    return "unknown";
  }
}
