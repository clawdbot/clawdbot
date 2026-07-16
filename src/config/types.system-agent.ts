/**
 * System-agent config types for local control-plane and remote rescue behavior.
 * Rescue config is deliberately narrow because it can approve state-changing maintainer actions.
 */
/** Remote rescue gate and approval retention policy. */
type SystemAgentRescueConfig = {
  /**
   * Remote message rescue gate.
   * "auto" enables only for YOLO host posture with sandboxing off.
   */
  enabled?: "auto" | boolean;
  /** Restrict rescue to owner DMs. Default: true. */
  ownerDmOnly?: boolean;
  /** Pending write approval TTL in minutes. Default: 15. */
  pendingTtlMinutes?: number;
};

/** Top-level system-agent config block. */
export type SystemAgentConfig = {
  rescue?: SystemAgentRescueConfig;
};
