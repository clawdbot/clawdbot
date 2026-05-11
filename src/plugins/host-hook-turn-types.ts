import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PluginJsonValue } from "./host-hook-json.js";

export type PluginNextTurnInjectionPlacement = "prepend_context" | "append_context";

export type PluginNextTurnInjection = {
  sessionKey: string;
  text: string;
  idempotencyKey?: string;
  placement?: PluginNextTurnInjectionPlacement;
  ttlMs?: number;
  metadata?: PluginJsonValue;
};

export type PluginNextTurnInjectionRecord = Omit<PluginNextTurnInjection, "sessionKey"> & {
  id: string;
  pluginId: string;
  pluginName?: string;
  createdAt: number;
  placement: PluginNextTurnInjectionPlacement;
};

export type PluginNextTurnInjectionEnqueueResult = {
  enqueued: boolean;
  id: string;
  sessionKey: string;
};

export type PluginAgentTurnPrepareEvent = {
  prompt: string;
  messages: AgentMessage[] | unknown[];
  queuedInjections: PluginNextTurnInjectionRecord[];
};

export type PluginAgentTurnPrepareResult = {
  prependContext?: string;
  appendContext?: string;
};

export type PluginHeartbeatPromptContributionEvent = {
  sessionKey?: string;
  agentId?: string;
  heartbeatName?: string;
};

export type PluginHeartbeatPromptContributionResult = {
  prependContext?: string;
  appendContext?: string;
};
