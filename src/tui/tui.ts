import {
  CombinedAutocompleteProvider,
  type Component,
  Container,
  ProcessTerminal,
  Text,
  TUI,
} from "@mariozechner/pi-tui";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { normalizeUsageDisplay } from "../auto-reply/thinking.js";
import { loadConfig } from "../config/config.js";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { formatTokenCount } from "../utils/usage-format.js";
import { getSlashCommands, helpText, parseCommand } from "./commands.js";
import { ChatLog } from "./components/chat-log.js";
import { CustomEditor } from "./components/custom-editor.js";
import {
  createSelectList,
  createSettingsList,
} from "./components/selectors.js";
import { type GatewayAgentsList, GatewayChatClient } from "./gateway-chat.js";
import { editorTheme, theme } from "./theme/theme.js";

export type TuiOptions = {
  url?: string;
  token?: string;
  password?: string;
  session?: string;
  deliver?: boolean;
  thinking?: string;
  timeoutMs?: number;
  historyLimit?: number;
  message?: string;
};

type ChatEvent = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

type AgentEvent = {
  runId: string;
  stream: string;
  data?: Record<string, unknown>;
};

type SessionInfo = {
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  model?: string;
  modelProvider?: string;
  contextTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  responseUsage?: "on" | "off";
  updatedAt?: number | null;
  displayName?: string;
};

type SessionScope = "per-sender" | "global";

type AgentSummary = {
  id: string;
  name?: string;
};

function extractTextBlocks(
  content: unknown,
  opts?: { includeThinking?: boolean },
): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
    if (
      opts?.includeThinking &&
      record.type === "thinking" &&
      typeof record.thinking === "string"
    ) {
      parts.push(`[thinking]\n${record.thinking}`);
    }
  }
  return parts.join("\n").trim();
}

function extractTextFromMessage(
  message: unknown,
  opts?: { includeThinking?: boolean },
): string {
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  return extractTextBlocks(record.content, opts);
}

