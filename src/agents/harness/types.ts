export type AgentHarnessSupportContext = {
  provider: string;
  modelId?: string;
  requestedRuntime: import("../pi-embedded-runner/runtime.js").EmbeddedAgentRuntime;
};

export type AgentHarnessSupport =
  | { supported: true; priority?: number; reason?: string }
  | { supported: false; reason?: string };

export type AgentHarnessAttemptParams =
  import("../pi-embedded-runner/run/types.js").EmbeddedRunAttemptParams;
export type AgentHarnessAttemptResult =
  import("../pi-embedded-runner/run/types.js").EmbeddedRunAttemptResult;
export type AgentHarnessCompactParams =
  import("../pi-embedded-runner/compact.types.js").CompactEmbeddedPiSessionParams;
export type AgentHarnessCompactResult =
  import("../pi-embedded-runner/types.js").EmbeddedPiCompactResult;
export type AgentHarnessResetParams = {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  reason?: "new" | "reset" | "idle" | "daily" | "compaction" | "deleted" | "unknown";
};

export type AgentHarnessResultClassification =
  | "ok"
  | NonNullable<AgentHarnessAttemptResult["agentHarnessResultClassification"]>;

export type AgentHarnessDeliveryDefaults = {
  /**
   * Preferred default for visible source replies when user config has not
   * explicitly selected automatic or message-tool delivery.
   */
  sourceVisibleReplies?: "automatic" | "message_tool";
};

export type AgentHarness = {
  id: string;
  label: string;
  pluginId?: string;
  deliveryDefaults?: AgentHarnessDeliveryDefaults;
  supports(ctx: AgentHarnessSupportContext): AgentHarnessSupport;
  runAttempt(params: AgentHarnessAttemptParams): Promise<AgentHarnessAttemptResult>;
  classify?(
    result: AgentHarnessAttemptResult,
    ctx: AgentHarnessAttemptParams,
  ): AgentHarnessResultClassification | undefined;
  compact?(params: AgentHarnessCompactParams): Promise<AgentHarnessCompactResult | undefined>;
  reset?(params: AgentHarnessResetParams): Promise<void> | void;
  dispose?(): Promise<void> | void;
};

export type RegisteredAgentHarness = {
  harness: AgentHarness;
  ownerPluginId?: string;
};
