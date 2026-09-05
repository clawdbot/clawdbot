/**
 * Hook system for OpenClaw agent events
 *
 * Provides an extensible event-driven hook system for agent events
 * like command processing, session lifecycle, etc.
 */

import { performance } from "node:perf_hooks";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/schema/sessions.js";
import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import type { CliDeps } from "../cli/outbound-send-deps.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  clearLegacyPluginInternalHooks,
  listLegacyPluginInternalHookEventKeys,
  listLegacyPluginInternalHooks,
} from "../plugins/legacy-internal-hook-state.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  InternalHookEvent,
  InternalHookEventType,
  InternalHookHandler,
} from "./internal-hook-types.js";
import type { MessageHookMediaFact } from "./message-hook-media.js";
export type { InternalHookEvent, InternalHookEventType, InternalHookHandler };

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
const INTERNAL_HOOK_SLOW_HANDLER_WARN_MS = 500;

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
  /** Channel identifier (for example "chat" or "support-chat") */
  channelId: string;
  /** Provider account ID for multi-account setups */
  accountId?: string;
  /** Conversation/chat ID */
  conversationId?: string;
  /** Message ID from the provider */
  messageId?: string;
  /** Staged, locally usable attachments in stable source order. */
  media?: MessageHookMediaFact[];
  /** Original attachment facts when local staging has not completed yet. */
  originalMedia?: MessageHookMediaFact[];
  /** True when originalMedia is present but media is withheld pending staging. */
  mediaStagingPending?: boolean;
  /** Additional provider-specific metadata */
  metadata?: Record<string, unknown>;
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
  /** Channel identifier (for example "chat" or "support-chat") */
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
  /** Channel identifier (for example "chat" or "support-chat") */
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
  /** Ordered media facts available to preprocessing/transcription hooks. */
  media?: MessageHookMediaFact[];
  /** Original facts when local staging has not completed yet. */
  originalMedia?: MessageHookMediaFact[];
  /** True when originalMedia is present but media is withheld pending staging. */
  mediaStagingPending?: boolean;
  /** @deprecated Use `media?.[0]?.path`. */
  mediaPath?: string;
  /** @deprecated Use `media?.[0]?.contentType` or `.kind`. */
  mediaType?: string;
};

export type MessageTranscribedHookContext = MessageEnrichedBodyHookContext & {
  /** The transcribed text from audio */
  transcript: string;
};

export type MessagePreprocessedHookContext = MessageEnrichedBodyHookContext & {
  /** Transcribed audio text, if the message contained audio */
  transcript?: string;
  /** Whether this message was sent in a group/channel context */
  isGroup?: boolean;
  /** Group or channel identifier, if applicable */
  groupId?: string;
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
  clearLegacyPluginInternalHooks();
}

export function setInternalHooksEnabled(enabled: boolean): void {
  internalHooksEnabledState.enabled = enabled;
}

/**
 * Get all registered event keys (useful for debugging)
 */
export function getRegisteredEventKeys(): string[] {
  return [...new Set([...handlers.keys(), ...listLegacyPluginInternalHookEventKeys()])];
}

export function hasInternalHookListeners(type: InternalHookEventType, action: string): boolean {
  return (
    (handlers.get(type)?.length ?? 0) + listLegacyPluginInternalHooks(type).length > 0 ||
    (handlers.get(`${type}:${action}`)?.length ?? 0) +
      listLegacyPluginInternalHooks(`${type}:${action}`).length >
      0
  );
}

/**
 * Internal-only scheduling control for the bootstrap dispatch path. Not exported
 * from the plugin SDK (`src/plugin-sdk/hook-runtime.ts` re-exports only the
 * `triggerInternalHook(event)` surface), so the public single-parameter signature
 * never grows a second argument plugins could rely on.
 */
type InternalHookTriggerOptions = {
  yieldBetweenHandlers?: boolean;
};

/**
 * Trigger a hook event, optionally yielding to the event loop between handlers.
 *
 * Calls all handlers registered for:
 * 1. The general event type (e.g., 'command')
 * 2. The specific event:action combination (e.g., 'command:new')
 *
 * Handlers are called in registration order. Errors are caught and logged
 * but don't prevent other handlers from running.
 *
 * The public `triggerInternalHook(event)` delegates here with no options so its
 * SDK-facing signature stays single-parameter; the bootstrap path passes
 * `yieldBetweenHandlers` to keep long handler chains from stalling the loop.
 */
export async function triggerInternalHookWithScheduling(
  event: InternalHookEvent,
  options?: InternalHookTriggerOptions,
): Promise<void> {
  if (!internalHooksEnabledState.enabled) {
    return;
  }

  // Plugin-registered legacy internal hooks dispatch alongside the core registry;
  // merge both so the bootstrap path (which calls this directly) and the public
  // triggerInternalHook delegator fire every registered handler.
  // An admitted event finishes its snapshot even if a handler awaits across a reload or disable.
  const typeHandlers = [
    ...(handlers.get(event.type) ?? []),
    ...listLegacyPluginInternalHooks(event.type),
  ];
  const specificKey = `${event.type}:${event.action}`;
  const specificHandlers = [
    ...(handlers.get(specificKey) ?? []),
    ...listLegacyPluginInternalHooks(specificKey),
  ];
  if (typeHandlers.length === 0 && specificHandlers.length === 0) {
    return;
  }
  const allHandlers = [...typeHandlers, ...specificHandlers];

  for (const [index, handler] of allHandlers.entries()) {
    const handlerStartedAt = performance.now();
    try {
      await handler(event);
    } catch (err) {
      const message = formatErrorMessage(err);
      log.error(`Hook error [${event.type}:${event.action}]: ${message}`);
    }
    const durationMs = performance.now() - handlerStartedAt;
    // The warning targets event-loop-stall diagnostics on the bootstrap dispatch
    // path (the only caller passing yieldBetweenHandlers). Outside it, awaited
    // wall time mostly reflects non-blocking network/file work, so a global
    // duration warning is just false positives.
    if (options?.yieldBetweenHandlers === true && durationMs > INTERNAL_HOOK_SLOW_HANDLER_WARN_MS) {
      log.warn(
        `Slow hook handler [${event.type}:${event.action}] index=${index} durationMs=${durationMs.toFixed(1)}`,
      );
    }
    // Check-phase yield between handlers keeps a long bootstrap chain from
    // starving the event loop; scoped to the last-handler boundary so no trailing
    // tick is scheduled after the final handler.
    if (options?.yieldBetweenHandlers === true && index < allHandlers.length - 1) {
      await yieldImmediate();
    }
  }
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
  await triggerInternalHookWithScheduling(event);
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
