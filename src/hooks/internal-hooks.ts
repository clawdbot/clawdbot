/**
 * Hook system for OpenClaw agent events
 *
 * Provides an extensible event-driven hook system for agent events
 * like command processing, session lifecycle, etc.
 */

import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import type { CliDeps } from "../cli/outbound-send-deps.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionsPatchParams } from "../gateway/protocol/schema/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  InternalHookEvent,
  InternalHookEventType,
  InternalHookHandler,
} from "./internal-hook-types.js";
export type { InternalHookEvent, InternalHookEventType, InternalHookHandler };

export type AgentBootstrapHookContext = {
  workspaceDir: string;
  bootstrapFiles: WorkspaceBootstrapFile[];
  cfg?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
};

export type AgentBootstrapHookEvent = InternalHookEvent & {
  type: "agent";
  action: "bootstrap";
  context: AgentBootstrapHookContext;
};

export type GatewayStartupHookContext = {
  cfg?: OpenClawConfig;
  deps?: CliDeps;
  workspaceDir?: string;
};

export type GatewayStartupHookEvent = InternalHookEvent & {
  type: "gateway";
  action: "startup";
  context: GatewayStartupHookContext;
};

// ============================================================================
// Message Hook Events
// ============================================================================

export type MessageReceivedHookContext = {
  /** Sender identifier (e.g., phone number, user ID) */
  from: string;
  /** Message content */
  content: string;
  /** Unix timestamp when the message was received */
  timestamp?: number;
  /** Channel identifier (e.g., "telegram", "whatsapp") */
  channelId: string;
  /** Provider account ID for multi-account setups */
  accountId?: string;
  /** Conversation/chat ID */
  conversationId?: string;
  /** Message ID from the provider */
  messageId?: string;
  /** Additional provider-specific metadata */
  metadata?: Record<string, unknown>;
};

export type MessageReceivedHookEvent = InternalHookEvent & {
  type: "message";
  action: "received";
  context: MessageReceivedHookContext;
};

export type MessageSentHookContext = {
  /** Recipient identifier */
  to: string;
  /** Message content */
  content: string;
  /** Whether the message was sent successfully */
  success: boolean;
  /** Error message if sending failed */
  error?: string;
  /** Channel identifier (e.g., "telegram", "whatsapp") */
  channelId: string;
  /** Provider account ID for multi-account setups */
  accountId?: string;
  /** Conversation/chat ID */
  conversationId?: string;
  /** Message ID returned by the provider */
  messageId?: string;
  /** Whether this message was sent in a group/channel context */
  isGroup?: boolean;
  /** Group or channel identifier, if applicable */
  groupId?: string;
};

export type MessageSentHookEvent = InternalHookEvent & {
  type: "message";
  action: "sent";
  context: MessageSentHookContext;
};

type MessageEnrichedBodyHookContext = {
  /** Sender identifier (e.g., phone number, user ID) */
  from?: string;
  /** Recipient identifier */
  to?: string;
  /** Original raw message body (e.g., "🎤 [Audio]") */
  body?: string;
  /** Enriched body shown to the agent, including transcript */
  bodyForAgent?: string;
  /** Unix timestamp when the message was received */
  timestamp?: number;
  /** Channel identifier (e.g., "telegram", "whatsapp") */
  channelId: string;
  /** Conversation/chat ID */
  conversationId?: string;
  /** Message ID from the provider */
  messageId?: string;
  /** Sender user ID */
  senderId?: string;
  /** Sender display name */
  senderName?: string;
  /** Sender username */
  senderUsername?: string;
  /** Provider name */
  provider?: string;
  /** Surface name */
  surface?: string;
  /** Path to the media file that was transcribed */
  mediaPath?: string;
  /** MIME type of the media */
  mediaType?: string;
};

export type MessageTranscribedHookContext = MessageEnrichedBodyHookContext & {
  /** The transcribed text from audio */
  transcript: string;
};

export type MessageTranscribedHookEvent = InternalHookEvent & {
  type: "message";
  action: "transcribed";
  context: MessageTranscribedHookContext;
};

export type MessagePreprocessedHookContext = MessageEnrichedBodyHookContext & {
  /** Transcribed audio text, if the message contained audio */
  transcript?: string;
  /** Whether this message was sent in a group/channel context */
  isGroup?: boolean;
  /** Group or channel identifier, if applicable */
  groupId?: string;
};

export type MessagePreprocessedHookEvent = InternalHookEvent & {
  type: "message";
  action: "preprocessed";
  context: MessagePreprocessedHookContext;
};

export type SessionPatchHookContext = {
  sessionEntry: SessionEntry;
  patch: SessionsPatchParams;
  cfg: OpenClawConfig;
};

export type SessionPatchHookEvent = InternalHookEvent & {
  type: "session";
  action: "patch";
  context: SessionPatchHookContext;
};

/**
 * Registry of hook handlers by event key.
 *
 * Uses a globalThis singleton so that registerInternalHook and
 * triggerInternalHook always share the same Map even when the bundler
 * emits multiple copies of this module into separate chunks (bundle
 * splitting). Without the singleton, handlers registered in one chunk
 * are invisible to triggerInternalHook in another chunk, causing hooks
 * to silently fire with zero handlers.
 */
