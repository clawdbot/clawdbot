import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

import { GatewayBrowserClient, type GatewayEventFrame, type GatewayHelloOk } from "./gateway";
import { loadSettings, saveSettings, type UiSettings } from "./storage";
import { renderApp } from "./app-render";
import {
  inferBasePathFromPathname,
  normalizeBasePath,
  normalizePath,
  pathForTab,
  tabFromPath,
  type Tab,
} from "./navigation";
import {
  resolveTheme,
  type ResolvedTheme,
  type ThemeMode,
} from "./theme";
import { truncateText } from "./format";
import { generateUUID } from "./uuid";
import {
  startThemeTransition,
  type ThemeTransitionContext,
} from "./theme-transition";
import type {
  ConfigSnapshot,
  ConfigUiHints,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  HealthSnapshot,
  LogEntry,
  LogLevel,
  PresenceEntry,
  ChannelsStatusSnapshot,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,
} from "./types";
import {
  defaultDiscordActions,
  defaultSlackActions,
  type ChatQueueItem,
  type CronFormState,
  type DiscordForm,
  type IMessageForm,
  type SlackForm,
  type SignalForm,
  type TelegramForm,
} from "./ui-types";
import {
  loadChatHistory,
  sendChatMessage,
  abortChatRun,
  handleChatEvent,
  type ChatEventPayload,
} from "./controllers/chat";
import { loadNodes } from "./controllers/nodes";
import {
  loadConfig,
  loadConfigSchema,
  updateConfigFormValue,
} from "./controllers/config";
import {
  loadChannels,
  logoutWhatsApp,
  saveDiscordConfig,
  saveIMessageConfig,
  saveSlackConfig,
  saveSignalConfig,
  saveTelegramConfig,
  startWhatsAppLogin,
  waitWhatsAppLogin,
} from "./controllers/connections";
import { loadPresence } from "./controllers/presence";
import { loadSessions } from "./controllers/sessions";
import {
  loadCronJobs,
  loadCronStatus,
} from "./controllers/cron";
import {
  loadSkills,
  type SkillMessage,
} from "./controllers/skills";
import { loadDebug } from "./controllers/debug";
import { loadLogs } from "./controllers/logs";

type EventLogEntry = {
  ts: number;
  event: string;
  payload?: unknown;
};

const TOOL_STREAM_LIMIT = 50;
const TOOL_STREAM_THROTTLE_MS = 80;
const TOOL_OUTPUT_CHAR_LIMIT = 120_000;
const DEFAULT_LOG_LEVEL_FILTERS: Record<LogLevel, boolean> = {
  trace: true,
  debug: true,
  info: true,
  warn: true,
  error: true,
  fatal: true,
};

type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  sessionKey?: string;
  data: Record<string, unknown>;
};

type ToolStreamEntry = {
  toolCallId: string;
  runId: string;
  sessionKey?: string;
  name: string;
  args?: unknown;
  output?: string;
  startedAt: number;
  updatedAt: number;
  message: Record<string, unknown>;
};

function extractToolOutputText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  const content = record.content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      if (entry.type === "text" && typeof entry.text === "string") return entry.text;
      return null;
    })
    .filter((part): part is string => Boolean(part));
  if (parts.length === 0) return null;
  return parts.join("\n");
}

