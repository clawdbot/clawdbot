import { consume } from "@lit/context";
import { html, LitElement } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import {
  DEFAULT_LOG_LEVEL_FILTERS,
  parseLogLine,
  type LogEntry,
  type LogLevel,
} from "./log-lines.ts";
import { renderLogs } from "./view.ts";

const LOG_BUFFER_LIMIT = 2000;
const LOGS_POLL_INTERVAL_MS = 2000;

class LogsPage extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;

  @state() private client: GatewayBrowserClient | null = null;
  @state() private connected = false;
  @state() private logsLoading = false;
  @state() private logsError: string | null = null;
  @state() private logsFile: string | null = null;
  @state() private logsEntries: LogEntry[] = [];
  @state() private logsFilterText = "";
  @state() private logsLevelFilters: Record<LogLevel, boolean> = { ...DEFAULT_LOG_LEVEL_FILTERS };
  @state() private logsAutoFollow = true;
  @state() private logsTruncated = false;
  @state() private logsAtBottom = true;

  private logsCursor: number | null = null;
  private readonly logsLimit = 500;
  private readonly logsMaxBytes = 250_000;
  private logsPollInterval: ReturnType<typeof globalThis.setInterval> | null = null;
  private logsScrollFrame: number | null = null;
  private contentScrollFrame: number | null = null;
  private stopGatewaySubscription?: () => void;

  override connectedCallback() {
    super.connectedCallback();
    this.syncGatewayState();
    this.stopGatewaySubscription = this.context.gateway.subscribe((snapshot) => {
      const previousClient = this.client;
      this.syncGatewayState();
      if (previousClient !== snapshot.client) {
        this.resetServerState();
      }
      this.syncPolling();
      this.ensureInitialLogs();
    });
    this.logsAtBottom = true;
    this.syncPolling();
    this.ensureInitialLogs();
  }

  override firstUpdated() {
    this.resetContentScroll();
    this.contentScrollFrame = requestAnimationFrame(() => {
      this.contentScrollFrame = null;
      this.resetContentScroll();
    });
  }

  override updated(changed: Map<PropertyKey, unknown>) {
    if (
      this.logsAutoFollow &&
      this.logsAtBottom &&
      (changed.has("logsEntries") || changed.has("logsAutoFollow"))
    ) {
      this.scheduleScroll(changed.has("logsAutoFollow"));
    }
  }

  override disconnectedCallback() {
    this.stopPolling();
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
    if (this.logsScrollFrame !== null) {
      cancelAnimationFrame(this.logsScrollFrame);
      this.logsScrollFrame = null;
    }
    if (this.contentScrollFrame !== null) {
      cancelAnimationFrame(this.contentScrollFrame);
      this.contentScrollFrame = null;
    }
    super.disconnectedCallback();
  }

  private resetContentScroll() {
    const content = this.closest<HTMLElement>(".content");
    if (content) {
      content.scrollTop = 0;
      content.scrollLeft = 0;
    }
  }

  private syncGatewayState() {
    const gateway = this.context.gateway.snapshot;
    this.client = gateway.client;
    this.connected = gateway.connected;
  }

  private resetServerState() {
    this.logsLoading = false;
    this.logsError = null;
    this.logsFile = null;
    this.logsEntries = [];
    this.logsTruncated = false;
    this.logsCursor = null;
    this.logsAtBottom = true;
  }

  private syncPolling() {
    if (!this.connected || !this.client) {
      this.stopPolling();
      return;
    }
    if (this.logsPollInterval !== null) {
      return;
    }
    this.logsPollInterval = globalThis.setInterval(() => {
      void this.loadLogs({ quiet: true });
    }, LOGS_POLL_INTERVAL_MS);
  }

  private stopPolling() {
    if (this.logsPollInterval === null) {
      return;
    }
    globalThis.clearInterval(this.logsPollInterval);
    this.logsPollInterval = null;
  }

  private ensureInitialLogs() {
    if (!this.connected || !this.client || this.logsEntries.length > 0 || this.logsLoading) {
      return;
    }
    void this.loadLogs({ reset: true }).then(() => this.scheduleScroll(true));
  }

  private async loadLogs(opts?: { reset?: boolean; quiet?: boolean }) {
    const client = this.client;
    const quiet = opts?.quiet === true;
    if (!client || !this.connected || (this.logsLoading && !quiet)) {
      return;
    }
    if (!quiet) {
      this.logsLoading = true;
    }
    this.logsError = null;
    try {
      const res = await client.request("logs.tail", {
        cursor: opts?.reset ? undefined : (this.logsCursor ?? undefined),
        limit: this.logsLimit,
        maxBytes: this.logsMaxBytes,
      });
      if (this.client !== client) {
        return;
      }
      const payload = res as {
        file?: string;
        cursor?: number;
        lines?: unknown;
        truncated?: boolean;
        reset?: boolean;
      };
      const lines = Array.isArray(payload.lines)
        ? payload.lines.filter((line): line is string => typeof line === "string")
        : [];
      const entries = lines.map(parseLogLine);
      const shouldReset = opts?.reset || payload.reset || this.logsCursor == null;
      this.logsEntries = shouldReset
        ? entries
        : [...this.logsEntries, ...entries].slice(-LOG_BUFFER_LIMIT);
      this.logsCursor = typeof payload.cursor === "number" ? payload.cursor : this.logsCursor;
      this.logsFile = typeof payload.file === "string" ? payload.file : this.logsFile;
      this.logsTruncated = Boolean(payload.truncated);
    } catch (err) {
      if (this.client !== client) {
        return;
      }
      if (isMissingOperatorReadScopeError(err)) {
        this.logsEntries = [];
        this.logsError = formatMissingOperatorReadScopeMessage("logs");
      } else {
        this.logsError = String(err);
      }
    } finally {
      if (this.client === client && !quiet) {
        this.logsLoading = false;
      }
    }
  }

  private scheduleScroll(force = false) {
    if (this.logsScrollFrame !== null) {
      cancelAnimationFrame(this.logsScrollFrame);
    }
    void this.updateComplete.then(() => {
      this.logsScrollFrame = requestAnimationFrame(() => {
        this.logsScrollFrame = null;
        const container = this.querySelector(".log-stream") as HTMLElement | null;
        if (!container) {
          return;
        }
        const distanceFromBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight;
        if (force || distanceFromBottom < 80) {
          container.scrollTop = container.scrollHeight;
        }
      });
    });
  }

  private handleScroll(event: Event) {
    const container = event.currentTarget as HTMLElement | null;
    if (!container) {
      return;
    }
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    this.logsAtBottom = distanceFromBottom < 80;
  }

  private exportLogs(lines: string[], label: string) {
    if (lines.length === 0) {
      return;
    }
    const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    anchor.href = url;
    anchor.download = `openclaw-logs-${label}-${stamp}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  override render() {
    const body = renderLogs({
      loading: this.logsLoading,
      error: this.logsError,
      file: this.logsFile,
      entries: this.logsEntries,
      filterText: this.logsFilterText,
      levelFilters: this.logsLevelFilters,
      autoFollow: this.logsAutoFollow,
      truncated: this.logsTruncated,
      onFilterTextChange: (next) => (this.logsFilterText = next),
      onLevelToggle: (level, enabled) => {
        this.logsLevelFilters = { ...this.logsLevelFilters, [level]: enabled };
      },
      onToggleAutoFollow: (next) => (this.logsAutoFollow = next),
      onRefresh: () => void this.loadLogs({ reset: true }).then(() => this.scheduleScroll(true)),
      onExport: (lines, label) => this.exportLogs(lines, label),
      onScroll: (event) => this.handleScroll(event),
    });
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("logs")}</div>
          <div class="page-sub">${subtitleForRoute("logs")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(
        this.context.basePath,
        body,
        "logs",
        (routeId) => this.context.navigate(routeId),
        (routeId) => this.context.preload(routeId),
        { fillHeight: true, hostPolicy: this.context.hostPolicy },
      )}
    `;
  }
}

customElements.define("openclaw-logs-page", LogsPage);
