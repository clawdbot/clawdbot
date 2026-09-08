import type * as Loopback from "../../gateway/mcp-http.loopback-runtime.js";
import { resolveQuestionTimeoutMs } from "../tools/ask-user-tool-normalization.js";

type McpTerminalOutcome = Loopback.McpLoopbackToolCallTerminalOutcome;
export type CliToolTerminalOutcome = McpTerminalOutcome | { outcome: "completed" };
export type CliLoopbackCall = {
  admitted: Loopback.McpLoopbackToolCallStart;
  current: Loopback.McpLoopbackToolCallStart;
  boundToolCallId?: string;
  outcome?: CliToolTerminalOutcome;
  ambiguous: boolean;
  ambiguityGroup?: CliLoopbackAmbiguityGroup;
};
export type CliLoopbackAmbiguityGroup = {
  calls: Set<CliLoopbackCall>;
  activeToolCallIds: Set<string>;
};
export type ActiveCliTool = Loopback.McpLoopbackToolCallStart & {
  loopbackCall?: CliLoopbackCall;
  loopbackAmbiguous: boolean;
  ambiguityGroup?: CliLoopbackAmbiguityGroup;
};

export function createAskUserDeadlineTracking(
  activeTools: ReadonlyMap<string, ActiveCliTool>,
  isOverflowed: () => boolean,
) {
  const deadlines = new WeakMap<CliLoopbackCall, number>();
  const state: { listeners: Set<() => void>; selected: number | undefined } = {
    listeners: new Set(),
    selected: undefined,
  };
  const selectDeadline = () => {
    if (isOverflowed()) {
      return undefined;
    }
    let earliest = Number.POSITIVE_INFINITY;
    for (const { loopbackCall: call, loopbackAmbiguous } of activeTools.values()) {
      if (!call || loopbackAmbiguous || call.ambiguous) {
        continue;
      }
      earliest = Math.min(earliest, deadlines.get(call) ?? Number.POSITIVE_INFINITY);
    }
    return Number.isFinite(earliest) ? earliest : undefined;
  };
  const refresh = () => {
    const nextDeadline = selectDeadline();
    if (nextDeadline === state.selected) {
      return;
    }
    state.selected = nextDeadline;
    state.listeners.forEach((listener) => listener());
  };
  const clear = (call: CliLoopbackCall) => {
    deadlines.delete(call);
    refresh();
  };
  const update = (call: CliLoopbackCall, toolName: string, args: Record<string, unknown>) => {
    deadlines.delete(call);
    if (toolName === "ask_user") {
      try {
        deadlines.set(call, Date.now() + resolveQuestionTimeoutMs(args.timeoutSeconds));
      } catch {
        // Invalid timeout input must not arm a watchdog deadline.
      }
    }
    refresh();
  };
  const onChange = (listener: () => void) => {
    state.listeners.add(listener);
    return () => void state.listeners.delete(listener);
  };
  return { clear, update, refresh, get: () => state.selected, onChange };
}
