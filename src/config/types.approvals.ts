export type ExecApprovalForwardingMode = "session" | "targets" | "both";

export type ExecApprovalForwardTarget = {
  /** Channel id (e.g. "discord", "slack", or plugin channel id). */
  channel: string;
  /** Destination id (channel id, user id, etc. depending on channel). */
  to: string;
  /** Optional account id for multi-account channels. */
  accountId?: string;
  /** Optional thread id to reply inside a thread. */
  threadId?: string | number;
};

export type ExecApprovalForwardingConfig = {
  /** Enable forwarding exec approvals to chat channels. Default: false. */
  enabled?: boolean;
  /** Delivery mode (session=origin chat, targets=config targets, both=both). Default: session. */
  mode?: ExecApprovalForwardingMode;
  /** Only forward approvals for these agent IDs. Omit = all agents. */
  agentFilter?: string[];
  /** Only forward approvals matching these session key patterns (substring or regex). */
  sessionFilter?: string[];
  /** Explicit delivery targets (used when mode includes targets). */
  targets?: ExecApprovalForwardTarget[];
};

export type MessageApprovalForwardingMode = "session" | "targets" | "both";

export type MessageApprovalForwardingConfig = {
  /** Enable requiring human approval for outbound messages. Default: false. */
  enabled?: boolean;
  /** Delivery mode (session=origin chat, targets=config targets, both=both). Default: session. */
  mode?: MessageApprovalForwardingMode;
  /** Only require approval for these actions (e.g. ["send", "broadcast"]). Omit = all actions. */
  actions?: string[];
  /** Only require approval for these channels. Omit or ["*"] = all channels. */
  channels?: string[];
  /** Only require approval for these agent IDs. Omit = all agents. */
  agentFilter?: string[];
  /** Only require approval matching these session key patterns (substring or regex). */
  sessionFilter?: string[];
  /** Explicit delivery targets (used when mode includes targets). */
  targets?: ExecApprovalForwardTarget[];
  /** Approval timeout in seconds. Default: 120. */
  timeout?: number;
};

export type ApprovalsConfig = {
  exec?: ExecApprovalForwardingConfig;
  message?: MessageApprovalForwardingConfig;
};
