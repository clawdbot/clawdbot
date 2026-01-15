import {
  CombinedAutocompleteProvider,
  Container,
  Loader,
  ProcessTerminal,
  Text,
  TUI,
} from "@mariozechner/pi-tui";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { getSlashCommands } from "./commands.js";
import { ChatLog } from "./components/chat-log.js";
import { CustomEditor } from "./components/custom-editor.js";
import { GatewayChatClient } from "./gateway-chat.js";
import { editorTheme, theme } from "./theme/theme.js";
import { createCommandHandlers } from "./tui-command-handlers.js";
import { createEventHandlers } from "./tui-event-handlers.js";
import { formatTokens } from "./tui-formatters.js";
import { createOverlayHandlers } from "./tui-overlays.js";
import { createSessionActions } from "./tui-session-actions.js";
import type {
  AgentSummary,
  SessionInfo,
  SessionScope,
  TuiOptions,
  TuiStateAccess,
} from "./tui-types.js";

export { resolveFinalAssistantText } from "./tui-formatters.js";
export type { TuiOptions } from "./tui-types.js";

export async function runTui(opts: TuiOptions) {
  const config = loadConfig();
  const initialSessionInput = (opts.session ?? "").trim();
  let sessionScope: SessionScope = (config.session?.scope ?? "per-sender") as SessionScope;
  let sessionMainKey = normalizeMainKey(config.session?.mainKey);
  let agentDefaultId = resolveDefaultAgentId(config);
  let currentAgentId = agentDefaultId;
  let agents: AgentSummary[] = [];
  const agentNames = new Map<string, string>();
  let currentSessionKey = "";
  let initialSessionApplied = false;
  let currentSessionId: string | null = null;
  let activeChatRunId: string | null = null;
  let historyLoaded = false;
  let isConnected = false;
  let toolsExpanded = false;
  let showThinking = false;
  const deliverDefault = opts.deliver ?? false;
  const autoMessage = opts.message?.trim();
  let autoMessageSent = false;
  let sessionInfo: SessionInfo = {};
  let lastCtrlCAt = 0;
  let activityStatus = "idle";
  let connectionStatus = "connecting";
  let statusTimeout: NodeJS.Timeout | null = null;
  let statusTimer: NodeJS.Timeout | null = null;
  let statusStartedAt: number | null = null;
  let lastActivityStatus = activityStatus;

  const state: TuiStateAccess = {
    get agentDefaultId() {
      return agentDefaultId;
    },
    set agentDefaultId(value) {
      agentDefaultId = value;
    },
    get sessionMainKey() {
      return sessionMainKey;
    },
    set sessionMainKey(value) {
      sessionMainKey = value;
    },
    get sessionScope() {
      return sessionScope;
    },
    set sessionScope(value) {
      sessionScope = value;
    },
    get agents() {
      return agents;
    },
    set agents(value) {
      agents = value;
    },
    get currentAgentId() {
      return currentAgentId;
    },
    set currentAgentId(value) {
      currentAgentId = value;
    },
    get currentSessionKey() {
      return currentSessionKey;
    },
    set currentSessionKey(value) {
      currentSessionKey = value;
    },
    get currentSessionId() {
      return currentSessionId;
    },
    set currentSessionId(value) {
      currentSessionId = value;
    },
    get activeChatRunId() {
      return activeChatRunId;
    },
    set activeChatRunId(value) {
      activeChatRunId = value;
    },
    get historyLoaded() {
      return historyLoaded;
    },
    set historyLoaded(value) {
      historyLoaded = value;
    },
    get sessionInfo() {
      return sessionInfo;
    },
    set sessionInfo(value) {
      sessionInfo = value;
    },
    get initialSessionApplied() {
      return initialSessionApplied;
    },
    set initialSessionApplied(value) {
      initialSessionApplied = value;
    },
    get isConnected() {
      return isConnected;
    },
    set isConnected(value) {
      isConnected = value;
    },
    get autoMessageSent() {
      return autoMessageSent;
    },
    set autoMessageSent(value) {
      autoMessageSent = value;
    },
    get toolsExpanded() {
      return toolsExpanded;
    },
    set toolsExpanded(value) {
      toolsExpanded = value;
    },
    get showThinking() {
      return showThinking;
    },
    set showThinking(value) {
      showThinking = value;
    },
    get connectionStatus() {
      return connectionStatus;
    },
    set connectionStatus(value) {
      connectionStatus = value;
    },
    get activityStatus() {
      return activityStatus;
    },
    set activityStatus(value) {
      activityStatus = value;
    },
    get statusTimeout() {
      return statusTimeout;
    },
    set statusTimeout(value) {
      statusTimeout = value;
    },
    get lastCtrlCAt() {
      return lastCtrlCAt;
    },
    set lastCtrlCAt(value) {
      lastCtrlCAt = value;
    },
  };

  const client = new GatewayChatClient({
    url: opts.url,
    token: opts.token,
    password: opts.password,
  });

  const header = new Text("", 1, 0);
  const statusContainer = new Container();
  const footer = new Text("", 1, 0);
  const chatLog = new ChatLog();
  const editor = new CustomEditor(editorTheme);
  const root = new Container();
  root.addChild(header);
  root.addChild(chatLog);
  root.addChild(statusContainer);
  root.addChild(footer);
  root.addChild(editor);

  const updateAutocompleteProvider = () => {
    editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        getSlashCommands({
          provider: sessionInfo.modelProvider,
          model: sessionInfo.model,
        }),
        process.cwd(),
      ),
    );
  };

  const tui = new TUI(new ProcessTerminal());
  tui.addChild(root);
  tui.setFocus(editor);

  const formatSessionKey = (key: string) => {
    if (key === "global" || key === "unknown") return key;
    const parsed = parseAgentSessionKey(key);
    return parsed?.rest ?? key;
  };

  const formatAgentLabel = (id: string) => {
    const name = agentNames.get(id);
    return name ? `${id} (${name})` : id;
  };

  const resolveSessionKey = (raw?: string) => {
    const trimmed = (raw ?? "").trim();
    if (sessionScope === "global") return "global";
    if (!trimmed) {
      return buildAgentMainSessionKey({
        agentId: currentAgentId,
        mainKey: sessionMainKey,
      });
    }
    if (trimmed === "global" || trimmed === "unknown") return trimmed;
    if (trimmed.startsWith("agent:")) return trimmed;
    return `agent:${currentAgentId}:${trimmed}`;
  };

  currentSessionKey = resolveSessionKey(initialSessionInput);

  const updateHeader = () => {
    const sessionLabel = formatSessionKey(currentSessionKey);
    const agentLabel = formatAgentLabel(currentAgentId);
    header.setText(
      theme.header(
        `clawdbot tui - ${client.connection.url} - agent ${agentLabel} - session ${sessionLabel}`,
      ),
    );
  };

  const busyStates = new Set(["sending", "waiting", "streaming", "running"]);
  let statusText: Text | null = null;
  let statusLoader: Loader | null = null;

  const formatElapsed = (startMs: number) => {
    const totalSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  };

  const ensureStatusText = () => {
    if (statusText) return;
    statusContainer.clear();
    statusLoader?.stop();
    statusLoader = null;
    statusText = new Text("", 1, 0);
    statusContainer.addChild(statusText);
  };

  const ensureStatusLoader = () => {
    if (statusLoader) return;
    statusContainer.clear();
    statusText = null;
    statusLoader = new Loader(
      tui,
      (spinner) => theme.accent(spinner),
      (text) => theme.bold(theme.accentSoft(text)),
      "",
    );
    statusContainer.addChild(statusLoader);
  };

  const updateBusyStatusMessage = () => {
    if (!statusLoader || !statusStartedAt) return;
    const elapsed = formatElapsed(statusStartedAt);
    statusLoader.setMessage(`${activityStatus} • ${elapsed} | ${connectionStatus}`);
  };

  const startStatusTimer = () => {
    if (statusTimer) return;
    statusTimer = setInterval(() => {
      if (!busyStates.has(activityStatus)) return;
      updateBusyStatusMessage();
    }, 1000);
  };

  const stopStatusTimer = () => {
    if (!statusTimer) return;
    clearInterval(statusTimer);
    statusTimer = null;
  };

  const renderStatus = () => {
    const isBusy = busyStates.has(activityStatus);
    if (isBusy) {
      if (!statusStartedAt || lastActivityStatus !== activityStatus) {
        statusStartedAt = Date.now();
      }
      ensureStatusLoader();
      updateBusyStatusMessage();
      startStatusTimer();
    } else {
      statusStartedAt = null;
      stopStatusTimer();
      statusLoader?.stop();
      statusLoader = null;
      ensureStatusText();
      const text = activityStatus ? `${connectionStatus} | ${activityStatus}` : connectionStatus;
      statusText?.setText(theme.dim(text));
    }
    lastActivityStatus = activityStatus;
  };

  const setConnectionStatus = (text: string, ttlMs?: number) => {
    connectionStatus = text;
    renderStatus();
    if (statusTimeout) clearTimeout(statusTimeout);
    if (ttlMs && ttlMs > 0) {
      statusTimeout = setTimeout(() => {
        connectionStatus = isConnected ? "connected" : "disconnected";
        renderStatus();
      }, ttlMs);
    }
  };

  const setActivityStatus = (text: string) => {
    activityStatus = text;
    renderStatus();
  };

  const updateFooter = () => {
    const sessionKeyLabel = formatSessionKey(currentSessionKey);
    const sessionLabel = sessionInfo.displayName
      ? `${sessionKeyLabel} (${sessionInfo.displayName})`
      : sessionKeyLabel;
    const agentLabel = formatAgentLabel(currentAgentId);
    const modelLabel = sessionInfo.model
      ? sessionInfo.modelProvider
        ? `${sessionInfo.modelProvider}/${sessionInfo.model}`
        : sessionInfo.model
      : "unknown";
    const tokens = formatTokens(sessionInfo.totalTokens ?? null, sessionInfo.contextTokens ?? null);
    const think = sessionInfo.thinkingLevel ?? "off";
    const verbose = sessionInfo.verboseLevel ?? "off";
    const reasoning = sessionInfo.reasoningLevel ?? "off";
    const reasoningLabel =
      reasoning === "on" ? "reasoning" : reasoning === "stream" ? "reasoning:stream" : null;
    footer.setText(
      theme.dim(
        `agent ${agentLabel} | session ${sessionLabel} | ${modelLabel} | think ${think} | verbose ${verbose}${reasoningLabel ? ` | ${reasoningLabel}` : ""} | ${tokens}`,
      ),
    );
  };

  const { openOverlay, closeOverlay } = createOverlayHandlers(tui, editor);

  const initialSessionAgentId = (() => {
    if (!initialSessionInput) return null;
    const parsed = parseAgentSessionKey(initialSessionInput);
    return parsed ? normalizeAgentId(parsed.agentId) : null;
  })();

  const sessionActions = createSessionActions({
    client,
    chatLog,
    tui,
    opts,
    state,
    agentNames,
    initialSessionInput,
    initialSessionAgentId,
    resolveSessionKey,
    updateHeader,
    updateFooter,
    updateAutocompleteProvider,
    setActivityStatus,
  });
  const { refreshAgents, refreshSessionInfo, loadHistory, setSession, abortActive } =
    sessionActions;

  const { handleChatEvent, handleAgentEvent } = createEventHandlers({
    chatLog,
    tui,
    state,
    setActivityStatus,
  });

  const { handleCommand, sendMessage, openModelSelector, openAgentSelector, openSessionSelector } =
    createCommandHandlers({
      client,
      chatLog,
      tui,
      opts,
      state,
      deliverDefault,
      openOverlay,
      closeOverlay,
      refreshSessionInfo,
      loadHistory,
      setSession,
      refreshAgents,
      abortActive,
      setActivityStatus,
      formatSessionKey,
    });

  updateAutocompleteProvider();
  editor.onSubmit = (text) => {
    const value = text.trim();
    editor.setText("");
    if (!value) return;
    if (value.startsWith("/")) {
      void handleCommand(value);
      return;
    }
    void sendMessage(value);
  };

  editor.onEscape = () => {
    void abortActive();
  };
  editor.onCtrlC = () => {
    const now = Date.now();
    if (editor.getText().trim().length > 0) {
      editor.setText("");
      setActivityStatus("cleared input");
      tui.requestRender();
      return;
    }
    if (now - lastCtrlCAt < 1000) {
      client.stop();
      tui.stop();
      process.exit(0);
    }
    lastCtrlCAt = now;
    setActivityStatus("press ctrl+c again to exit");
    tui.requestRender();
  };
  editor.onCtrlD = () => {
    client.stop();
    tui.stop();
    process.exit(0);
  };
  editor.onCtrlO = () => {
    toolsExpanded = !toolsExpanded;
    chatLog.setToolsExpanded(toolsExpanded);
    setActivityStatus(toolsExpanded ? "tools expanded" : "tools collapsed");
    tui.requestRender();
  };
  editor.onCtrlL = () => {
    void openModelSelector();
  };
  editor.onCtrlG = () => {
    void openAgentSelector();
  };
  editor.onCtrlP = () => {
    void openSessionSelector();
  };
  editor.onCtrlT = () => {
    showThinking = !showThinking;
    void loadHistory();
  };

  client.onEvent = (evt) => {
    if (evt.event === "chat") handleChatEvent(evt.payload);
    if (evt.event === "agent") handleAgentEvent(evt.payload);
  };

  client.onConnected = () => {
    isConnected = true;
    setConnectionStatus("connected");
    void (async () => {
      await refreshAgents();
      updateHeader();
      if (!historyLoaded) {
        await loadHistory();
        setConnectionStatus("gateway connected", 4000);
        tui.requestRender();
        if (!autoMessageSent && autoMessage) {
          autoMessageSent = true;
          await sendMessage(autoMessage);
        }
      } else {
        setConnectionStatus("gateway reconnected", 4000);
      }
      updateFooter();
      tui.requestRender();
    })();
  };

  client.onDisconnected = (reason) => {
    isConnected = false;
    const reasonLabel = reason?.trim() ? reason.trim() : "closed";
    setConnectionStatus(`gateway disconnected: ${reasonLabel}`, 5000);
    setActivityStatus("idle");
    updateFooter();
    tui.requestRender();
  };

  client.onGap = (info) => {
    setConnectionStatus(`event gap: expected ${info.expected}, got ${info.received}`, 5000);
    tui.requestRender();
  };

  updateHeader();
  setConnectionStatus("connecting");
  updateFooter();
  tui.start();
  client.start();
}
