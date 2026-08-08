import "../../styles/logs.css";
import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { html, type PropertyValues } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
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
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { StreamAutoFollowController } from "../../lit/stream-auto-follow-controller.ts";
import {
  DEFAULT_LOG_LEVEL_FILTERS,
  parseLogLine,
  type LogEntry,
  type LogLevel,
} from "./log-lines.ts";
import { renderLogs } from "./view.ts";

const LOG_BUFFER_LIMIT = 2000;
const LOGS_POLL_INTERVAL_MS = 2000;

class LogsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private logsStatus = createPanelRefreshStatus();
  @state() private logsFile: string | null = null;
  @state() private logsEntries: LogEntry[] = [];
  @state() private logsFilterText = "";
  @state() private logsLevelFilters: Record<LogLevel, boolean> = { ...DEFAULT_LOG_LEVEL_FILTERS };
  @state() private logsAutoFollow = true;
  @state() private logsTruncated = false;

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
  private contentScrollFrame: number | null = null;
  private logsTaskQuiet = false;
  private logsTaskArgs(opts?: { reset?: boolean; quiet?: boolean }) {
    return [
      this.gateway.connected ? this.gateway.gateway : null,
      this.gateway.connected ? this.gateway.client : null,
      opts?.reset ? null : this.logsCursor,
      opts?.reset === true,
      opts?.quiet === true,
    ] as const;
  }
  private readonly logsTask = new Task(this, {
    autoRun: false,
    // The cursor and reset flag make each tail page an explicit immutable read.
    args: () => this.logsTaskArgs(),
    task: async ([gateway, client, cursor, reset, quiet], { signal }) => {
      if (!gateway || !client) {
        return initialState;
      }
      try {
        const payload = await client.request<{
          file?: string;
          cursor?: number;
          lines?: unknown;
          truncated?: boolean;
          reset?: boolean;
        }>(
          "logs.tail",
          {
            cursor: reset ? undefined : (cursor ?? undefined),
            limit: this.logsLimit,
            maxBytes: this.logsMaxBytes,
          },
          { signal },
        );
        return { ok: true as const, payload, cursor, reset, quiet };
      } catch (error) {
        return { ok: false as const, error, quiet };
      }
    },
    onComplete: (result) => {
      if (!result.ok) {
        if (isMissingOperatorReadScopeError(result.error)) {
          this.logsEntries = [];
          this.logsStatus = failPanelRefresh(
            createPanelRefreshStatus(),
            formatMissingOperatorReadScopeMessage("logs"),
          );
        } else {
          this.logsStatus = failPanelRefresh(this.logsStatus, String(result.error));
        }
        return;
      }
      const lines = Array.isArray(result.payload.lines)
        ? result.payload.lines.filter((line): line is string => typeof line === "string")
        : [];
      const entries = lines.map(parseLogLine);
      const shouldReset = result.reset || result.payload.reset || result.cursor == null;
      this.logsEntries = shouldReset
        ? entries
        : [...this.logsEntries, ...entries].slice(-LOG_BUFFER_LIMIT);
      this.logsCursor =
        typeof result.payload.cursor === "number" ? result.payload.cursor : this.logsCursor;
      this.logsFile = typeof result.payload.file === "string" ? result.payload.file : this.logsFile;
      this.logsTruncated = Boolean(result.payload.truncated);
      this.logsStatus = completePanelRefresh();
    },
  });
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      this.logsStatus = createPanelRefreshStatus();
      this.logsFile = null;
      this.logsEntries = [];
      this.logsTruncated = false;
      this.logsCursor = null;
      this.streamFollow.atBottom = true;
    },
    invalidateRequests: () => {
      this.logsTaskQuiet = false;
      void this.logsTask.run([null, null, null, false, false]);
    },
    onSnapshot: () => {
      this.syncPolling();
      this.ensureInitialLogs();
    },
  });
  private readonly streamFollow = new StreamAutoFollowController(this, {
    selector: ".log-stream",
    isEnabled: () => this.logsAutoFollow,
    captureCurrent: () => {
      const gateway = this.gateway.gateway;
      const epoch = this.gateway.epoch;
      // Same-client reconnects retain object identity; the epoch keeps queued
      // scroll work bound to the connection that scheduled it.
      return () =>
        this.isConnected &&
        this.gateway.connected &&
        gateway !== null &&
        this.gateway.gateway === gateway &&
        this.context.gateway === gateway &&
        this.gateway.epoch === epoch;
    },
  });

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
      (this.logsAutoFollow && this.streamFollow.atBottom && changed.has("logsEntries"))
    ) {
      this.streamFollow.schedule(autoFollowEnabled);
    }
  }

  override disconnectedCallback() {
    this.logsTaskQuiet = false;
    void this.logsTask.run([null, null, null, false, false]);
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

  private syncPolling() {
    if (!this.gateway.connected || !this.gateway.client) {
      this.polling.stop();
      return;
    }
    this.polling.start();
  }

  private ensureInitialLogs() {
    if (!this.gateway.connected || !this.gateway.client || this.logsEntries.length > 0) {
      return;
    }
    void this.loadLogs({ reset: true }).then((current) => {
      if (current) {
        this.streamFollow.schedule(true);
      }
    });
  }

  private async loadLogs(opts?: { reset?: boolean; quiet?: boolean }): Promise<boolean> {
    const quiet = opts?.quiet === true;
    const gateway = this.gateway.gateway;
    if (
      !gateway ||
      !this.gateway.client ||
      !this.gateway.connected ||
      this.context.gateway !== gateway ||
      (this.logsTask.status === TaskStatus.PENDING && opts?.reset !== true)
    ) {
      return false;
    }
    this.logsTaskQuiet = quiet;
    this.logsStatus = beginPanelRefresh(this.logsStatus, { clearError: !quiet });
    await this.logsTask.run(this.logsTaskArgs(opts));
    return this.logsTask.status === TaskStatus.COMPLETE;
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
      loading: this.logsTask.status === TaskStatus.PENDING && !this.logsTaskQuiet,
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
            this.streamFollow.schedule(true);
          }
        }),
      onExport: (lines, label) => this.exportLogs(lines, label),
      onScroll: (event) => this.streamFollow.handleScroll(event),
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