const INTERNAL_HOOK_HANDLERS_KEY = Symbol.for("openclaw.internalHookHandlers");
const handlers = resolveGlobalSingleton<Map<string, InternalHookHandler[]>>(
  INTERNAL_HOOK_HANDLERS_KEY,
  () => new Map<string, InternalHookHandler[]>(),
);
const INTERNAL_HOOKS_ENABLED_KEY = Symbol.for("openclaw.internalHooksEnabled");
const internalHooksEnabledState = resolveGlobalSingleton<{ enabled: boolean }>(
  INTERNAL_HOOKS_ENABLED_KEY,
  () => ({ enabled: true }),
);
const log = createSubsystemLogger("internal-hooks");

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

export function setInternalHooksEnabled(enabled: boolean): void {
  internalHooksEnabledState.enabled = enabled;
}

/**
 * Get all registered event keys (useful for debugging)
 */
export function getRegisteredEventKeys(): string[] {
  return Array.from(handlers.keys());
}

export function hasInternalHookListeners(type: InternalHookEventType, action: string): boolean {
  return (
    (handlers.get(type)?.length ?? 0) > 0 || (handlers.get(`${type}:${action}`)?.length ?? 0) > 0
  );
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
  if (!internalHooksEnabledState.enabled) {
    return;
  }
  if (!hasInternalHookListeners(event.type, event.action)) {
    return;
  }

  const typeHandlers = handlers.get(event.type) ?? [];
  const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];
  const allHandlers = [...typeHandlers, ...specificHandlers];

  for (const handler of allHandlers) {
    try {
      await handler(event);
    } catch (err) {
      const message = formatErrorMessage(err);
      log.error(`Hook error [${event.type}:${event.action}]: ${message}`);
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

function isHookEventTypeAndAction(
  event: InternalHookEvent,
  type: InternalHookEventType,
  action: string,
): boolean {
  return event.type === type && event.action === action;
}

function getHookContext<T extends Record<string, unknown>>(
  event: InternalHookEvent,
): Partial<T> | null {
  const context = event.context as Partial<T> | null;
  if (!context || typeof context !== "object") {
    return null;
  }
  return context;
}

function hasStringContextField<T extends Record<string, unknown>>(
  context: Partial<T>,
  key: keyof T,
): boolean {
  return typeof context[key] === "string";
}

function hasBooleanContextField<T extends Record<string, unknown>>(
  context: Partial<T>,
  key: keyof T,
): boolean {
  return typeof context[key] === "boolean";
}

export function isAgentBootstrapEvent(event: InternalHookEvent): event is AgentBootstrapHookEvent {
  if (!isHookEventTypeAndAction(event, "agent", "bootstrap")) {
    return false;
  }
  const context = getHookContext<AgentBootstrapHookContext>(event);
  if (!context) {
    return false;
  }
  if (!hasStringContextField(context, "workspaceDir")) {
    return false;
  }
  return Array.isArray(context.bootstrapFiles);
}

export function isGatewayStartupEvent(event: InternalHookEvent): event is GatewayStartupHookEvent {
  if (!isHookEventTypeAndAction(event, "gateway", "startup")) {
    return false;
  }
  return Boolean(getHookContext<GatewayStartupHookContext>(event));
}

export function isMessageReceivedEvent(
  event: InternalHookEvent,
): event is MessageReceivedHookEvent {
  if (!isHookEventTypeAndAction(event, "message", "received")) {
    return false;
  }
  const context = getHookContext<MessageReceivedHookContext>(event);
  if (!context) {
    return false;
  }
  return hasStringContextField(context, "from") && hasStringContextField(context, "channelId");
}

export function isMessageSentEvent(event: InternalHookEvent): event is MessageSentHookEvent {
  if (!isHookEventTypeAndAction(event, "message", "sent")) {
    return false;
  }
  const context = getHookContext<MessageSentHookContext>(event);
  if (!context) {
    return false;
  }
  return (
    hasStringContextField(context, "to") &&
    hasStringContextField(context, "channelId") &&
    hasBooleanContextField(context, "success")
  );
}

export function isMessageTranscribedEvent(
  event: InternalHookEvent,
): event is MessageTranscribedHookEvent {
  if (!isHookEventTypeAndAction(event, "message", "transcribed")) {
    return false;
  }
  const context = getHookContext<MessageTranscribedHookContext>(event);
  if (!context) {
    return false;
  }
  return (
    hasStringContextField(context, "transcript") && hasStringContextField(context, "channelId")
  );
}

export function isMessagePreprocessedEvent(
  event: InternalHookEvent,
): event is MessagePreprocessedHookEvent {
  if (!isHookEventTypeAndAction(event, "message", "preprocessed")) {
    return false;
  }
  const context = getHookContext<MessagePreprocessedHookContext>(event);
  if (!context) {
    return false;
  }
  return hasStringContextField(context, "channelId");
}

export function isSessionPatchEvent(event: InternalHookEvent): event is SessionPatchHookEvent {
  if (!isHookEventTypeAndAction(event, "session", "patch")) {
    return false;
  }
  const context = getHookContext<SessionPatchHookContext>(event);
  if (!context) {
    return false;
  }
  return (
    typeof context.patch === "object" &&
    context.patch !== null &&
    typeof context.cfg === "object" &&
    context.cfg !== null &&
    typeof context.sessionEntry === "object" &&
    context.sessionEntry !== null
  );
}
