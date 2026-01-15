import type { TUI } from "@mariozechner/pi-tui";
import type { ChatLog } from "./components/chat-log.js";
import { asString, extractTextFromMessage, resolveFinalAssistantText } from "./tui-formatters.js";
import type { AgentEvent, ChatEvent, TuiStateAccess } from "./tui-types.js";

type EventHandlerContext = {
  chatLog: ChatLog;
  tui: TUI;
  state: TuiStateAccess;
  setActivityStatus: (text: string) => void;
};

export function createEventHandlers(context: EventHandlerContext) {
  const { chatLog, tui, state, setActivityStatus } = context;
  const finalizedRuns = new Map<string, number>();

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
    if (evt.sessionKey !== state.currentSessionKey) return;
    if (finalizedRuns.has(evt.runId)) {
      if (evt.state === "delta") return;
      if (evt.state === "final") return;
    }
    if (evt.state === "delta") {
      const text = extractTextFromMessage(evt.message, {
        includeThinking: state.showThinking,
      });
      if (!text) return;
      chatLog.updateAssistant(text, evt.runId);
      setActivityStatus("streaming");
    }
    if (evt.state === "final") {
      const stopReason =
        evt.message && typeof evt.message === "object" && !Array.isArray(evt.message)
          ? typeof (evt.message as Record<string, unknown>).stopReason === "string"
            ? ((evt.message as Record<string, unknown>).stopReason as string)
            : ""
          : "";
      const text = extractTextFromMessage(evt.message, {
        includeThinking: state.showThinking,
      });
      const finalText = resolveFinalAssistantText({
        finalText: text,
        streamedText: chatLog.getStreamingText(evt.runId),
      });
      chatLog.finalizeAssistant(finalText, evt.runId);
      noteFinalizedRun(evt.runId);
      state.activeChatRunId = null;
      setActivityStatus(stopReason === "error" ? "error" : "idle");
    }
    if (evt.state === "aborted") {
      chatLog.addSystem("run aborted");
      state.activeChatRunId = null;
      setActivityStatus("aborted");
    }
    if (evt.state === "error") {
      chatLog.addSystem(`run error: ${evt.errorMessage ?? "unknown"}`);
      state.activeChatRunId = null;
      setActivityStatus("error");
    }
    tui.requestRender();
  };

  const handleAgentEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const evt = payload as AgentEvent;
    if (!state.currentSessionId || evt.runId !== state.currentSessionId) return;
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
      if (phase === "start") setActivityStatus("running");
      if (phase === "end") setActivityStatus("idle");
      if (phase === "error") setActivityStatus("error");
      tui.requestRender();
    }
  };

  return { handleChatEvent, handleAgentEvent };
}
