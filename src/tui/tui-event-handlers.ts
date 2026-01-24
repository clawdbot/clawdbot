import type { TUI } from "@mariozechner/pi-tui";
import type { ChatLog } from "./components/chat-log.js";
import { asString, extractTextFromMessage, isCommandMessage } from "./tui-formatters.js";
import { TuiStreamAssembler } from "./tui-stream-assembler.js";
import type { AgentEvent, ChatEvent, TuiStateAccess } from "./tui-types.js";

type EventHandlerContext = {
  chatLog: ChatLog;
  tui: TUI;
  state: TuiStateAccess;
  setActivityStatus: (text: string) => void;
  refreshSessionInfo?: () => Promise<void>;
};

export function createEventHandlers(context: EventHandlerContext) {
  const { chatLog, tui, state, setActivityStatus, refreshSessionInfo } = context;
  const finalizedRuns = new Map<string, number>();
  const sessionRuns = new Map<string, number>();
  let streamAssembler = new TuiStreamAssembler();
  let lastSessionKey = state.currentSessionKey;

  const pruneRunMap = (runs: Map<string, number>) => {
    if (runs.size <= 200) return;
    const keepUntil = Date.now() - 10 * 60 * 1000;
    for (const [key, ts] of runs) {
      if (runs.size <= 150) break;
      if (ts < keepUntil) runs.delete(key);
    }
    if (runs.size > 200) {
      for (const key of runs.keys()) {
        runs.delete(key);
        if (runs.size <= 150) break;
      }
    }
  };

  const syncSessionKey = () => {
    if (state.currentSessionKey === lastSessionKey) return;
    lastSessionKey = state.currentSessionKey;
    finalizedRuns.clear();
    sessionRuns.clear();
    streamAssembler = new TuiStreamAssembler();
  };

  const noteSessionRun = (runId: string) => {
    sessionRuns.set(runId, Date.now());
    pruneRunMap(sessionRuns);
  };

  const noteFinalizedRun = (runId: string) => {
    finalizedRuns.set(runId, Date.now());
    sessionRuns.delete(runId);
    streamAssembler.drop(runId);
    pruneRunMap(finalizedRuns);
  };

  const handleChatEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const evt = payload as ChatEvent;
    syncSessionKey();
    if (evt.sessionKey !== state.currentSessionKey) return;
    if (finalizedRuns.has(evt.runId)) {
      if (evt.state === "delta") return;
      if (evt.state === "final") return;
    }
    noteSessionRun(evt.runId);
    if (!state.activeChatRunId) {
      state.activeChatRunId = evt.runId;
    }
    if (evt.state === "delta") {
      const displayText = streamAssembler.ingestDelta(evt.runId, evt.message, state.showThinking);
      if (!displayText) return;
      chatLog.updateAssistant(displayText, evt.runId);
      setActivityStatus("streaming");
    }
    if (evt.state === "final") {
      if (isCommandMessage(evt.message)) {
        const text = extractTextFromMessage(evt.message);
        if (text) chatLog.addSystem(text);
        streamAssembler.drop(evt.runId);
        noteFinalizedRun(evt.runId);
        state.activeChatRunId = null;
        setActivityStatus("idle");
        void refreshSessionInfo?.();
        tui.requestRender();
        return;
      }
      const stopReason =
        evt.message && typeof evt.message === "object" && !Array.isArray(evt.message)
          ? typeof (evt.message as Record<string, unknown>).stopReason === "string"
            ? ((evt.message as Record<string, unknown>).stopReason as string)
            : ""
          : "";

      const finalText = streamAssembler.finalize(evt.runId, evt.message, state.showThinking);
      chatLog.finalizeAssistant(finalText, evt.runId);
      noteFinalizedRun(evt.runId);
      state.activeChatRunId = null;
      setActivityStatus(stopReason === "error" ? "error" : "idle");
      // Refresh session info to update token counts in footer
      void refreshSessionInfo?.();
    }
    if (evt.state === "aborted") {
      chatLog.addSystem("run aborted");
      streamAssembler.drop(evt.runId);
      sessionRuns.delete(evt.runId);
      state.activeChatRunId = null;
      setActivityStatus("aborted");
      void refreshSessionInfo?.();
    }
    if (evt.state === "error") {
      chatLog.addSystem(`run error: ${evt.errorMessage ?? "unknown"}`);
      streamAssembler.drop(evt.runId);
      sessionRuns.delete(evt.runId);
      state.activeChatRunId = null;
      setActivityStatus("error");
      void refreshSessionInfo?.();
    }
    tui.requestRender();
  };

  const handleAgentEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const evt = payload as AgentEvent;
    syncSessionKey();
    // Agent events (tool streaming, lifecycle) are emitted per-run. Filter against the
    // active chat run id, not the session id.
    if (evt.runId !== state.activeChatRunId && !sessionRuns.has(evt.runId)) return;
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
