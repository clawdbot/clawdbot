// Implements TUI slash command handlers and backend action dispatch.
import { randomUUID } from "node:crypto";
import type { Component, OverlayHandle, SelectItem, TUI } from "@earendil-works/pi-tui";
import type { SessionsPatchResult } from "../../packages/gateway-protocol/src/index.js";
import { modelKey } from "../agents/model-ref-shared.js";
import { shouldForwardModelCommandToServer } from "../auto-reply/commands-registry.shared.js";
import { normalizeGroupActivation } from "../auto-reply/group-activation.js";
import {
  formatGoalContinuationPrompt,
  formatGoalResumeContinuationPrompt,
  parseGoalCommand,
} from "../auto-reply/reply/commands-goal.js";
import {
  formatThinkingLevels,
  isSessionDefaultDirectiveValue,
  normalizeUsageDisplay,
  resolveResponseUsageMode,
} from "../auto-reply/thinking.js";
import { isChatStopCommandText } from "../gateway/chat-abort.js";
import { formatRelativeTimestamp } from "../infra/format-time/format-relative.ts";
import { normalizeAgentId } from "../routing/session-key.js";
import { helpText, isSharedTextCommand, parseCommand } from "./commands.js";
import type { ChatLog } from "./components/chat-log.js";
import {
  createFilterableSelectList,
  createSearchableSelectList,
  createSettingsList,
} from "./components/selectors.js";
import type { TuiBackend, TuiSessionMutationResult } from "./tui-backend.js";
import { addBlockedChatSubmitNotice } from "./tui-busy-notice.js";
import { sanitizeRenderableText } from "./tui-formatters.js";
import {
  TUI_RECENT_SESSIONS_ACTIVE_MINUTES,
  TUI_SESSION_PICKER_LIMIT,
} from "./tui-session-list-policy.js";
import { formatStatusSummary } from "./tui-status-summary.js";
import {
  acceptPendingSubmit,
  beginPendingSubmit,
  clearPendingSubmit,
  disconnectedTuiChatSubmitMessage,
  hasPendingSubmit,
} from "./tui-submit-state.js";
import type {
  AgentSummary,
  GatewayStatusSummary,
  TuiResult,
  TuiOptions,
  TuiStateAccess,
} from "./tui-types.js";

function formatTuiFastMode(mode: unknown): "auto" | "on" | "off" {
  return mode === "auto" ? "auto" : mode === true ? "on" : "off";
}

type CommandHandlerContext = {
  client: TuiBackend;
  chatLog: ChatLog;
  tui: TUI;
  opts: TuiOptions;
  state: TuiStateAccess;
  deliverDefault: boolean;
  openOverlay: (component: Component) => OverlayHandle;
  closeOverlay: (handle?: OverlayHandle) => void;
  refreshSessionInfo: () => Promise<void>;
  loadHistory: () => Promise<unknown>;
  setSession: (key: string) => Promise<void>;
  refreshAgents: () => Promise<void>;
  abortActive: (params?: { preferActive?: boolean }) => Promise<void>;
  setActivityStatus: (text: string) => void;
  formatSessionKey: (key: string) => string;
  applySessionInfoFromPatch: (result: SessionsPatchResult) => void;
  applySessionMutationResult: (result?: TuiSessionMutationResult | null) => boolean;
  noteLocalRunId?: (runId: string) => void;
  noteLocalBtwRunId?: (runId: string) => void;
  forgetLocalRunId?: (runId: string) => void;
  forgetLocalBtwRunId?: (runId: string) => void;
  consumeCompletedRunForPendingSend?: (runId: string) => boolean;
  isRunObserved?: (runId: string) => boolean;
  flushPendingHistoryRefreshIfIdle?: () => void;
  runAuthFlow?: (params: {
    provider?: string;
  }) => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  requestExit: (result?: Partial<TuiResult>) => void;
};

function isBtwCommand(text: string): boolean {
  return /^\/(?:btw|side)(?::|\s|$)/i.test(text.trim());
}

function isSlashStopCommand(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("/") && isChatStopCommandText(trimmed);
}

