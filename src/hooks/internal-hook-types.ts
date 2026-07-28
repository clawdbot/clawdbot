// Internal hook types define runtime hook event families and payload contracts.
export type InternalHookEventType = "command" | "session" | "agent" | "gateway" | "message";

const KNOWN_INTERNAL_HOOK_EVENT_FAMILIES = [
  "command",
  "session",
  "agent",
  "gateway",
  "message",
] as const satisfies readonly InternalHookEventType[];

/**
 * Event keys emitted by core trigger sites (see docs/automation/hooks.md
 * events table — keep both in sync when adding a trigger). Hooks can also
 * subscribe to a bare family key to receive every action of that family.
 * Plugins can emit additional keys via the deprecated plugin-sdk/hook-runtime
 * barrel, so anything outside this set is flagged as a likely typo
 * (advisory), not rejected.
 */
const KNOWN_INTERNAL_HOOK_EVENT_KEYS = [
  "agent:bootstrap",
  "command:new",
  "command:reset",
  "command:stop",
  "gateway:pre-restart",
  "gateway:shutdown",
  "gateway:startup",
  "message:preprocessed",
  "message:received",
  "message:sent",
  "message:transcribed",
  "session:compact:after",
  "session:compact:before",
  "session:patch",
] as const;

export function isKnownInternalHookEventKey(key: string): boolean {
  return (
    (KNOWN_INTERNAL_HOOK_EVENT_KEYS as readonly string[]).includes(key) ||
    (KNOWN_INTERNAL_HOOK_EVENT_FAMILIES as readonly string[]).includes(key)
  );
}

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
