// CDP navigation receipts and session configuration survive an allowed document
// change. Page data, execution contexts, and actions still require that document.
// These are exact protocol methods, never a caller-supplied access override.
export const TAB_SCOPED_COMMANDS = new Set([
  "Page.navigate",
  "Page.reload",
  "Page.navigateToHistoryEntry",
  "Page.enable",
  "Page.setLifecycleEventsEnabled",
  "Network.enable",
  "Network.setAttachDebugStack",
  "Runtime.enable",
  "Runtime.runIfWaitingForDebugger",
  "Target.setAutoAttach",
  "Debugger.enable",
  "Debugger.setSkipAllPauses",
  "Debugger.setPauseOnExceptions",
  "Debugger.setAsyncCallStackDepth",
  "Debugger.setBlackboxPatterns",
  "Log.enable",
  "Log.startViolationsReport",
  "DOM.enable",
  "CSS.enable",
  "Audits.enable",
  "Performance.enable",
  "Profiler.enable",
  "WebMCP.enable",
  "Emulation.setFocusEmulationEnabled",
]);
