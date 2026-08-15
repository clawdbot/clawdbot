/**
 * Runtime destination a conversation binding points at.
 */
export type BindingTargetKind = "subagent" | "session";

/**
 * Lifecycle state for a registered session binding.
 */
type BindingStatus = "active" | "ending" | "ended";

/**
 * Placement requested when binding a child/current session to a conversation.
 */
export type SessionBindingPlacement = "current" | "child";

/**
 * Stable error codes emitted by session-binding service failures.
 */
export type SessionBindingErrorCode =
  | "BINDING_ADAPTER_UNAVAILABLE"
  | "BINDING_CAPABILITY_UNSUPPORTED"
  | "BINDING_CREATE_FAILED";

/**
 * Channel/account/conversation tuple used to resolve a bound delivery route.
 */
export type ConversationRef = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
};

/**
 * Persistable record that connects one conversation to one target session.
 */
export type SessionBindingRecord = {
  bindingId: string;
  targetSessionKey: string;
  targetKind: BindingTargetKind;
  conversation: ConversationRef;
  status: BindingStatus;
  boundAt: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
};

/**
 * Request to create or refresh a session binding for a conversation.
 */
export type SessionBindingBindInput = {
  targetSessionKey: string;
  targetKind: BindingTargetKind;
  conversation: ConversationRef;
  placement?: SessionBindingPlacement;
  metadata?: Record<string, unknown>;
  ttlMs?: number;
};

/**
 * Request to remove bindings by id or target session.
 */
export type SessionBindingUnbindInput = {
  bindingId?: string;
  targetSessionKey?: string;
  reason: string;
};

/**
 * Capability summary exposed by the active binding adapter for a conversation scope.
 */
export type SessionBindingCapabilities = {
  adapterAvailable: boolean;
  bindSupported: boolean;
  unbindSupported: boolean;
  placements: SessionBindingPlacement[];
};
