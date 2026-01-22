import type { Component, TUI } from "@mariozechner/pi-tui";
import {
  formatThinkingLevels,
  normalizeUsageDisplay,
  resolveResponseUsageMode,
} from "../auto-reply/thinking.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { formatRelativeTime } from "../utils/time-format.js";
import { helpText, parseCommand } from "./commands.js";
import type { ChatLog } from "./components/chat-log.js";
import {
  createFilterableSelectList,
  createSearchableSelectList,
  createSettingsList,
} from "./components/selectors.js";
import type { GatewayChatClient } from "./gateway-chat.js";
import { formatStatusSummary } from "./tui-status-summary.js";
import type {
  AgentSummary,
  GatewayStatusSummary,
  TuiOptions,
  TuiStateAccess,
} from "./tui-types.js";

type CommandHandlerContext = {
  client: GatewayChatClient;
  chatLog: ChatLog;
  tui: TUI;
  opts: TuiOptions;
  state: TuiStateAccess;
  deliverDefault: boolean;
  openOverlay: (component: Component) => void;
  closeOverlay: () => void;
  refreshSessionInfo: () => Promise<void>;
  loadHistory: () => Promise<void>;
  setSession: (key: string) => Promise<void>;
  refreshAgents: () => Promise<void>;
  abortActive: () => Promise<void>;
  setActivityStatus: (text: string) => void;
  formatSessionKey: (key: string) => string;
};

export function createCommandHandlers(context: CommandHandlerContext) {
  const {
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
  } = context;

  const setAgent = async (id: string) => {
    state.currentAgentId = normalizeAgentId(id);
    await setSession("");
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
      const selector = createSearchableSelectList(items, 9);
      selector.onSelect = (item) => {
        void (async () => {
          try {
            await client.patchSession({
              key: state.currentSessionKey,
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

  const openAgentSelector = async () => {
    await refreshAgents();
    if (state.agents.length === 0) {
      chatLog.addSystem("no agents found");
      tui.requestRender();
      return;
    }
    const items = state.agents.map((agent: AgentSummary) => ({
      value: agent.id,
      label: agent.name ? `${agent.id} (${agent.name})` : agent.id,
      description: agent.id === state.agentDefaultId ? "default" : "",
    }));
    const selector = createSearchableSelectList(items, 9);
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
        includeDerivedTitles: true,
        includeLastMessage: true,
        agentId: state.currentAgentId,
      });
      const items = result.sessions.map((session) => {
        const title = session.derivedTitle ?? session.displayName;
        const formattedKey = formatSessionKey(session.key);
        // Avoid redundant "title (key)" when title matches key
        const label = title && title !== formattedKey ? `${title} (${formattedKey})` : formattedKey;
        // Build description: time + message preview
        const timePart = session.updatedAt ? formatRelativeTime(session.updatedAt) : "";
        const preview = session.lastMessagePreview?.replace(/\s+/g, " ").trim();
        const description =
          timePart && preview ? `${timePart} · ${preview}` : (preview ?? timePart);
        return {
          value: session.key,
          label,
          description,
          searchText: [
            session.displayName,
            session.label,
            session.subject,
            session.sessionId,
            session.key,
            session.lastMessagePreview,
          ]
            .filter(Boolean)
            .join(" "),
        };
      });
      const selector = createFilterableSelectList(items, 9);
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
        id: "tools",
        label: "Tool output",
        currentValue: state.toolsExpanded ? "expanded" : "collapsed",
        values: ["collapsed", "expanded"],
      },
      {
        id: "thinking",
        label: "Show thinking",
        currentValue: state.showThinking ? "on" : "off",
        values: ["off", "on"],
      },
    ];
    const settings = createSettingsList(
      items,
      (id, value) => {
        if (id === "tools") {
          state.toolsExpanded = value === "expanded";
          chatLog.setToolsExpanded(state.toolsExpanded);
        }
        if (id === "thinking") {
          state.showThinking = value === "on";
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
        chatLog.addSystem(
          helpText({
            provider: state.sessionInfo.modelProvider,
            model: state.sessionInfo.model,
          }),
        );
        break;
      case "status":
        try {
          const status = await client.getStatus();
          if (typeof status === "string") {
            chatLog.addSystem(status);
            break;
          }
          if (status && typeof status === "object") {
            const lines = formatStatusSummary(status as GatewayStatusSummary);
            for (const line of lines) chatLog.addSystem(line);
            break;
          }
          chatLog.addSystem("status: unknown response");
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
              key: state.currentSessionKey,
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
          const levels = formatThinkingLevels(
            state.sessionInfo.modelProvider,
            state.sessionInfo.model,
            "|",
          );
          chatLog.addSystem(`usage: /think <${levels}>`);
          break;
        }
        try {
          await client.patchSession({
            key: state.currentSessionKey,
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
            key: state.currentSessionKey,
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
            key: state.currentSessionKey,
            reasoningLevel: args,
          });
          chatLog.addSystem(`reasoning set to ${args}`);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`reasoning failed: ${String(err)}`);
        }
        break;
      case "usage": {
        const normalized = args ? normalizeUsageDisplay(args) : undefined;
        if (args && !normalized) {
          chatLog.addSystem("usage: /usage <off|tokens|full>");
          break;
        }
        const currentRaw = state.sessionInfo.responseUsage;
        const current = resolveResponseUsageMode(currentRaw);
        const next =
          normalized ?? (current === "off" ? "tokens" : current === "tokens" ? "full" : "off");
        try {
          await client.patchSession({
            key: state.currentSessionKey,
            responseUsage: next === "off" ? null : next,
          });
          chatLog.addSystem(`usage footer: ${next}`);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`usage failed: ${String(err)}`);
        }
        break;
      }
      case "elevated":
        if (!args) {
          chatLog.addSystem("usage: /elevated <on|off|ask|full>");
          break;
        }
        if (!["on", "off", "ask", "full"].includes(args)) {
          chatLog.addSystem("usage: /elevated <on|off|ask|full>");
          break;
        }
        try {
          await client.patchSession({
            key: state.currentSessionKey,
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
            key: state.currentSessionKey,
            groupActivation: args === "always" ? "always" : "mention",
          });
          chatLog.addSystem(`activation set to ${args}`);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`activation failed: ${String(err)}`);
        }
        break;
      case "new":
      case "reset":
        try {
          await client.resetSession(state.currentSessionKey);
          chatLog.addSystem(`session ${state.currentSessionKey} reset`);
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
      setActivityStatus("sending");
      const { runId } = await client.sendChat({
        sessionKey: state.currentSessionKey,
        message: text,
        thinking: opts.thinking,
        deliver: deliverDefault,
        timeoutMs: opts.timeoutMs,
      });
      state.activeChatRunId = runId;
      setActivityStatus("waiting");
    } catch (err) {
      chatLog.addSystem(`send failed: ${String(err)}`);
      setActivityStatus("error");
    }
    tui.requestRender();
  };

  return {
    handleCommand,
    sendMessage,
    openModelSelector,
    openAgentSelector,
    openSessionSelector,
    openSettings,
    setAgent,
  };
}
