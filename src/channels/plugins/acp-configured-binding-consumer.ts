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
  resolveAgentExplicitModelPrimary,
  resolveAgentWorkspaceDir,
} from "../../agents/agent-scope.js";
import { parseModelRef } from "../../agents/model-selection-normalize.js";
import { resolveConfiguredThinkingDefault } from "../../agents/model-thinking-default.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ConfiguredBindingRuleConfig,
  ConfiguredBindingTargetFactory,
} from "./binding-types.js";
import type { ConfiguredBindingConsumer } from "./configured-binding-consumers.js";

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
  if (normalizeText(params.cfg.agents?.defaults?.workspace)) {
    return resolveAgentWorkspaceDir(params.cfg, params.agentId);
  }
  return undefined;
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
  // Every ACP binding uses its owner's explicit model, regardless of the owner's runtime type.
  const model = resolveAgentExplicitModelPrimary(params.cfg, params.agentId);
  const modelRef = model ? parseModelRef(model, "") : null;
  // Forward configured policy only; an external harness owns its unconfigured defaults.
  const thinking =
    resolveAgentConfig(params.cfg, params.agentId)?.thinkingDefault ??
    (modelRef
      ? resolveConfiguredThinkingDefault({ cfg: params.cfg, ...modelRef })
      : params.cfg.agents?.defaults?.thinkingDefault);
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
      const spec: ConfiguredAcpBindingSpec = {
        channel: params.channel as ConfiguredAcpBindingSpec["channel"],
        accountId,
        conversationId: conversation.conversationId,
        parentConversationId: conversation.parentConversationId,
        agentId: params.agentId,
        acpAgentId,
        mode,
        model,
        thinking,
        cwd,
        backend,
        label,
      };
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