function normalizedChatSendAckStatus(status: unknown): string {
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

function isTerminalChatSendAckFailure(status: unknown): boolean {
  const normalized = normalizedChatSendAckStatus(status);
  return normalized === "timeout" || normalized === "error";
}

function isTerminalChatSendAckSuccess(status: unknown): boolean {
  return normalizedChatSendAckStatus(status) === "ok";
}

const TERMINAL_CHAT_SEND_FAILURE_MESSAGE = "Chat failed before the run started; try again.";

function goalContinuationPrompt(text: string): string | null {
  const parsed = parseGoalCommand(text);
  if (!parsed) {
    return null;
  }
  const action = parsed.action;
  if (action === "start" || action === "set" || action === "create") {
    return formatGoalContinuationPrompt(parsed.text) || null;
  }
  if (action === "resume") {
    return formatGoalResumeContinuationPrompt(parsed.text);
  }
  return null;
}

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
    applySessionInfoFromPatch,
    applySessionMutationResult,
    noteLocalRunId,
    noteLocalBtwRunId,
    forgetLocalRunId,
    forgetLocalBtwRunId,
    consumeCompletedRunForPendingSend,
    isRunObserved,
    flushPendingHistoryRefreshIfIdle,
    runAuthFlow,
    requestExit,
  } = context;
  let sessionCreationInFlight = false;

  const addUnsupportedLocalCommand = (name: string) => {
    chatLog.addSystem(`/${name} is not available in local embedded mode; message not sent`);
  };

  const setAgent = async (id: string) => {
    state.currentAgentId = normalizeAgentId(id);
    await setSession("");
    chatLog.addSystem(`agent set to ${state.currentAgentId}; use /openclaw to return`);
  };

  const closeOverlayAndRender = (handle: OverlayHandle) => {
    closeOverlay(handle);
    tui.requestRender();
  };

  const hasTrackedAbortTarget = () => Boolean(state.activeChatRunId || hasPendingSubmit(state));

  const hasUnsafeSessionRollover = () =>
    hasTrackedAbortTarget() || state.activityStatus === "finishing context";

  const currentSessionPatchTarget = () => ({
    key: state.currentSessionKey,
    ...(state.currentSessionKey === "global" ? { agentId: state.currentAgentId } : {}),
  });

  const openSelector = (
    selector: {
      onSelect?: (item: SelectItem) => void;
      onCancel?: () => void;
    },
    onSelect: (value: string) => Promise<void>,
  ) => {
    selector.onSelect = (item) => {
      void (async () => {
        await onSelect(item.value);
        closeOverlayAndRender(overlayHandle);
      })();
    };
    selector.onCancel = () => closeOverlayAndRender(overlayHandle);
    const overlayHandle: OverlayHandle = openOverlay(selector as Component);
    tui.requestRender();
  };

  const openModelSelector = async () => {
    try {
      chatLog.addSystem("loading models...");
      tui.requestRender();
      const models = await client.listModels();
      if (models.length === 0) {
        chatLog.addSystem("no models available");
        tui.requestRender();
        return;
      }
      const items = models.map((model) => {
        const ref = modelKey(model.provider, model.id);
        return {
          value: ref,
          label: ref,
          description: model.name && model.name !== model.id ? model.name : "",
        };
      });
      const selector = createSearchableSelectList(items, 9);
      openSelector(selector, async (value) => {
        try {
          const result = await client.patchSession({
            ...currentSessionPatchTarget(),
            model: value,
          });
          chatLog.addSystem(`model set to ${value}`);
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`model set failed: ${String(err)}`);
        }
      });
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
    openSelector(selector, async (value) => {
      await setAgent(value);
    });
  };

  const openContextModeSelector = () => {
    const items = [
      {
        value: "list",
        label: "list",
        description: "Short context breakdown",
      },
      {
        value: "detail",
        label: "detail",
        description: "Per-file, per-tool, per-skill, and system prompt size",
      },
      {
        value: "json",
        label: "json",
        description: "Machine-readable context report",
      },
    ];
    const selector = createSearchableSelectList(items, 9);
    openSelector(selector, async (value) => {
      await sendMessage(`/context ${value}`);
    });
  };

  const openSessionSelector = async () => {
    try {
      const result = await client.listSessions({
        limit: TUI_SESSION_PICKER_LIMIT,
        activeMinutes: TUI_RECENT_SESSIONS_ACTIVE_MINUTES,
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
        const timePart = session.updatedAt
          ? formatRelativeTimestamp(session.updatedAt, { dateFallback: true, fallback: "" })
          : "";
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
      openSelector(selector, async (value) => {
        await setSession(value);
      });
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
        closeOverlay(overlayHandle);
        tui.requestRender();
      },
    );
    const overlayHandle: OverlayHandle = openOverlay(settings);
    tui.requestRender();
  };

  const handleCommand = async (raw: string) => {
    const { name, args } = parseCommand(raw);
    if (!name) {
      return;
    }
    if (sessionCreationInFlight && name !== "exit" && name !== "quit") {
      chatLog.addSystem("session change in progress; wait for /new to finish");
      tui.requestRender();
      return;
    }
    switch (name) {
      case "help":
        chatLog.addSystem(
          helpText({
            local: opts.local,
            provider: state.sessionInfo.modelProvider,
            model: state.sessionInfo.model,
            agentRuntime: state.sessionInfo.agentRuntime?.id,
          }),
        );
        break;
      case "auth": {
        if (!runAuthFlow) {
          chatLog.addSystem("auth login is only available in local embedded mode");
          break;
        }
        if (state.activeChatRunId || hasPendingSubmit(state)) {
          chatLog.addSystem("abort the current run before /auth");
          break;
        }
        const provider = args.trim() || state.sessionInfo.modelProvider || undefined;
        chatLog.addSystem(
          provider
            ? `opening auth flow for ${provider}; TUI will resume when it exits`
            : "opening auth flow; TUI will resume when it exits",
        );
        tui.requestRender();
        setActivityStatus("auth");
        try {
          const result = await runAuthFlow({ provider });
          await refreshSessionInfo();
          if (result.exitCode === 0 && !result.signal) {
            chatLog.addSystem(
              provider ? `auth flow finished for ${provider}` : "auth flow finished",
            );
            setActivityStatus("idle");
          } else {
            const failureSuffix = result.signal
              ? ` (signal ${result.signal})`
              : typeof result.exitCode === "number"
                ? ` (exit ${String(result.exitCode)})`
                : "";
            chatLog.addSystem(`auth flow failed${failureSuffix}`);
            setActivityStatus("error");
          }
        } catch (err) {
          chatLog.addSystem(`auth flow failed: ${sanitizeRenderableText(String(err))}`);
          setActivityStatus("error");
        }
        break;
      }
      case "gateway-status":
        try {
          const status = await client.getGatewayStatus();
          if (typeof status === "string") {
            chatLog.addSystem(status);
            break;
          }
          if (status && typeof status === "object") {
            const lines = formatStatusSummary(status as GatewayStatusSummary);
            for (const line of lines) {
              chatLog.addSystem(line);
            }
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
      case "context":
        if (opts.local) {
          addUnsupportedLocalCommand(name);
        } else if (!args) {
          openContextModeSelector();
        } else {
          await sendMessage(raw);
        }
        break;
      case "goal":
        if (opts.local === true && client.runGoalCommand) {
          try {
            const result = await client.runGoalCommand({
              sessionKey: state.currentSessionKey,
              agentId: state.currentAgentId,
              command: raw,
            });
            chatLog.addSystem(result.text);
            await refreshSessionInfo();
            const continuation = goalContinuationPrompt(raw);
            if (continuation) {
              await sendMessage(continuation);
            }
          } catch (err) {
            chatLog.addSystem(`goal failed: ${sanitizeRenderableText(String(err))}`);
          }
        } else {
          await sendMessage(raw);
        }
        break;
      case "btw":
        if (args) {
          await sendMessage(raw);
        } else {
          chatLog.addSystem("Usage: /btw [side question]");
        }
        break;
      case "openclaw":
        chatLog.addSystem(
          args ? `returning to OpenClaw with request: ${args}` : "returning to OpenClaw",
        );
        requestExit({
          exitReason: "return-to-system-agent",
          ...(args ? { systemAgentMessage: args } : {}),
        });
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
        if (shouldForwardModelCommandToServer(args)) {
          await sendMessage(raw);
        } else if (!args) {
          await openModelSelector();
        } else {
          try {
            const result = await client.patchSession({
              ...currentSessionPatchTarget(),
              model: args,
            });
            const resolvedModel = result.resolved?.model;
            const resolvedProvider = result.resolved?.modelProvider;
            const resolvedModelRef = resolvedModel
              ? resolvedProvider
                ? modelKey(resolvedProvider, resolvedModel)
                : resolvedModel
              : args;
            chatLog.addSystem(`model set to ${resolvedModelRef}`);
            applySessionInfoFromPatch(result);
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
          const levels =
            state.sessionInfo.thinkingLevels?.map((level) => level.label).join("|") ||
            formatThinkingLevels(
              state.sessionInfo.modelProvider,
              state.sessionInfo.model,
              "|",
              undefined,
              state.sessionInfo.agentRuntime?.id,
            );
          chatLog.addSystem(`usage: /think <${levels}>`);
          break;
        }
        try {
          const result = await client.patchSession({
            ...currentSessionPatchTarget(),
            thinkingLevel: args,
          });
          chatLog.addSystem(`thinking set to ${args}`);
          applySessionInfoFromPatch(result);
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
          const result = await client.patchSession({
            ...currentSessionPatchTarget(),
            verboseLevel: args,
          });
          chatLog.addSystem(`verbose set to ${args}`);
          applySessionInfoFromPatch(result);
          if (args === "off") {
            chatLog.clearTools();
            await refreshSessionInfo();
          } else {
            await loadHistory();
          }
        } catch (err) {
          chatLog.addSystem(`verbose failed: ${String(err)}`);
        }
        break;
      case "trace":
        if (!args) {
          chatLog.addSystem("usage: /trace <on|off>");
          break;
        }
        try {
          const result = await client.patchSession({
            ...currentSessionPatchTarget(),
            traceLevel: args,
          });
          chatLog.addSystem(`trace set to ${args}`);
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`trace failed: ${String(err)}`);
        }
        break;
      case "fast":
        if (!args || args === "status") {
          chatLog.addSystem(`fast mode: ${formatTuiFastMode(state.sessionInfo.fastMode)}`);
          break;
        }
        if (args !== "auto" && args !== "on" && args !== "off") {
          chatLog.addSystem("usage: /fast <status|auto|on|off>");
          break;
        }
        try {
          const result = await client.patchSession({
            ...currentSessionPatchTarget(),
            fastMode: args === "auto" ? "auto" : args === "on",
          });
          chatLog.addSystem(`fast mode set to ${args}`);
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`fast failed: ${String(err)}`);
        }
        break;
      case "reasoning":
        if (!args) {
          chatLog.addSystem("usage: /reasoning <on|off>");
          break;
        }
        try {
          const result = await client.patchSession({
            ...currentSessionPatchTarget(),
            reasoningLevel: args,
          });
          chatLog.addSystem(`reasoning set to ${args}`);
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`reasoning failed: ${String(err)}`);
        }
        break;
      case "usage": {
        const isReset = args ? isSessionDefaultDirectiveValue(args) : false;
        const normalized = args && !isReset ? normalizeUsageDisplay(args) : undefined;
        if (args && !normalized && !isReset) {
          chatLog.addSystem("usage: /usage <off|tokens|full|reset>");
          break;
        }
        if (isReset) {
          try {
            const result = await client.patchSession({
              ...currentSessionPatchTarget(),
              responseUsage: null,
            });
            chatLog.addSystem("usage footer: reset to default");
            applySessionInfoFromPatch(result);
            delete state.sessionInfo.responseUsage;
            delete state.sessionInfo.effectiveResponseUsage;
            await refreshSessionInfo();
          } catch (err) {
            chatLog.addSystem(`usage failed: ${String(err)}`);
          }
          break;
        }
        const current =
          state.sessionInfo.effectiveResponseUsage ??
          resolveResponseUsageMode(state.sessionInfo.responseUsage);
        const next =
          normalized ?? (current === "off" ? "tokens" : current === "tokens" ? "full" : "off");
        try {
          const result = await client.patchSession({
            ...currentSessionPatchTarget(),
            responseUsage: next,
          });
          chatLog.addSystem(`usage footer: ${next}`);
          applySessionInfoFromPatch(result);
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
          const result = await client.patchSession({
            ...currentSessionPatchTarget(),
            elevatedLevel: args,
          });
          chatLog.addSystem(`elevated set to ${args}`);
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`elevated failed: ${String(err)}`);
        }
        break;
      case "activation": {
        if (!args) {
          chatLog.addSystem("usage: /activation <mention|always>");
          break;
        }
        const activation = normalizeGroupActivation(args);
        if (!activation) {
          chatLog.addSystem("usage: /activation <mention|always>");
          break;
        }
        try {
          const result = await client.patchSession({
            ...currentSessionPatchTarget(),
            groupActivation: activation,
          });
          chatLog.addSystem(`activation set to ${activation}`);
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`activation failed: ${String(err)}`);
        }
        break;
      }
      case "new":
        if (hasUnsafeSessionRollover()) {
          chatLog.addSystem("abort the current run before /new");
          tui.requestRender();
          break;
        }
        sessionCreationInFlight = true;
        try {
          // Clear token counts immediately to avoid stale display (#1523)
          state.sessionInfo.inputTokens = null;
          state.sessionInfo.outputTokens = null;
          state.sessionInfo.totalTokens = null;
          tui.requestRender();

          const uniqueKey = `tui-${randomUUID()}`;
          const result = await client.createSession({
            key: uniqueKey,
            agentId: state.currentAgentId,
            ...(state.currentSessionId ? { parentSessionKey: state.currentSessionKey } : {}),
          });
          if (!result.key) {
            throw new Error("sessions.create returned no session key");
          }
          await setSession(result.key);
          chatLog.addSystem(`new session: ${result.key}`);
        } catch (err) {
          chatLog.addSystem(`new session failed: ${sanitizeRenderableText(String(err))}`);
        } finally {
          sessionCreationInFlight = false;
        }
        break;
      case "reset":
        try {
          // Clear token counts immediately to avoid stale display (#1523)
          state.sessionInfo.inputTokens = null;
          state.sessionInfo.outputTokens = null;
          state.sessionInfo.totalTokens = null;
          tui.requestRender();

          const result = await client.resetSession(
            state.currentSessionKey,
            name,
            state.currentSessionKey === "global" ? { agentId: state.currentAgentId } : undefined,
          );
          if (applySessionMutationResult(result)) {
            await refreshSessionInfo();
          } else {
            await loadHistory();
          }
          chatLog.addSystem(`session ${state.currentSessionKey} reset`);
        } catch (err) {
          chatLog.addSystem(`reset failed: ${sanitizeRenderableText(String(err))}`);
        }
        break;
      case "abort":
        await abortActive();
        break;
      case "stop":
        // Queued client runs can terminalize before the followup executes, so
        // local run ids are not a complete stop target inventory.
        await abortActive({ preferActive: true });
        break;
      case "settings":
        openSettings();
        break;
      case "exit":
      case "quit":
        requestExit();
        break;
      default: {
        if (opts.local && isSharedTextCommand(raw)) {
          addUnsupportedLocalCommand(name);
          break;
        }
        await sendMessage(raw);
        break;
      }
    }
    tui.requestRender();
  };

  const sendMessage = async (text: string) => {
    if (!state.isConnected) {
      chatLog.addSystem(disconnectedTuiChatSubmitMessage(opts.local === true));
      setActivityStatus("disconnected");
      tui.requestRender();
      return;
    }
    if (sessionCreationInFlight) {
      chatLog.addSystem("session change in progress; message not sent");
      tui.requestRender();
      return;
    }
    const isBtw = isBtwCommand(text);
    const busy = Boolean(state.activeChatRunId || hasPendingSubmit(state));
    if (
      isSlashStopCommand(text) ||
      (hasTrackedAbortTarget() && busy && isChatStopCommandText(text))
    ) {
      await abortActive({ preferActive: true });
      return;
    }
    // The Gateway owns queue policy. TUI only serializes pending RPC admission;
    // an already-active run must not suppress steer/followup/collect/interrupt.
    if (!isBtw && hasPendingSubmit(state)) {
      addBlockedChatSubmitNotice(chatLog);
      tui.requestRender();
      return;
    }
    const runId = randomUUID();
    try {
      if (!isBtw) {
        if (opts.local === true && state.activeChatRunId && !hasPendingSubmit(state)) {
          chatLog.reserveAssistantSlot(state.activeChatRunId);
        }
        chatLog.addPendingUser(runId, text);
        beginPendingSubmit(state, runId, text);
        noteLocalRunId?.(runId);
        setActivityStatus("sending");
      } else {
        noteLocalBtwRunId?.(runId);
      }
      tui.requestRender();
      const sendResult = await client.sendChat({
        sessionKey: state.currentSessionKey,
        ...(state.currentSessionKey === "global" ? { agentId: state.currentAgentId } : {}),
        sessionId: state.currentSessionId,
        message: text,
        thinking: opts.thinking,
        deliver: deliverDefault,
        timeoutMs: opts.timeoutMs,
        runId,
      });
      const acceptedRunId = sendResult.runId || runId;
      const terminalAckFailure = isTerminalChatSendAckFailure(sendResult.status);
      const terminalAckSuccess = isTerminalChatSendAckSuccess(sendResult.status);
      const terminalAck = terminalAckFailure || terminalAckSuccess;
      if (isBtw && terminalAck) {
        forgetLocalBtwRunId?.(runId);
        if (acceptedRunId !== runId) {
          forgetLocalBtwRunId?.(acceptedRunId);
        }
        if (terminalAckFailure) {
          chatLog.addSystem(`btw failed: ${TERMINAL_CHAT_SEND_FAILURE_MESSAGE}`);
        }
        tui.requestRender();
        return;
      }
      if (isBtw) {
        if (acceptedRunId !== runId) {
          forgetLocalBtwRunId?.(runId);
          noteLocalBtwRunId?.(acceptedRunId);
        }
        return;
      }
      if (!isBtw) {
        const acceptedRunAlreadyCompleted =
          acceptedRunId !== runId &&
          !terminalAck &&
          (consumeCompletedRunForPendingSend?.(acceptedRunId) ?? false);
        acceptPendingSubmit({
          state,
          provisionalRunId: runId,
          acceptedRunId,
          // A run observed before its ACK owns its rendered row already.
          preserveDraft: !(isRunObserved?.(acceptedRunId) || terminalAck),
        });
        if (acceptedRunId !== runId) {
          forgetLocalRunId?.(runId);
          if (!acceptedRunAlreadyCompleted && !terminalAck) {
            noteLocalRunId?.(acceptedRunId);
          }
          chatLog.rekeyPendingUser(runId, acceptedRunId);
        }
        if (terminalAck) {
          clearPendingSubmit(state, acceptedRunId);
          forgetLocalRunId?.(acceptedRunId);
          if (terminalAckFailure) {
            chatLog.dropPendingUser(acceptedRunId);
          }
          if (state.activeChatRunId === acceptedRunId) {
            state.activeChatRunId = null;
          }
          await loadHistory();
          if (terminalAckFailure) {
            chatLog.addSystem(`send failed: ${TERMINAL_CHAT_SEND_FAILURE_MESSAGE}`);
            setActivityStatus("error");
          } else {
            setActivityStatus("idle");
          }
          tui.requestRender();
          return;
        }
        if (hasPendingSubmit(state)) {
          if (acceptedRunAlreadyCompleted) {
            clearPendingSubmit(state, acceptedRunId);
            setActivityStatus("idle");
            flushPendingHistoryRefreshIfIdle?.();
          } else {
            setActivityStatus("waiting");
          }
          tui.requestRender();
        }
      }
    } catch (err) {
      if (isBtw) {
        forgetLocalBtwRunId?.(runId);
      }
      if (!isBtw && state.activeChatRunId && state.activeChatRunId === runId) {
        forgetLocalRunId?.(state.activeChatRunId);
      }
      if (!isBtw) {
        forgetLocalRunId?.(runId);
      }
      if (!isBtw) {
        // Only clear the failed send's ownership. A queued run may have
        // terminalized or handed ownership off while the RPC was pending.
        if (state.activeChatRunId === runId) {
          state.activeChatRunId = null;
        }
        clearPendingSubmit(state, runId);
        chatLog.dropPendingUser(runId);
      }
      chatLog.addSystem(`${isBtw ? "btw failed" : "send failed"}: ${String(err)}`);
      if (!isBtw) {
        setActivityStatus("error");
      }
      tui.requestRender();
    }
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
