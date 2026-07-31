import type { EventType } from "@ag-ui/core";

type EventWriter = (event: { type: EventType } & Record<string, unknown>) => void;

/**
 * Per-session store for the SSE event writer, read by the before/after_tool_call
 * hooks. Fully reentrant — concurrent requests use different session keys.
 *
 * Client-provided tools are NOT stored here: the HTTP handler forwards them per
 * request into runEmbeddedAgent's `clientTools`, bypassing the plugin registry.
 */
const writerStore = new Map<string, EventWriter>();

// --- SSE event writer (for before/after_tool_call hooks) ---

const messageIdStore = new Map<string, string>();

export function setWriter(sessionKey: string, writer: EventWriter, messageId: string): void {
  writerStore.set(sessionKey, writer);
  messageIdStore.set(sessionKey, messageId);
}

export function getWriter(sessionKey: string): EventWriter | undefined {
  return writerStore.get(sessionKey);
}

export function getMessageId(sessionKey: string): string | undefined {
  return messageIdStore.get(sessionKey);
}

export function clearWriter(sessionKey: string): void {
  writerStore.delete(sessionKey);
  messageIdStore.delete(sessionKey);
}

// --- Pending toolCallId stack (before_tool_call pushes, tool_result_persist pops) ---
// Only used for SERVER-side tools. Client tools emit TOOL_CALL_END in
// before_tool_call and never push to this stack.

const pendingStacks = new Map<string, string[]>();

export function pushToolCallId(sessionKey: string, toolCallId: string): void {
  let stack = pendingStacks.get(sessionKey);
  if (!stack) {
    stack = [];
    pendingStacks.set(sessionKey, stack);
  }
  stack.push(toolCallId);
}

export function popToolCallId(sessionKey: string): string | undefined {
  const stack = pendingStacks.get(sessionKey);
  const id = stack?.pop();
  if (stack && stack.length === 0) {
    pendingStacks.delete(sessionKey);
  }
  return id;
}

// --- Client tool name tracking ---
// Tracks which tool names are client-provided so hooks can distinguish them.

const clientToolNames = new Map<string, Set<string>>();

export function markClientToolNames(sessionKey: string, names: string[]): void {
  clientToolNames.set(sessionKey, new Set(names));
}

export function isClientTool(sessionKey: string, toolName: string): boolean {
  return clientToolNames.get(sessionKey)?.has(toolName) ?? false;
}

export function clearClientToolNames(sessionKey: string): void {
  clientToolNames.delete(sessionKey);
}

// --- Client-tool-called flag ---
// Set when a client tool is invoked during a run so the dispatcher can
// suppress text output and end the run after the tool call events.

const clientToolCalledFlags = new Map<string, boolean>();

export function setClientToolCalled(sessionKey: string): void {
  clientToolCalledFlags.set(sessionKey, true);
}

export function wasClientToolCalled(sessionKey: string): boolean {
  return clientToolCalledFlags.get(sessionKey) ?? false;
}

export function clearClientToolCalled(sessionKey: string): void {
  clientToolCalledFlags.delete(sessionKey);
}
