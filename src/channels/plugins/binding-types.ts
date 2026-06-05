/**
 * Configured channel binding types.
 *
 * Defines normalized conversation facts, binding records, and stateful target descriptors.
 */
import type { AgentBinding } from "../../config/types.js";
import type {
  ConversationRef,
  SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import type { ChannelConfiguredBindingConversationRef } from "./types.adapters.js";
import type {
  ChannelConfiguredBindingMatch,
  ChannelConfiguredBindingProvider,
} from "./types.adapters.js";
import type { ChannelId } from "./types.public.js";

/**
 * Normalized conversation facts used to match configured channel bindings.
 */
export type ConfiguredBindingConversation = ConversationRef;

/**
 * Channel id used by configured binding rules.
 */
export type ConfiguredBindingChannel = ChannelId;

/**
 * Raw binding config entry from OpenClaw config.
 */
export type ConfiguredBindingRuleConfig = AgentBinding;

/**
 * Stateful target descriptor produced by a binding consumer.
 */
export type StatefulBindingTargetDescriptor = {
  kind: "stateful";
  driverId: string;
  sessionKey: string;
  agentId: string;
  label?: string;
};

/**
 * Materialized binding record plus the stateful target it points at.
 */
export type ConfiguredBindingRecordResolution = {
  record: SessionBindingRecord;
  statefulTarget: StatefulBindingTargetDescriptor;
};

/**
 * Factory that materializes a configured binding for one account/conversation pair.
 */
export type ConfiguredBindingTargetFactory = {
  driverId: string;
  materialize: (params: {
    accountId: string;
    conversation: ChannelConfiguredBindingConversationRef;
  }) => ConfiguredBindingRecordResolution;
};

/**
 * Compiled binding rule with provider matcher, target factory, and static target facts.
 */
export type CompiledConfiguredBinding = {
  channel: ConfiguredBindingChannel;
  accountPattern?: string;
  binding: ConfiguredBindingRuleConfig;
  bindingConversationId: string;
  target: ChannelConfiguredBindingConversationRef;
  agentId: string;
  provider: ChannelConfiguredBindingProvider;
  targetFactory: ConfiguredBindingTargetFactory;
};

/**
 * Full configured binding resolution used to rewrite routes and prepare target sessions.
 */
export type ConfiguredBindingResolution = ConfiguredBindingRecordResolution & {
  conversation: ConfiguredBindingConversation;
  compiledBinding: CompiledConfiguredBinding;
  match: ChannelConfiguredBindingMatch;
};
