// Local structural result keeps this package independent of core session types.
export type SessionsPatchResult = {
  ok: true;
  path: string;
  key: string;
  entry: Record<string, unknown>;
  resolved?: {
    modelProvider?: string;
    model?: string;
    agentRuntime?: import("./schema/agents-models-skills.js").GatewayAgentRuntime;
    thinkingLevel?: string;
    thinkingLevels?: Array<{ id: string; label: string }>;
  };
};