function formatToolOutput(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const contentText = extractToolOutputText(value);
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (contentText) {
    text = contentText;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  const truncated = truncateText(text, TOOL_OUTPUT_CHAR_LIMIT);
  if (!truncated.truncated) return truncated.text;
  return `${truncated.text}\n\n… truncated (${truncated.total} chars, showing first ${truncated.text.length}).`;
}

declare global {
  interface Window {
    __CLAWDBOT_CONTROL_UI_BASE_PATH__?: string;
  }
}

const DEFAULT_CRON_FORM: CronFormState = {
  name: "",
  description: "",
  agentId: "",
  enabled: true,
  scheduleKind: "every",
  scheduleAt: "",
  everyAmount: "30",
  everyUnit: "minutes",
  cronExpr: "0 7 * * *",
  cronTz: "",
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
  payloadKind: "systemEvent",
  payloadText: "",
  deliver: false,
  channel: "last",
  to: "",
  timeoutSeconds: "",
  postToMainPrefix: "",
};

@customElement("clawdbot-app")
export class ClawdbotApp extends LitElement {
  @state() settings: UiSettings = loadSettings();
  @state() password = "";
  @state() tab: Tab = "chat";
  @state() connected = false;
  @state() theme: ThemeMode = this.settings.theme ?? "system";
  @state() themeResolved: ResolvedTheme = "dark";
  @state() hello: GatewayHelloOk | null = null;
  @state() lastError: string | null = null;
  @state() eventLog: EventLogEntry[] = [];
  private eventLogBuffer: EventLogEntry[] = [];
  private toolStreamSyncTimer: number | null = null;
  private sidebarCloseTimer: number | null = null;

  @state() sessionKey = this.settings.sessionKey;
  @state() chatLoading = false;
  @state() chatSending = false;
  @state() chatMessage = "";
  @state() chatMessages: unknown[] = [];
  @state() chatToolMessages: unknown[] = [];
  @state() chatStream: string | null = null;
  @state() chatStreamStartedAt: number | null = null;
  @state() chatRunId: string | null = null;
  @state() chatThinkingLevel: string | null = null;
  @state() chatQueue: ChatQueueItem[] = [];
  @state() toolOutputExpanded = new Set<string>();
  // Sidebar state for tool output viewing
  @state() sidebarOpen = false;
  @state() sidebarContent: string | null = null;
  @state() sidebarError: string | null = null;
  @state() splitRatio = this.settings.splitRatio;

  @state() nodesLoading = false;
  @state() nodes: Array<Record<string, unknown>> = [];

  @state() configLoading = false;
  @state() configRaw = "{\n}\n";
  @state() configValid: boolean | null = null;
  @state() configIssues: unknown[] = [];
  @state() configSaving = false;
  @state() configApplying = false;
  @state() updateRunning = false;
  @state() applySessionKey = this.settings.lastActiveSessionKey;
  @state() configSnapshot: ConfigSnapshot | null = null;
  @state() configSchema: unknown | null = null;
  @state() configSchemaVersion: string | null = null;
  @state() configSchemaLoading = false;
  @state() configUiHints: ConfigUiHints = {};
  @state() configForm: Record<string, unknown> | null = null;
  @state() configFormDirty = false;
  @state() configFormMode: "form" | "raw" = "form";

  @state() channelsLoading = false;
  @state() channelsSnapshot: ChannelsStatusSnapshot | null = null;
  @state() channelsError: string | null = null;
  @state() channelsLastSuccess: number | null = null;
  @state() whatsappLoginMessage: string | null = null;
  @state() whatsappLoginQrDataUrl: string | null = null;
  @state() whatsappLoginConnected: boolean | null = null;
  @state() whatsappBusy = false;
  @state() telegramForm: TelegramForm = {
    token: "",
    requireMention: true,
    groupsWildcardEnabled: false,
    allowFrom: "",
    proxy: "",
    webhookUrl: "",
    webhookSecret: "",
    webhookPath: "",
  };
  @state() telegramSaving = false;
  @state() telegramTokenLocked = false;
  @state() telegramConfigStatus: string | null = null;
  @state() discordForm: DiscordForm = {
    enabled: true,
    token: "",
    dmEnabled: true,
    allowFrom: "",
    groupEnabled: false,
    groupChannels: "",
    mediaMaxMb: "",
    historyLimit: "",
    textChunkLimit: "",
    guilds: [],
    actions: { ...defaultDiscordActions },
    slashEnabled: false,
    slashName: "",
    slashSessionPrefix: "",
    slashEphemeral: true,
  };
  @state() discordSaving = false;
  @state() discordTokenLocked = false;
  @state() discordConfigStatus: string | null = null;
  @state() slackForm: SlackForm = {
    enabled: true,
    botToken: "",
    appToken: "",
    dmEnabled: true,
    allowFrom: "",
    groupEnabled: false,
    groupChannels: "",
    mediaMaxMb: "",
    textChunkLimit: "",
    reactionNotifications: "own",
    reactionAllowlist: "",
    slashEnabled: false,
    slashName: "",
    slashSessionPrefix: "",
    slashEphemeral: true,
    actions: { ...defaultSlackActions },
    channels: [],
  };
  @state() slackSaving = false;
  @state() slackTokenLocked = false;
  @state() slackAppTokenLocked = false;
  @state() slackConfigStatus: string | null = null;
  @state() signalForm: SignalForm = {
    enabled: true,
    account: "",
    httpUrl: "",
    httpHost: "",
    httpPort: "",
    cliPath: "",
    autoStart: true,
    receiveMode: "",
    ignoreAttachments: false,
    ignoreStories: false,
    sendReadReceipts: false,
    allowFrom: "",
    mediaMaxMb: "",
  };
  @state() signalSaving = false;
  @state() signalConfigStatus: string | null = null;
  @state() imessageForm: IMessageForm = {
    enabled: true,
    cliPath: "",
    dbPath: "",
    service: "auto",
    region: "",
    allowFrom: "",
    includeAttachments: false,
    mediaMaxMb: "",
  };
  @state() imessageSaving = false;
  @state() imessageConfigStatus: string | null = null;

  @state() presenceLoading = false;
  @state() presenceEntries: PresenceEntry[] = [];
  @state() presenceError: string | null = null;
  @state() presenceStatus: string | null = null;

  @state() sessionsLoading = false;
  @state() sessionsResult: SessionsListResult | null = null;
  @state() sessionsError: string | null = null;
  @state() sessionsFilterActive = "";
  @state() sessionsFilterLimit = "120";
  @state() sessionsIncludeGlobal = true;
  @state() sessionsIncludeUnknown = false;

  @state() cronLoading = false;
  @state() cronJobs: CronJob[] = [];
  @state() cronStatus: CronStatus | null = null;
  @state() cronError: string | null = null;
  @state() cronForm: CronFormState = { ...DEFAULT_CRON_FORM };
  @state() cronRunsJobId: string | null = null;
  @state() cronRuns: CronRunLogEntry[] = [];
  @state() cronBusy = false;

  @state() skillsLoading = false;
  @state() skillsReport: SkillStatusReport | null = null;
  @state() skillsError: string | null = null;
  @state() skillsFilter = "";
  @state() skillEdits: Record<string, string> = {};
  @state() skillsBusyKey: string | null = null;
  @state() skillMessages: Record<string, SkillMessage> = {};

  @state() debugLoading = false;
  @state() debugStatus: StatusSummary | null = null;
  @state() debugHealth: HealthSnapshot | null = null;
  @state() debugModels: unknown[] = [];
  @state() debugHeartbeat: unknown | null = null;
  @state() debugCallMethod = "";
  @state() debugCallParams = "{}";
  @state() debugCallResult: string | null = null;
  @state() debugCallError: string | null = null;

  @state() logsLoading = false;
  @state() logsError: string | null = null;
  @state() logsFile: string | null = null;
  @state() logsEntries: LogEntry[] = [];
  @state() logsFilterText = "";
  @state() logsLevelFilters: Record<LogLevel, boolean> = {
    ...DEFAULT_LOG_LEVEL_FILTERS,
  };
  @state() logsAutoFollow = true;
  @state() logsTruncated = false;
  @state() logsCursor: number | null = null;
  @state() logsLastFetchAt: number | null = null;
  @state() logsLimit = 500;
  @state() logsMaxBytes = 250_000;
  @state() logsAtBottom = true;

  client: GatewayBrowserClient | null = null;
  private chatScrollFrame: number | null = null;
  private chatScrollTimeout: number | null = null;
  private chatHasAutoScrolled = false;
  private chatUserNearBottom = true;
  private nodesPollInterval: number | null = null;
  private logsPollInterval: number | null = null;
  private logsScrollFrame: number | null = null;
  private toolStreamById = new Map<string, ToolStreamEntry>();
  private toolStreamOrder: string[] = [];
  basePath = "";
  private popStateHandler = () => this.onPopState();
  private themeMedia: MediaQueryList | null = null;
  private themeMediaHandler: ((event: MediaQueryListEvent) => void) | null = null;
  private topbarObserver: ResizeObserver | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.basePath = this.inferBasePath();
    this.syncTabWithLocation(true);
    this.syncThemeWithSettings();
    this.attachThemeListener();
    window.addEventListener("popstate", this.popStateHandler);
    this.applySettingsFromUrl();
    this.connect();
    this.startNodesPolling();
    if (this.tab === "logs") this.startLogsPolling();
  }

  protected firstUpdated() {
    this.observeTopbar();
  }

  disconnectedCallback() {
    window.removeEventListener("popstate", this.popStateHandler);
    this.stopNodesPolling();
    this.stopLogsPolling();
    this.detachThemeListener();
    this.topbarObserver?.disconnect();
    this.topbarObserver = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<PropertyKey, unknown>) {
    if (
      this.tab === "chat" &&
      (changed.has("chatMessages") ||
        changed.has("chatToolMessages") ||
        changed.has("chatStream") ||
        changed.has("chatLoading") ||
        changed.has("tab"))
    ) {
      const forcedByTab = changed.has("tab");
      const forcedByLoad =
        changed.has("chatLoading") &&
        changed.get("chatLoading") === true &&
        this.chatLoading === false;
      this.scheduleChatScroll(forcedByTab || forcedByLoad || !this.chatHasAutoScrolled);
    }
    if (
      this.tab === "logs" &&
      (changed.has("logsEntries") || changed.has("logsAutoFollow") || changed.has("tab"))
    ) {
      if (this.logsAutoFollow && this.logsAtBottom) {
        this.scheduleLogsScroll(changed.has("tab") || changed.has("logsAutoFollow"));
      }
    }
  }

  connect() {
    this.lastError = null;
    this.hello = null;
    this.connected = false;

    this.client?.stop();
    this.client = new GatewayBrowserClient({
      url: this.settings.gatewayUrl,
      token: this.settings.token.trim() ? this.settings.token : undefined,
      password: this.password.trim() ? this.password : undefined,
      clientName: "clawdbot-control-ui",
      mode: "webchat",
      onHello: (hello) => {
        this.connected = true;
        this.hello = hello;
        this.applySnapshot(hello);
        void loadNodes(this, { quiet: true });
        void this.refreshActiveTab();
      },
      onClose: ({ code, reason }) => {
        this.connected = false;
        this.lastError = `disconnected (${code}): ${reason || "no reason"}`;
      },
      onEvent: (evt) => this.onEvent(evt),
      onGap: ({ expected, received }) => {
        this.lastError = `event gap detected (expected seq ${expected}, got ${received}); refresh recommended`;
      },
    });
    this.client.start();
  }

  private scheduleChatScroll(force = false) {
    if (this.chatScrollFrame) cancelAnimationFrame(this.chatScrollFrame);
    if (this.chatScrollTimeout != null) {
      clearTimeout(this.chatScrollTimeout);
      this.chatScrollTimeout = null;
    }
    const pickScrollTarget = () => {
      const container = this.querySelector(".chat-thread") as HTMLElement | null;
      if (container) {
        const overflowY = getComputedStyle(container).overflowY;
        const canScroll =
          overflowY === "auto" ||
          overflowY === "scroll" ||
          container.scrollHeight - container.clientHeight > 1;
        if (canScroll) return container;
      }
      return (document.scrollingElement ?? document.documentElement) as HTMLElement | null;
    };
    // Wait for Lit render to complete, then scroll
    void this.updateComplete.then(() => {
      this.chatScrollFrame = requestAnimationFrame(() => {
        this.chatScrollFrame = null;
        const target = pickScrollTarget();
        if (!target) return;
        const distanceFromBottom =
          target.scrollHeight - target.scrollTop - target.clientHeight;
        const shouldStick =
          force || this.chatUserNearBottom || distanceFromBottom < 200;
        if (!shouldStick) return;
        if (force) this.chatHasAutoScrolled = true;
        target.scrollTop = target.scrollHeight;
        this.chatUserNearBottom = true;
        const retryDelay = force ? 150 : 120;
        this.chatScrollTimeout = window.setTimeout(() => {
          this.chatScrollTimeout = null;
          const latest = pickScrollTarget();
          if (!latest) return;
          const latestDistanceFromBottom =
            latest.scrollHeight - latest.scrollTop - latest.clientHeight;
          const shouldStickRetry =
            force || this.chatUserNearBottom || latestDistanceFromBottom < 200;
          if (!shouldStickRetry) return;
          latest.scrollTop = latest.scrollHeight;
          this.chatUserNearBottom = true;
        }, retryDelay);
      });
    });
  }

  private observeTopbar() {
    if (typeof ResizeObserver === "undefined") return;
    const topbar = this.querySelector(".topbar");
    if (!topbar) return;
    const update = () => {
      const { height } = topbar.getBoundingClientRect();
      this.style.setProperty("--topbar-height", `${height}px`);
    };
    update();
    this.topbarObserver = new ResizeObserver(() => update());
    this.topbarObserver.observe(topbar);
  }

  private startNodesPolling() {
    if (this.nodesPollInterval != null) return;
    this.nodesPollInterval = window.setInterval(
      () => void loadNodes(this, { quiet: true }),
      5000,
    );
  }

  private stopNodesPolling() {
    if (this.nodesPollInterval == null) return;
    clearInterval(this.nodesPollInterval);
    this.nodesPollInterval = null;
  }

  private startLogsPolling() {
    if (this.logsPollInterval != null) return;
    this.logsPollInterval = window.setInterval(() => {
      if (this.tab !== "logs") return;
      void loadLogs(this, { quiet: true });
    }, 2000);
  }

  private stopLogsPolling() {
    if (this.logsPollInterval == null) return;
    clearInterval(this.logsPollInterval);
    this.logsPollInterval = null;
  }

  private scheduleLogsScroll(force = false) {
    if (this.logsScrollFrame) cancelAnimationFrame(this.logsScrollFrame);
    void this.updateComplete.then(() => {
      this.logsScrollFrame = requestAnimationFrame(() => {
        this.logsScrollFrame = null;
        const container = this.querySelector(".log-stream") as HTMLElement | null;
        if (!container) return;
        const distanceFromBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight;
        const shouldStick = force || distanceFromBottom < 80;
        if (!shouldStick) return;
        container.scrollTop = container.scrollHeight;
      });
    });
  }

  handleChatScroll(event: Event) {
    const container = event.currentTarget as HTMLElement | null;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    this.chatUserNearBottom = distanceFromBottom < 200;
  }

  handleLogsScroll(event: Event) {
    const container = event.currentTarget as HTMLElement | null;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    this.logsAtBottom = distanceFromBottom < 80;
  }

  exportLogs(lines: string[], label: string) {
    if (lines.length === 0) return;
    const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    anchor.href = url;
    anchor.download = `clawdbot-logs-${label}-${stamp}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  resetToolStream() {
    this.toolStreamById.clear();
    this.toolStreamOrder = [];
    this.chatToolMessages = [];
    this.toolOutputExpanded = new Set();
    this.flushToolStreamSync();
  }

  resetChatScroll() {
    this.chatHasAutoScrolled = false;
    this.chatUserNearBottom = true;
  }

  toggleToolOutput(id: string, expanded: boolean) {
    const next = new Set(this.toolOutputExpanded);
    if (expanded) {
      next.add(id);
    } else {
      next.delete(id);
    }
    this.toolOutputExpanded = next;
  }

  private trimToolStream() {
    if (this.toolStreamOrder.length <= TOOL_STREAM_LIMIT) return;
    const overflow = this.toolStreamOrder.length - TOOL_STREAM_LIMIT;
    const removed = this.toolStreamOrder.splice(0, overflow);
    for (const id of removed) this.toolStreamById.delete(id);
  }

  private syncToolStreamMessages() {
    this.chatToolMessages = this.toolStreamOrder
      .map((id) => this.toolStreamById.get(id)?.message)
      .filter((msg): msg is Record<string, unknown> => Boolean(msg));
  }

  private scheduleToolStreamSync(force = false) {
    if (force) {
      this.flushToolStreamSync();
      return;
    }
    if (this.toolStreamSyncTimer != null) return;
    this.toolStreamSyncTimer = window.setTimeout(
      () => this.flushToolStreamSync(),
      TOOL_STREAM_THROTTLE_MS,
    );
  }

  private flushToolStreamSync() {
    if (this.toolStreamSyncTimer != null) {
      clearTimeout(this.toolStreamSyncTimer);
      this.toolStreamSyncTimer = null;
    }
    this.syncToolStreamMessages();
  }

  private buildToolStreamMessage(entry: ToolStreamEntry): Record<string, unknown> {
    const content: Array<Record<string, unknown>> = [];
    content.push({
      type: "toolcall",
      name: entry.name,
      arguments: entry.args ?? {},
    });
    if (entry.output) {
      content.push({
        type: "toolresult",
        name: entry.name,
        text: entry.output,
      });
    }
    return {
      role: "assistant",
      toolCallId: entry.toolCallId,
      runId: entry.runId,
      content,
      timestamp: entry.startedAt,
    };
  }

  private handleAgentEvent(payload?: AgentEventPayload) {
    if (!payload || payload.stream !== "tool") return;
    const sessionKey =
      typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
    if (sessionKey && sessionKey !== this.sessionKey) return;
    // Fallback: only accept session-less events for the active run.
    if (!sessionKey && this.chatRunId && payload.runId !== this.chatRunId) return;
    if (this.chatRunId && payload.runId !== this.chatRunId) return;
    if (!this.chatRunId) return;

    const data = payload.data ?? {};
    const toolCallId =
      typeof data.toolCallId === "string" ? data.toolCallId : "";
    if (!toolCallId) return;
    const name = typeof data.name === "string" ? data.name : "tool";
    const phase = typeof data.phase === "string" ? data.phase : "";
    const args = phase === "start" ? data.args : undefined;
    const output =
      phase === "update"
        ? formatToolOutput(data.partialResult)
        : phase === "result"
          ? formatToolOutput(data.result)
          : undefined;

    const now = Date.now();
    let entry = this.toolStreamById.get(toolCallId);
    if (!entry) {
      entry = {
        toolCallId,
        runId: payload.runId,
        sessionKey,
        name,
        args,
        output,
        startedAt: typeof payload.ts === "number" ? payload.ts : now,
        updatedAt: now,
        message: {},
      };
      this.toolStreamById.set(toolCallId, entry);
      this.toolStreamOrder.push(toolCallId);
    } else {
      entry.name = name;
      if (args !== undefined) entry.args = args;
      if (output !== undefined) entry.output = output;
      entry.updatedAt = now;
    }

    entry.message = this.buildToolStreamMessage(entry);
    this.trimToolStream();
    this.scheduleToolStreamSync(phase === "result");
  }

  private onEvent(evt: GatewayEventFrame) {
    this.eventLogBuffer = [
      { ts: Date.now(), event: evt.event, payload: evt.payload },
      ...this.eventLogBuffer,
    ].slice(0, 250);
    if (this.tab === "debug") {
      this.eventLog = this.eventLogBuffer;
    }

    if (evt.event === "agent") {
      this.handleAgentEvent(evt.payload as AgentEventPayload | undefined);
      return;
    }

    if (evt.event === "chat") {
      const payload = evt.payload as ChatEventPayload | undefined;
      if (payload?.sessionKey) {
        this.setLastActiveSessionKey(payload.sessionKey);
      }
      const state = handleChatEvent(this, payload);
      if (state === "final" || state === "error" || state === "aborted") {
        this.resetToolStream();
        void this.flushChatQueue();
      }
      if (state === "final") void loadChatHistory(this);
      return;
    }

    if (evt.event === "presence") {
      const payload = evt.payload as { presence?: PresenceEntry[] } | undefined;
      if (payload?.presence && Array.isArray(payload.presence)) {
        this.presenceEntries = payload.presence;
        this.presenceError = null;
        this.presenceStatus = null;
      }
      return;
    }

    if (evt.event === "cron" && this.tab === "cron") {
      void this.loadCron();
    }
  }

  private applySnapshot(hello: GatewayHelloOk) {
    const snapshot = hello.snapshot as
      | { presence?: PresenceEntry[]; health?: HealthSnapshot }
      | undefined;
    if (snapshot?.presence && Array.isArray(snapshot.presence)) {
      this.presenceEntries = snapshot.presence;
    }
    if (snapshot?.health) {
      this.debugHealth = snapshot.health;
    }
  }

  applySettings(next: UiSettings) {
    const normalized = {
      ...next,
      lastActiveSessionKey:
        next.lastActiveSessionKey?.trim() || next.sessionKey.trim() || "main",
    };
    this.settings = normalized;
    saveSettings(normalized);
    if (next.theme !== this.theme) {
      this.theme = next.theme;
      this.applyResolvedTheme(resolveTheme(next.theme));
    }
    this.applySessionKey = this.settings.lastActiveSessionKey;
  }

  private setLastActiveSessionKey(next: string) {
    const trimmed = next.trim();
    if (!trimmed) return;
    if (this.settings.lastActiveSessionKey === trimmed) return;
    this.applySettings({ ...this.settings, lastActiveSessionKey: trimmed });
  }

  private applySettingsFromUrl() {
    if (!window.location.search) return;
    const params = new URLSearchParams(window.location.search);
    const tokenRaw = params.get("token");
    const passwordRaw = params.get("password");
    const sessionRaw = params.get("session");
    let shouldCleanUrl = false;

    if (tokenRaw != null) {
      const token = tokenRaw.trim();
      if (token && !this.settings.token) {
        this.applySettings({ ...this.settings, token });
      }
      params.delete("token");
      shouldCleanUrl = true;
    }

    if (passwordRaw != null) {
      const password = passwordRaw.trim();
      if (password) {
        this.password = password;
      }
      params.delete("password");
      shouldCleanUrl = true;
    }

    if (sessionRaw != null) {
      const session = sessionRaw.trim();
      if (session) {
        this.sessionKey = session;
      }
      params.delete("session");
      shouldCleanUrl = true;
    }

    if (!shouldCleanUrl) return;
    const url = new URL(window.location.href);
    url.search = params.toString();
    window.history.replaceState({}, "", url.toString());
  }

  setTab(next: Tab) {
    if (this.tab !== next) this.tab = next;
    if (next === "chat") this.chatHasAutoScrolled = false;
    if (next === "logs") this.startLogsPolling();
    else this.stopLogsPolling();
    void this.refreshActiveTab();
    this.syncUrlWithTab(next, false);
  }

  setTheme(next: ThemeMode, context?: ThemeTransitionContext) {
    const applyTheme = () => {
      this.theme = next;
      this.applySettings({ ...this.settings, theme: next });
      this.applyResolvedTheme(resolveTheme(next));
    };
    startThemeTransition({
      nextTheme: next,
      applyTheme,
      context,
      currentTheme: this.theme,
    });
  }

  private async refreshActiveTab() {
    if (this.tab === "overview") await this.loadOverview();
    if (this.tab === "connections") await this.loadConnections();
    if (this.tab === "instances") await loadPresence(this);
    if (this.tab === "sessions") await loadSessions(this);
    if (this.tab === "cron") await this.loadCron();
    if (this.tab === "skills") await loadSkills(this);
    if (this.tab === "nodes") await loadNodes(this);
    if (this.tab === "chat") {
      await Promise.all([loadChatHistory(this), loadSessions(this)]);
      this.scheduleChatScroll(!this.chatHasAutoScrolled);
    }
    if (this.tab === "config") {
      await loadConfigSchema(this);
      await loadConfig(this);
    }
    if (this.tab === "debug") {
      await loadDebug(this);
      this.eventLog = this.eventLogBuffer;
    }
    if (this.tab === "logs") {
      this.logsAtBottom = true;
      await loadLogs(this, { reset: true });
      this.scheduleLogsScroll(true);
    }
  }

  private inferBasePath() {
    if (typeof window === "undefined") return "";
    const configured = window.__CLAWDBOT_CONTROL_UI_BASE_PATH__;
    if (typeof configured === "string" && configured.trim()) {
      return normalizeBasePath(configured);
    }
    return inferBasePathFromPathname(window.location.pathname);
  }

  private syncThemeWithSettings() {
    this.theme = this.settings.theme ?? "system";
    this.applyResolvedTheme(resolveTheme(this.theme));
  }

  private applyResolvedTheme(resolved: ResolvedTheme) {
    this.themeResolved = resolved;
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  }

  private attachThemeListener() {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function")
      return;
    this.themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
    this.themeMediaHandler = (event) => {
      if (this.theme !== "system") return;
      this.applyResolvedTheme(event.matches ? "dark" : "light");
    };
    if (typeof this.themeMedia.addEventListener === "function") {
      this.themeMedia.addEventListener("change", this.themeMediaHandler);
      return;
    }
    const legacy = this.themeMedia as MediaQueryList & {
      addListener: (cb: (event: MediaQueryListEvent) => void) => void;
    };
    legacy.addListener(this.themeMediaHandler);
  }

  private detachThemeListener() {
    if (!this.themeMedia || !this.themeMediaHandler) return;
    if (typeof this.themeMedia.removeEventListener === "function") {
      this.themeMedia.removeEventListener("change", this.themeMediaHandler);
      return;
    }
    const legacy = this.themeMedia as MediaQueryList & {
      removeListener: (cb: (event: MediaQueryListEvent) => void) => void;
    };
    legacy.removeListener(this.themeMediaHandler);
    this.themeMedia = null;
    this.themeMediaHandler = null;
  }

  private syncTabWithLocation(replace: boolean) {
    if (typeof window === "undefined") return;
    const resolved = tabFromPath(window.location.pathname, this.basePath) ?? "chat";
    this.setTabFromRoute(resolved);
    this.syncUrlWithTab(resolved, replace);
  }

  private onPopState() {
    if (typeof window === "undefined") return;
    const resolved = tabFromPath(window.location.pathname, this.basePath);
    if (!resolved) return;
    this.setTabFromRoute(resolved);
  }

  private setTabFromRoute(next: Tab) {
    if (this.tab !== next) this.tab = next;
    if (next === "chat") this.chatHasAutoScrolled = false;
    if (next === "logs") this.startLogsPolling();
    else this.stopLogsPolling();
    if (this.connected) void this.refreshActiveTab();
  }

  private syncUrlWithTab(tab: Tab, replace: boolean) {
    if (typeof window === "undefined") return;
    const targetPath = normalizePath(pathForTab(tab, this.basePath));
    const currentPath = normalizePath(window.location.pathname);
    if (currentPath === targetPath) return;
    const url = new URL(window.location.href);
    url.pathname = targetPath;
    if (replace) {
      window.history.replaceState({}, "", url.toString());
    } else {
      window.history.pushState({}, "", url.toString());
    }
  }

  async loadOverview() {
    await Promise.all([
      loadChannels(this, false),
      loadPresence(this),
      loadSessions(this),
      loadCronStatus(this),
      loadDebug(this),
    ]);
  }

  private async loadConnections() {
    await Promise.all([loadChannels(this, true), loadConfig(this)]);
  }

  async loadCron() {
    await Promise.all([loadCronStatus(this), loadCronJobs(this)]);
  }

  private isChatBusy() {
    return this.chatSending || Boolean(this.chatRunId);
  }

  private isChatStopCommand(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const normalized = trimmed.toLowerCase();
    if (normalized === "/stop") return true;
    return (
      normalized === "stop" ||
      normalized === "esc" ||
      normalized === "abort" ||
      normalized === "wait" ||
      normalized === "exit"
    );
  }

  async handleAbortChat() {
    if (!this.connected) return;
    this.chatMessage = "";
    await abortChatRun(this);
  }

  private enqueueChatMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.chatQueue = [
      ...this.chatQueue,
      {
        id: generateUUID(),
        text: trimmed,
        createdAt: Date.now(),
      },
    ];
  }

  private async sendChatMessageNow(
    message: string,
    opts?: { previousDraft?: string; restoreDraft?: boolean },
  ) {
    this.resetToolStream();
    const ok = await sendChatMessage(this, message);
    if (!ok && opts?.previousDraft != null) {
      this.chatMessage = opts.previousDraft;
    }
    if (ok) {
      this.setLastActiveSessionKey(this.sessionKey);
    }
    if (ok && opts?.restoreDraft && opts.previousDraft?.trim()) {
      this.chatMessage = opts.previousDraft;
    }
    this.scheduleChatScroll();
    if (ok && !this.chatRunId) {
      void this.flushChatQueue();
    }
    return ok;
  }

  private async flushChatQueue() {
    if (!this.connected || this.isChatBusy()) return;
    const [next, ...rest] = this.chatQueue;
    if (!next) return;
    this.chatQueue = rest;
    const ok = await this.sendChatMessageNow(next.text);
    if (!ok) {
      this.chatQueue = [next, ...this.chatQueue];
    }
  }

  removeQueuedMessage(id: string) {
    this.chatQueue = this.chatQueue.filter((item) => item.id !== id);
  }

  async handleSendChat(
    messageOverride?: string,
    opts?: { restoreDraft?: boolean },
  ) {
    if (!this.connected) return;
    const previousDraft = this.chatMessage;
    const message = (messageOverride ?? this.chatMessage).trim();
    if (!message) return;

    if (this.isChatStopCommand(message)) {
      await this.handleAbortChat();
      return;
    }

    if (messageOverride == null) {
      this.chatMessage = "";
    }

    if (this.isChatBusy()) {
      this.enqueueChatMessage(message);
      return;
    }

    await this.sendChatMessageNow(message, {
      previousDraft: messageOverride == null ? previousDraft : undefined,
      restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
    });
  }

  async handleWhatsAppStart(force: boolean) {
    await startWhatsAppLogin(this, force);
    await loadChannels(this, true);
  }

  async handleWhatsAppWait() {
    await waitWhatsAppLogin(this);
    await loadChannels(this, true);
  }

  async handleWhatsAppLogout() {
    await logoutWhatsApp(this);
    await loadChannels(this, true);
  }

  async handleTelegramSave() {
    await saveTelegramConfig(this);
    await loadConfig(this);
    await loadChannels(this, true);
  }

  async handleDiscordSave() {
    await saveDiscordConfig(this);
    await loadConfig(this);
    await loadChannels(this, true);
  }

  async handleSlackSave() {
    await saveSlackConfig(this);
    await loadConfig(this);
    await loadChannels(this, true);
  }

  async handleSignalSave() {
    await saveSignalConfig(this);
    await loadConfig(this);
    await loadChannels(this, true);
  }

  async handleIMessageSave() {
    await saveIMessageConfig(this);
    await loadConfig(this);
    await loadChannels(this, true);
  }

  // Sidebar handlers for tool output viewing
  handleOpenSidebar(content: string) {
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
      this.sidebarCloseTimer = null;
    }
    this.sidebarContent = content;
    this.sidebarError = null;
    this.sidebarOpen = true;
  }

  handleCloseSidebar() {
    this.sidebarOpen = false;
    // Clear content after transition
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
    }
    this.sidebarCloseTimer = window.setTimeout(() => {
      if (this.sidebarOpen) return;
      this.sidebarContent = null;
      this.sidebarError = null;
      this.sidebarCloseTimer = null;
    }, 200);
  }

  handleSplitRatioChange(ratio: number) {
    const newRatio = Math.max(0.4, Math.min(0.7, ratio));
    this.splitRatio = newRatio;
    this.applySettings({ ...this.settings, splitRatio: newRatio });
  }

  render() {
    return renderApp(this);
  }
}
