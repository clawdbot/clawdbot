import "../../styles/logs.css";
import { consume } from "@lit/context";
import { html, type PropertyValues } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import {
  beginPanelRefresh,
  completePanelRefresh,
  createPanelRefreshStatus,
  failPanelRefresh,
} from "../../components/panel-refresh-status.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  DEFAULT_LOG_LEVEL_FILTERS,
  parseLogLine,
  type LogEntry,
  type LogLevel,
} from "./log-lines.ts";
import { renderLogs } from "./view.ts";

const LOG_BUFFER_LIMIT = 2000;
const LOGS_POLL_INTERVAL_MS = 2000;

type LogsRequestScope = {
  gateway: ApplicationContext["gateway"];
  client: GatewayBrowserClient;
  generation: number;
};

class LogsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private client: GatewayBrowserClient | null = null;
  @state() private connected = false;
  @state() private logsLoading = false;
  @state() private logsStatus = createPanelRefreshStatus();
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
  private readonly polling = new PollController(
    this,
    LOGS_POLL_INTERVAL_MS,
    () => {
      void this.loadLogs({ quiet: true });
    },
    false,
  );
  private logsScrollFrame: number | null = null;
  private contentScrollFrame: number | null = null;
  private hasBoundGatewaySource = false;
  private gatewaySource: ApplicationContext["gateway"] | null = null;
  private requestGeneration = 0;
  private activeRequest: LogsRequestScope | null = null;
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) => {
      const resetForSourceBind = this.hasBoundGatewaySource;
      this.hasBoundGatewaySource = true;
      this.gatewaySource = gateway;
      this.requestGeneration += 1;
      const cleanup = gateway.subscribe((snapshot) => {
        if (this.gatewaySource === gateway && this.context.gateway === gateway) {
          this.applyGatewaySnapshot(snapshot);
        }
      });
      this.applyGatewaySnapshot(gateway.snapshot, resetForSourceBind);
      this.logsAtBottom = true;
      return cleanup;
    },
  );

  override firstUpdated() {
    this.resetContentScroll();
    this.contentScrollFrame = requestAnimationFrame(() => {
      this.contentScrollFrame = null;
      this.resetContentScroll();
    });
  }

  override updated(changed: PropertyValues) {
    const autoFollowEnabled = this.logsAutoFollow && changed.has("logsAutoFollow");
    if (
      autoFollowEnabled ||
      (this.logsAutoFollow && this.logsAtBottom && changed.has("logsEntries"))
    ) {
      this.scheduleScroll(autoFollowEnabled);
    }
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.requestGeneration += 1;
    this.activeRequest = null;
    this.gatewaySource = null;
    this.logsLoading = false;
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

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot, resetForSourceBind = false) {
    const connectionChanged = snapshot.connected !== this.connected;
    const clientChanged = resetForSourceBind || snapshot.client !== this.client;
    if (clientChanged || connectionChanged) {
      this.requestGeneration += 1;
      this.activeRequest = null;
    }
    this.client = snapshot.client;
    this.connected = snapshot.connected;
    if (clientChanged) {
      this.resetServerState();
    } else if (connectionChanged) {
      this.logsLoading = false;
    }
    this.syncPolling();
    this.ensureInitialLogs();
  }

  private resetServerState() {
    this.logsLoading = false;
    this.logsStatus = createPanelRefreshStatus();
    this.logsFile = null;
    this.logsEntries = [];
    this.logsTruncated = false;
    this.logsCursor = null;
    this.logsAtBottom = true;
  }

  private syncPolling() {
    if (!this.connected || !this.client) {
      this.polling.stop();
      return;
    }
    this.polling.start();
  }

  private ensureInitialLogs() {
    if (!this.connected || !this.client || this.logsEntries.length > 0 || this.logsLoading) {
      return;
    }
    void this.loadLogs({ reset: true }).then((current) => {
      if (current) {
        this.scheduleScroll(true);
      }
    });
  }

  private captureRequestScope(): LogsRequestScope | null {
    const gateway = this.gatewaySource;
    const client = this.client;
    if (
      !gateway ||
      !client ||
      !this.connected ||
      !this.isConnected ||
      this.context.gateway !== gateway
    ) {
      return null;
    }
    return { gateway, client, generation: this.requestGeneration };
  }

  private isRequestScopeCurrent(scope: LogsRequestScope): boolean {
    return (
      this.isConnected &&
      this.gatewaySource === scope.gateway &&
      this.context.gateway === scope.gateway &&
      this.requestGeneration === scope.generation &&
      this.client === scope.client &&
      this.connected
    );
  }

  private async loadLogs(opts?: { reset?: boolean; quiet?: boolean }): Promise<boolean> {
    const scope = this.captureRequestScope();
    const quiet = opts?.quiet === true;
    if (!scope || (this.activeRequest && this.isRequestScopeCurrent(this.activeRequest))) {
      return false;
    }
    this.activeRequest = scope;
    const isCurrentOperation = () =>
      this.activeRequest === scope && this.isRequestScopeCurrent(scope);
    if (!quiet) {
      this.logsLoading = true;
    }
    this.logsStatus = beginPanelRefresh(this.logsStatus, { clearError: !quiet });
    try {
      const res = await scope.client.request("logs.tail", {
        cursor: opts?.reset ? undefined : (this.logsCursor ?? undefined),
        limit: this.logsLimit,
        maxBytes: this.logsMaxBytes,
      });
      if (!isCurrentOperation()) {
        return false;
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
      this.logsStatus = completePanelRefresh();
      return true;
    } catch (err) {
      if (!isCurrentOperation()) {
        return false;
      }
      if (isMissingOperatorReadScopeError(err)) {
        this.logsEntries = [];
        this.logsStatus = failPanelRefresh(
          createPanelRefreshStatus(),
          formatMissingOperatorReadScopeMessage("logs"),
        );
      } else {
        this.logsStatus = failPanelRefresh(this.logsStatus, String(err));
      }
      return true;
    } finally {
      if (this.activeRequest === scope) {
        this.activeRequest = null;
        if (this.isRequestScopeCurrent(scope) && !quiet) {
          this.logsLoading = false;
        }
      }
    }
  }

  private scheduleScroll(force = false) {
    if (this.logsScrollFrame !== null) {
      cancelAnimationFrame(this.logsScrollFrame);
    }
    const gateway = this.gatewaySource;
    const generation = this.requestGeneration;
    const isCurrent = () =>
      this.isConnected &&
      this.connected &&
      gateway !== null &&
      this.gatewaySource === gateway &&
      this.context.gateway === gateway &&
      this.requestGeneration === generation;
    void this.updateComplete.then(() => {
      if (!isCurrent()) {
        return;
      }
      this.logsScrollFrame = requestAnimationFrame(() => {
        this.logsScrollFrame = null;
        if (!isCurrent()) {
          return;
        }
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
      status: this.logsStatus,
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
      onRefresh: () =>
        void this.loadLogs({ reset: true }).then((current) => {
          if (current) {
            this.scheduleScroll(true);
          }
        }),
      onExport: (lines, label) => this.exportLogs(lines, label),
      onScroll: (event) => this.handleScroll(event),
    });
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("logs")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(body, { fillHeight: true })}
    `;
  }
}

if (!customElements.get("openclaw-logs-page")) {
  customElements.define("openclaw-logs-page", LogsPage);
}
