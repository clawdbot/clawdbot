/**
 * ACP configured binding consumer.
 *
 * Converts channel configured-binding rules into persistent ACP binding records.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  buildConfiguredAcpSessionKey,
  normalizeBindingConfig,
  normalizeMode,
  normalizeText,
  parseConfiguredAcpSessionKey,
  toConfiguredAcpBindingRecord,
  type ConfiguredAcpBindingSpec,
} from "../../acp/persistent-bindings.types.js";
import {
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ConfiguredBindingRuleConfig,
  ConfiguredBindingTargetFactory,
} from "./binding-types.js";
import type { ConfiguredBindingConsumer } from "./configured-binding-consumers.js";
import type { ChannelConfiguredBindingConversationRef } from "./types.adapters.js";

function resolveAgentRuntimeAcpDefaults(params: { cfg: OpenClawConfig; ownerAgentId: string }): {
  acpAgentId?: string;
  mode?: string;
  cwd?: string;
  backend?: string;
} {
  // ACP bindings inherit runtime defaults from the owning agent when that agent already runs ACP.
  const ownerAgentId = normalizeLowercaseStringOrEmpty(params.ownerAgentId);
  const agent = resolveAgentConfig(params.cfg, ownerAgentId);
  if (!agent || agent.runtime?.type !== "acp") {
    return {};
  }
  return {
    acpAgentId: normalizeText(agent.runtime.acp?.agent),
    mode: normalizeText(agent.runtime.acp?.mode),
    cwd: normalizeText(agent.runtime.acp?.cwd),
    backend: normalizeText(agent.runtime.acp?.backend),
  };
}

function resolveConfiguredBindingWorkspaceCwd(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string | undefined {
  // Only bind cwd when the agent has an explicit workspace contract; otherwise let ACP choose
  // its normal default instead of freezing an incidental process cwd.
  const explicitAgentWorkspace = normalizeText(
    resolveAgentConfig(params.cfg, params.agentId)?.workspace,
  );
  if (explicitAgentWorkspace) {
    return resolveAgentWorkspaceDir(params.cfg, params.agentId);
  }
  if (params.agentId === resolveDefaultAgentId(params.cfg)) {
    const defaultWorkspace = normalizeText(params.cfg.agents?.defaults?.workspace);
    if (defaultWorkspace) {
      return resolveAgentWorkspaceDir(params.cfg, params.agentId);
    }
  }
  return undefined;
}

function buildConfiguredAcpSpec(params: {
  channel: string;
  accountId: string;
  conversation: ChannelConfiguredBindingConversationRef;
  agentId: string;
  acpAgentId?: string;
  mode: "persistent" | "oneshot";
  cwd?: string;
  backend?: string;
  label?: string;
}): ConfiguredAcpBindingSpec {
  return {
    channel: params.channel as ConfiguredAcpBindingSpec["channel"],
    accountId: params.accountId,
    conversationId: params.conversation.conversationId,
    parentConversationId: params.conversation.parentConversationId,
    agentId: params.agentId,
    acpAgentId: params.acpAgentId,
    mode: params.mode,
    cwd: params.cwd,
    backend: params.backend,
    label: params.label,
  };
}

function buildAcpTargetFactory(params: {
  cfg: OpenClawConfig;
  binding: ConfiguredBindingRuleConfig;
  channel: string;
  agentId: string;
}): ConfiguredBindingTargetFactory | null {
  if (params.binding.type !== "acp") {
    return null;
  }
  // Binding config overrides agent runtime defaults; unresolved fields remain undefined so ACP
  // session creation can apply backend-specific defaults.
  const runtimeDefaults = resolveAgentRuntimeAcpDefaults({
    cfg: params.cfg,
    ownerAgentId: params.agentId,
  });
  const bindingOverrides = normalizeBindingConfig(params.binding.acp);
  const mode = normalizeMode(bindingOverrides.mode ?? runtimeDefaults.mode);
  const cwd =
    bindingOverrides.cwd ??
    runtimeDefaults.cwd ??
    resolveConfiguredBindingWorkspaceCwd({
      cfg: params.cfg,
      agentId: params.agentId,
    });
  const backend = bindingOverrides.backend ?? runtimeDefaults.backend;
  const label = bindingOverrides.label;
  const acpAgentId = normalizeText(runtimeDefaults.acpAgentId);

  return {
    driverId: "acp",
    materialize: ({ accountId, conversation }) => {
      // Materialization is account/conversation-specific because wildcard bindings resolve to
      // stable ACP session keys only after the matched conversation is known.
      const spec = buildConfiguredAcpSpec({
        channel: params.channel,
        accountId,
        conversation,
        agentId: params.agentId,
        acpAgentId,
        mode,
        cwd,
        backend,
        label,
      });
      const record = toConfiguredAcpBindingRecord(spec);
      return {
        record,
        statefulTarget: {
          kind: "stateful",
          driverId: "acp",
          sessionKey: buildConfiguredAcpSessionKey(spec),
          agentId: params.agentId,
          ...(label ? { label } : {}),
        },
      };
    },
  };
}

/**
 * Configured binding consumer that materializes ACP persistent or oneshot targets.
 */
export const acpConfiguredBindingConsumer: ConfiguredBindingConsumer = {
  id: "acp",
  supports: (binding) => binding.type === "acp",
  buildTargetFactory: (params) =>
    buildAcpTargetFactory({
      cfg: params.cfg,
      binding: params.binding,
      channel: params.channel,
      agentId: params.agentId,
    }),
  parseSessionKey: ({ sessionKey }) => parseConfiguredAcpSessionKey(sessionKey),
  matchesSessionKey: ({ sessionKey, materializedTarget }) =>
    materializedTarget.record.targetSessionKey === sessionKey,
};
