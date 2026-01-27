/**
 * Hook system for moltbot agent events
 *
 * Provides an extensible event-driven hook system for agent events
 * like command processing, session lifecycle, etc.
 */

import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import type { MoltbotConfig } from "../config/config.js";

export type InternalHookEventType = "command" | "session" | "agent" | "gateway";

export type AgentBootstrapHookContext = {
  workspaceDir: string;
  bootstrapFiles: WorkspaceBootstrapFile[];
  cfg?: MoltbotConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
};

export type AgentBootstrapHookEvent = InternalHookEvent & {
  type: "agent";
  action: "bootstrap";
  context: AgentBootstrapHookContext;
};

export interface InternalHookEvent {
  /** The type of event (command, session, agent, gateway, etc.) */
  type: InternalHookEventType;
  /** The specific action within the type (e.g., 'new', 'reset', 'stop') */
  action: string;
  /** The session key this event relates to */
  sessionKey: string;
  /** Additional context specific to the event */
  context: Record<string, unknown>;
  /** Timestamp when the event occurred */
  timestamp: Date;
  /** Messages to send back to the user (hooks can push to this array) */
  messages: string[];
}

export type InternalHookHandler = (event: InternalHookEvent) => Promise<void> | void;

/** Registry of hook handlers by event key */
const handlers = new Map<string, InternalHookHandler[]>();

/**
 * Register a hook handler for a specific event type or event:action combination
 *
 * @param eventKey - Event type (e.g., 'command') or specific action (e.g., 'command:new')
 * @param handler - Function to call when the event is triggered
 *
 * @example
 * ```ts
 * // Listen to all command events
 * registerInternalHook('command', async (event) => {
 *   console.log('Command:', event.action);
 * });
 *
 * // Listen only to /new commands
 * registerInternalHook('command:new', async (event) => {
 *   await saveSessionToMemory(event);
 * });
 * ```
 */
export function registerInternalHook(eventKey: string, handler: InternalHookHandler): void {
  if (!handlers.has(eventKey)) {
    handlers.set(eventKey, []);
  }
  handlers.get(eventKey)!.push(handler);
}

/**
 * Unregister a specific hook handler
 *
 * @param eventKey - Event key the handler was registered for
 * @param handler - The handler function to remove
 */
export function unregisterInternalHook(eventKey: string, handler: InternalHookHandler): void {
  const eventHandlers = handlers.get(eventKey);
  if (!eventHandlers) {
    return;
  }

  const index = eventHandlers.indexOf(handler);
  if (index !== -1) {
    eventHandlers.splice(index, 1);
  }

  // Clean up empty handler arrays
  if (eventHandlers.length === 0) {
    handlers.delete(eventKey);
  }
}

/**
 * Clear all registered hooks (useful for testing)
 */
export function clearInternalHooks(): void {
  handlers.clear();
}

/**
 * Get all registered event keys (useful for debugging)
 */
export function getRegisteredEventKeys(): string[] {
  return Array.from(handlers.keys());
}

/**
 * Trigger a hook event
 *
 * Calls all handlers registered for:
 * 1. The general event type (e.g., 'command')
 * 2. The specific event:action combination (e.g., 'command:new')
 *
 * Handlers are called in registration order. Errors are caught and logged
 * but don't prevent other handlers from running.
 *
 * @param event - The event to trigger
 */
export async function triggerInternalHook(event: InternalHookEvent): Promise<void> {
  const typeHandlers = handlers.get(event.type) ?? [];
  const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];

  const allHandlers = [...typeHandlers, ...specificHandlers];

  if (allHandlers.length === 0) {
    return;
  }

  for (const handler of allHandlers) {
    try {
      await handler(event);
    } catch (err) {
      console.error(
        `Hook error [${event.type}:${event.action}]:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Create a hook event with common fields filled in
 *
 * @param type - The event type
 * @param action - The action within that type
 * @param sessionKey - The session key
 * @param context - Additional context
 */
export function createInternalHookEvent(
  type: InternalHookEventType,
  action: string,
  sessionKey: string,
  context: Record<string, unknown> = {},
): InternalHookEvent {
  return {
    type,
    action,
    sessionKey,
    context,
    timestamp: new Date(),
    messages: [],
  };
}

export function isAgentBootstrapEvent(event: InternalHookEvent): event is AgentBootstrapHookEvent {
  if (event.type !== "agent" || event.action !== "bootstrap") return false;
  const context = event.context as Partial<AgentBootstrapHookContext> | null;
  if (!context || typeof context !== "object") return false;
  if (typeof context.workspaceDir !== "string") return false;
  return Array.isArray(context.bootstrapFiles);
}