function formatTokens(total?: number | null, context?: number | null) {
  if (total == null && context == null) return "tokens ?";
  const totalLabel = total == null ? "?" : formatTokenCount(total);
  if (context == null) return `tokens ${totalLabel}`;
  const pct =
    typeof total === "number" && context > 0
      ? Math.min(999, Math.round((total / context) * 100))
      : null;
  return `tokens ${totalLabel}/${formatTokenCount(context)}${
    pct !== null ? ` (${pct}%)` : ""
  }`;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

export async function runTui(opts: TuiOptions) {
  const config = loadConfig();
  const initialSessionInput = (opts.session ?? "").trim();
  let sessionScope: SessionScope = (config.session?.scope ??
    "per-sender") as SessionScope;
  let sessionMainKey = (config.session?.mainKey ?? "main").trim() || "main";
  let agentDefaultId = resolveDefaultAgentId(config);
  let currentAgentId = agentDefaultId;
  let agents: AgentSummary[] = [];
  const agentNames = new Map<string, string>();
  let currentSessionKey = "";
  let initialSessionApplied = false;
  let currentSessionId: string | null = null;
  let activeChatRunId: string | null = null;
  const finalizedRuns = new Map<string, number>();
  let historyLoaded = false;
  let isConnected = false;
  let toolsExpanded = false;
  let showThinking = false;
  let deliverDefault = Boolean(opts.deliver);
  const autoMessage = opts.message?.trim();
  let autoMessageSent = false;
  let sessionInfo: SessionInfo = {};
  let lastCtrlCAt = 0;

  const client = new GatewayChatClient({
    url: opts.url,
    token: opts.token,
    password: opts.password,
  });

  const header = new Text("", 1, 0);
  const status = new Text("", 1, 0);
  const footer = new Text("", 1, 0);
  const chatLog = new ChatLog();
  const editor = new CustomEditor(editorTheme);
  const overlay = new Container();
  const root = new Container();
  root.addChild(header);
  root.addChild(overlay);
  root.addChild(chatLog);
  root.addChild(status);
  root.addChild(footer);
  root.addChild(editor);

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

  const setStatus = (text: string) => {
    status.setText(theme.dim(text));
  };

  const updateFooter = () => {
    const connection = isConnected ? "connected" : "disconnected";
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
    const tokens = formatTokens(
      sessionInfo.totalTokens ?? null,
      sessionInfo.contextTokens ?? null,
    );
    const think = sessionInfo.thinkingLevel ?? "off";
    const verbose = sessionInfo.verboseLevel ?? "off";
    const reasoning = sessionInfo.reasoningLevel ?? "off";
    const deliver = deliverDefault ? "on" : "off";
    footer.setText(
      theme.dim(
        `${connection} | agent ${agentLabel} | session ${sessionLabel} | model ${modelLabel} | think ${think} | verbose ${verbose} | reasoning ${reasoning} | ${tokens} | deliver ${deliver}`,
      ),
    );
  };

  const closeOverlay = () => {
    overlay.clear();
    tui.setFocus(editor);
  };

  const openOverlay = (component: Component) => {
    overlay.clear();
    overlay.addChild(component);
    tui.setFocus(component);
  };

  const initialSessionAgentId = (() => {
    if (!initialSessionInput) return null;
    const parsed = parseAgentSessionKey(initialSessionInput);
    return parsed ? normalizeAgentId(parsed.agentId) : null;
  })();

  const applyAgentsResult = (result: GatewayAgentsList) => {
    agentDefaultId = normalizeAgentId(result.defaultId);
    sessionMainKey = result.mainKey.trim() || sessionMainKey;
    sessionScope = result.scope ?? sessionScope;
    agents = result.agents.map((agent) => ({
      id: normalizeAgentId(agent.id),
      name: agent.name?.trim() || undefined,
    }));
    agentNames.clear();
    for (const agent of agents) {
      if (agent.name) agentNames.set(agent.id, agent.name);
    }
    if (!initialSessionApplied) {
      if (initialSessionAgentId) {
        if (agents.some((agent) => agent.id === initialSessionAgentId)) {
          currentAgentId = initialSessionAgentId;
        }
      } else if (!agents.some((agent) => agent.id === currentAgentId)) {
        currentAgentId =
          agents[0]?.id ?? normalizeAgentId(result.defaultId ?? currentAgentId);
      }
      const nextSessionKey = resolveSessionKey(initialSessionInput);
      if (nextSessionKey !== currentSessionKey) {
        currentSessionKey = nextSessionKey;
      }
      initialSessionApplied = true;
    } else if (!agents.some((agent) => agent.id === currentAgentId)) {
      currentAgentId =
        agents[0]?.id ?? normalizeAgentId(result.defaultId ?? currentAgentId);
    }
    updateHeader();
    updateFooter();
  };

  const refreshAgents = async () => {
    try {
      const result = await client.listAgents();
      applyAgentsResult(result);
    } catch (err) {
      chatLog.addSystem(`agents list failed: ${String(err)}`);
    }
  };

  const updateAgentFromSessionKey = (key: string) => {
    const parsed = parseAgentSessionKey(key);
    if (!parsed) return;
    const next = normalizeAgentId(parsed.agentId);
    if (next !== currentAgentId) {
      currentAgentId = next;
    }
  };

  const refreshSessionInfo = async () => {
    try {
      const listAgentId =
        currentSessionKey === "global" || currentSessionKey === "unknown"
          ? undefined
          : currentAgentId;
      const result = await client.listSessions({
        includeGlobal: false,
        includeUnknown: false,
        agentId: listAgentId,
      });
      const entry = result.sessions.find((row) => {
        // Exact match
        if (row.key === currentSessionKey) return true;
        // Also match canonical keys like "agent:default:main" against "main"
        const parsed = parseAgentSessionKey(row.key);
        return parsed?.rest === currentSessionKey;
      });
      sessionInfo = {
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        reasoningLevel: entry?.reasoningLevel,
        model: entry?.model ?? result.defaults?.model ?? undefined,
        modelProvider: entry?.modelProvider,
        contextTokens: entry?.contextTokens ?? result.defaults?.contextTokens,
        inputTokens: entry?.inputTokens ?? null,
        outputTokens: entry?.outputTokens ?? null,
        totalTokens: entry?.totalTokens ?? null,
        responseUsage: entry?.responseUsage,
        updatedAt: entry?.updatedAt ?? null,
        displayName: entry?.displayName,
      };
    } catch (err) {
      chatLog.addSystem(`sessions list failed: ${String(err)}`);
    }
    updateFooter();
    tui.requestRender();
  };

  const loadHistory = async () => {
    try {
      const history = await client.loadHistory({
        sessionKey: currentSessionKey,
        limit: opts.historyLimit ?? 200,
      });
      const record = history as {
        messages?: unknown[];
        sessionId?: string;
        thinkingLevel?: string;
      };
      currentSessionId =
        typeof record.sessionId === "string" ? record.sessionId : null;
      sessionInfo.thinkingLevel =
        record.thinkingLevel ?? sessionInfo.thinkingLevel;
      chatLog.clearAll();
      chatLog.addSystem(`session ${currentSessionKey}`);
      for (const entry of record.messages ?? []) {
        if (!entry || typeof entry !== "object") continue;
        const message = entry as Record<string, unknown>;
        if (message.role === "user") {
          const text = extractTextFromMessage(message);
          if (text) chatLog.addUser(text);
          continue;
        }
        if (message.role === "assistant") {
          const text = extractTextFromMessage(message, {
            includeThinking: showThinking,
          });
          if (text) chatLog.finalizeAssistant(text);
          continue;
        }
        if (message.role === "toolResult") {
          const toolCallId = asString(message.toolCallId, "");
          const toolName = asString(message.toolName, "tool");
          const component = chatLog.startTool(toolCallId, toolName, {});
          component.setResult(
            {
              content: Array.isArray(message.content)
                ? (message.content as Record<string, unknown>[])
                : [],
              details:
                typeof message.details === "object" && message.details
                  ? (message.details as Record<string, unknown>)
                  : undefined,
            },
            { isError: Boolean(message.isError) },
          );
        }
      }
      historyLoaded = true;
    } catch (err) {
      chatLog.addSystem(`history failed: ${String(err)}`);
    }
    await refreshSessionInfo();
    tui.requestRender();
  };

  const setSession = async (rawKey: string) => {
    const nextKey = resolveSessionKey(rawKey);
    updateAgentFromSessionKey(nextKey);
    currentSessionKey = nextKey;
    activeChatRunId = null;
    currentSessionId = null;
    historyLoaded = false;
    updateHeader();
    updateFooter();
    await loadHistory();
  };

  const abortActive = async () => {
    if (!activeChatRunId) {
      chatLog.addSystem("no active run");
      tui.requestRender();
      return;
    }
    try {
      await client.abortChat({
        sessionKey: currentSessionKey,
        runId: activeChatRunId,
      });
      setStatus("aborted");
    } catch (err) {
      chatLog.addSystem(`abort failed: ${String(err)}`);
      setStatus("abort failed");
    }
    tui.requestRender();
  };

  const noteFinalizedRun = (runId: string) => {
    finalizedRuns.set(runId, Date.now());
    if (finalizedRuns.size <= 200) return;
    const keepUntil = Date.now() - 10 * 60 * 1000;
    for (const [key, ts] of finalizedRuns) {
      if (finalizedRuns.size <= 150) break;
      if (ts < keepUntil) finalizedRuns.delete(key);
    }
    if (finalizedRuns.size > 200) {
      for (const key of finalizedRuns.keys()) {
        finalizedRuns.delete(key);
        if (finalizedRuns.size <= 150) break;
      }
    }
  };

  const handleChatEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const evt = payload as ChatEvent;
    if (evt.sessionKey !== currentSessionKey) return;
    if (finalizedRuns.has(evt.runId)) {
      if (evt.state === "delta") return;
      if (evt.state === "final") return;
    }
    if (evt.state === "delta") {
      const text = extractTextFromMessage(evt.message, {
        includeThinking: showThinking,
      });
      if (!text) return;
      chatLog.updateAssistant(text, evt.runId);
      setStatus("streaming");
    }
    if (evt.state === "final") {
      const text = extractTextFromMessage(evt.message, {
        includeThinking: showThinking,
      });
      chatLog.finalizeAssistant(text || "(no output)", evt.runId);
      noteFinalizedRun(evt.runId);
      activeChatRunId = null;
      setStatus("idle");
    }
    if (evt.state === "aborted") {
      chatLog.addSystem("run aborted");
      activeChatRunId = null;
      setStatus("aborted");
    }
    if (evt.state === "error") {
      chatLog.addSystem(`run error: ${evt.errorMessage ?? "unknown"}`);
      activeChatRunId = null;
      setStatus("error");
    }
    tui.requestRender();
  };

  const handleAgentEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const evt = payload as AgentEvent;
    if (!currentSessionId || evt.runId !== currentSessionId) return;
    if (evt.stream === "tool") {
      const data = evt.data ?? {};
      const phase = asString(data.phase, "");
      const toolCallId = asString(data.toolCallId, "");
      const toolName = asString(data.name, "tool");
      if (!toolCallId) return;
      if (phase === "start") {
        chatLog.startTool(toolCallId, toolName, data.args);
      } else if (phase === "update") {
        chatLog.updateToolResult(toolCallId, data.partialResult, {
          partial: true,
        });
      } else if (phase === "result") {
        chatLog.updateToolResult(toolCallId, data.result, {
          isError: Boolean(data.isError),
        });
      }
      tui.requestRender();
      return;
    }
    if (evt.stream === "lifecycle") {
      const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      if (phase === "start") setStatus("running");
      if (phase === "end") setStatus("idle");
      if (phase === "error") setStatus("error");
      tui.requestRender();
    }
  };

  const openModelSelector = async () => {
    try {
      const models = await client.listModels();
      if (models.length === 0) {
        chatLog.addSystem("no models available");
        tui.requestRender();
        return;
      }
      const items = models.map((model) => ({
        value: `${model.provider}/${model.id}`,
        label: `${model.provider}/${model.id}`,
        description: model.name && model.name !== model.id ? model.name : "",
      }));
      const selector = createSelectList(items, 9);
      selector.onSelect = (item) => {
        void (async () => {
          try {
            await client.patchSession({
              key: currentSessionKey,
              model: item.value,
            });
            chatLog.addSystem(`model set to ${item.value}`);
            await refreshSessionInfo();
          } catch (err) {
            chatLog.addSystem(`model set failed: ${String(err)}`);
          }
          closeOverlay();
          tui.requestRender();
        })();
      };
      selector.onCancel = () => {
        closeOverlay();
        tui.requestRender();
      };
      openOverlay(selector);
      tui.requestRender();
    } catch (err) {
      chatLog.addSystem(`model list failed: ${String(err)}`);
      tui.requestRender();
    }
  };

  const setAgent = async (id: string) => {
    currentAgentId = normalizeAgentId(id);
    await setSession("");
  };

  const openAgentSelector = async () => {
    await refreshAgents();
    if (agents.length === 0) {
      chatLog.addSystem("no agents found");
      tui.requestRender();
      return;
    }
    const items = agents.map((agent) => ({
      value: agent.id,
      label: agent.name ? `${agent.id} (${agent.name})` : agent.id,
      description: agent.id === agentDefaultId ? "default" : "",
    }));
    const selector = createSelectList(items, 9);
    selector.onSelect = (item) => {
      void (async () => {
        closeOverlay();
        await setAgent(item.value);
        tui.requestRender();
      })();
    };
    selector.onCancel = () => {
      closeOverlay();
      tui.requestRender();
    };
    openOverlay(selector);
    tui.requestRender();
  };

  const openSessionSelector = async () => {
    try {
      const result = await client.listSessions({
        includeGlobal: false,
        includeUnknown: false,
        agentId: currentAgentId,
      });
      const items = result.sessions.map((session) => ({
        value: session.key,
        label: session.displayName
          ? `${session.displayName} (${formatSessionKey(session.key)})`
          : formatSessionKey(session.key),
        description: session.updatedAt
          ? new Date(session.updatedAt).toLocaleString()
          : "",
      }));
      const selector = createSelectList(items, 9);
      selector.onSelect = (item) => {
        void (async () => {
          closeOverlay();
          await setSession(item.value);
          tui.requestRender();
        })();
      };
      selector.onCancel = () => {
        closeOverlay();
        tui.requestRender();
      };
      openOverlay(selector);
      tui.requestRender();
    } catch (err) {
      chatLog.addSystem(`sessions list failed: ${String(err)}`);
      tui.requestRender();
    }
  };

  const openSettings = () => {
    const items = [
      {
        id: "deliver",
        label: "Deliver replies",
        currentValue: deliverDefault ? "on" : "off",
        values: ["off", "on"],
      },
      {
        id: "tools",
        label: "Tool output",
        currentValue: toolsExpanded ? "expanded" : "collapsed",
        values: ["collapsed", "expanded"],
      },
      {
        id: "thinking",
        label: "Show thinking",
        currentValue: showThinking ? "on" : "off",
        values: ["off", "on"],
      },
    ];
    const settings = createSettingsList(
      items,
      (id, value) => {
        if (id === "deliver") {
          deliverDefault = value === "on";
          updateFooter();
        }
        if (id === "tools") {
          toolsExpanded = value === "expanded";
          chatLog.setToolsExpanded(toolsExpanded);
        }
        if (id === "thinking") {
          showThinking = value === "on";
          void loadHistory();
        }
        tui.requestRender();
      },
      () => {
        closeOverlay();
        tui.requestRender();
      },
    );
    openOverlay(settings);
    tui.requestRender();
  };

  const handleCommand = async (raw: string) => {
    const { name, args } = parseCommand(raw);
    if (!name) return;
    switch (name) {
      case "help":
        chatLog.addSystem(helpText());
        break;
      case "status":
        try {
          const status = await client.getStatus();
          chatLog.addSystem(
            typeof status === "string"
              ? status
              : JSON.stringify(status, null, 2),
          );
        } catch (err) {
          chatLog.addSystem(`status failed: ${String(err)}`);
        }
        break;
      case "agent":
        if (!args) {
          await openAgentSelector();
        } else {
          await setAgent(args);
        }
        break;
      case "agents":
        await openAgentSelector();
        break;
      case "session":
        if (!args) {
          await openSessionSelector();
        } else {
          await setSession(args);
        }
        break;
      case "sessions":
        await openSessionSelector();
        break;
      case "model":
        if (!args) {
          await openModelSelector();
        } else {
          try {
            await client.patchSession({
              key: currentSessionKey,
              model: args,
            });
            chatLog.addSystem(`model set to ${args}`);
            await refreshSessionInfo();
          } catch (err) {
            chatLog.addSystem(`model set failed: ${String(err)}`);
          }
        }
        break;
      case "models":
        await openModelSelector();
        break;
      case "think":
        if (!args) {
          chatLog.addSystem("usage: /think <off|minimal|low|medium|high>");
          break;
        }
        try {
          await client.patchSession({
            key: currentSessionKey,
            thinkingLevel: args,
          });
          chatLog.addSystem(`thinking set to ${args}`);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`think failed: ${String(err)}`);
        }
        break;
      case "verbose":
        if (!args) {
          chatLog.addSystem("usage: /verbose <on|off>");
          break;
        }
        try {
          await client.patchSession({
            key: currentSessionKey,
            verboseLevel: args,
          });
          chatLog.addSystem(`verbose set to ${args}`);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`verbose failed: ${String(err)}`);
        }
        break;
      case "reasoning":
        if (!args) {
          chatLog.addSystem("usage: /reasoning <on|off>");
          break;
        }
        try {
          await client.patchSession({
            key: currentSessionKey,
            reasoningLevel: args,
          });
          chatLog.addSystem(`reasoning set to ${args}`);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`reasoning failed: ${String(err)}`);
        }
        break;
      case "cost": {
        const normalized = args ? normalizeUsageDisplay(args) : undefined;
        if (args && !normalized) {
          chatLog.addSystem("usage: /cost <on|off>");
          break;
        }
        const current = sessionInfo.responseUsage === "on" ? "on" : "off";
        const next = normalized ?? (current === "on" ? "off" : "on");
        try {
          await client.patchSession({
            key: currentSessionKey,
            responseUsage: next === "off" ? null : next,
          });
          chatLog.addSystem(
            next === "on" ? "usage line enabled" : "usage line disabled",
          );
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`cost failed: ${String(err)}`);
        }
        break;
      }
      case "elevated":
        if (!args) {
          chatLog.addSystem("usage: /elevated <on|off>");
          break;
        }
        try {
          await client.patchSession({
            key: currentSessionKey,
            elevatedLevel: args,
          });
          chatLog.addSystem(`elevated set to ${args}`);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`elevated failed: ${String(err)}`);
        }
        break;
      case "activation":
        if (!args) {
          chatLog.addSystem("usage: /activation <mention|always>");
          break;
        }
        try {
          await client.patchSession({
            key: currentSessionKey,
            groupActivation: args === "always" ? "always" : "mention",
          });
          chatLog.addSystem(`activation set to ${args}`);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`activation failed: ${String(err)}`);
        }
        break;
      case "deliver":
        if (!args) {
          chatLog.addSystem("usage: /deliver <on|off>");
          break;
        }
        deliverDefault = args === "on";
        updateFooter();
        chatLog.addSystem(`deliver ${deliverDefault ? "on" : "off"}`);
        break;
      case "new":
      case "reset":
        try {
          await client.resetSession(currentSessionKey);
          chatLog.addSystem(`session ${currentSessionKey} reset`);
          await loadHistory();
        } catch (err) {
          chatLog.addSystem(`reset failed: ${String(err)}`);
        }
        break;
      case "abort":
        await abortActive();
        break;
      case "settings":
        openSettings();
        break;
      case "exit":
      case "quit":
        client.stop();
        tui.stop();
        process.exit(0);
        break;
      default:
        chatLog.addSystem(`unknown command: /${name}`);
        break;
    }
    tui.requestRender();
  };

  const sendMessage = async (text: string) => {
    try {
      chatLog.addUser(text);
      tui.requestRender();
      setStatus("sending");
      const { runId } = await client.sendChat({
        sessionKey: currentSessionKey,
        message: text,
        thinking: opts.thinking,
        deliver: deliverDefault,
        timeoutMs: opts.timeoutMs,
      });
      activeChatRunId = runId;
      setStatus("waiting");
    } catch (err) {
      chatLog.addSystem(`send failed: ${String(err)}`);
      setStatus("error");
    }
    tui.requestRender();
  };

  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(getSlashCommands(), process.cwd()),
  );
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
      setStatus("cleared input");
      tui.requestRender();
      return;
    }
    if (now - lastCtrlCAt < 1000) {
      client.stop();
      tui.stop();
      process.exit(0);
    }
    lastCtrlCAt = now;
    setStatus("press ctrl+c again to exit");
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
    setStatus(toolsExpanded ? "tools expanded" : "tools collapsed");
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
    setStatus("connected");
    void (async () => {
      await refreshAgents();
      updateHeader();
      if (!historyLoaded) {
        await loadHistory();
        chatLog.addSystem("gateway connected");
        tui.requestRender();
        if (!autoMessageSent && autoMessage) {
          autoMessageSent = true;
          await sendMessage(autoMessage);
        }
      } else {
        chatLog.addSystem("gateway reconnected");
      }
      updateFooter();
      tui.requestRender();
    })();
  };

  client.onDisconnected = (reason) => {
    isConnected = false;
    chatLog.addSystem(`gateway disconnected: ${reason || "closed"}`);
    setStatus("disconnected");
    updateFooter();
    tui.requestRender();
  };

  client.onGap = (info) => {
    chatLog.addSystem(
      `event gap: expected ${info.expected}, got ${info.received}`,
    );
    tui.requestRender();
  };

  updateHeader();
  setStatus("connecting");
  updateFooter();
  chatLog.addSystem("connecting...");
  tui.start();
  client.start();
}
