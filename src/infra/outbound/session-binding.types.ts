export type BindingTargetKind = "subagent" | "session";
export type BindingStatus = "active" | "ending" | "ended";
export type SessionBindingPlacement = "current" | "child";
export type SessionBindingErrorCode =
  | "BINDING_ADAPTER_UNAVAILABLE"
  | "BINDING_CAPABILITY_UNSUPPORTED"
  | "BINDING_CREATE_FAILED";

export type ConversationRef = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
};

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

export type SessionBindingBindInput = {
  targetSessionKey: string;
  targetKind: BindingTargetKind;
  conversation: ConversationRef;
  placement?: SessionBindingPlacement;
  metadata?: Record<string, unknown>;
  ttlMs?: number;
};

export type SessionBindingUnbindInput = {
  bindingId?: string;
  targetSessionKey?: string;
  reason: string;
};

export type SessionBindingCapabilities = {
  adapterAvailable: boolean;
  bindSupported: boolean;
  unbindSupported: boolean;
  placements: SessionBindingPlacement[];
};
