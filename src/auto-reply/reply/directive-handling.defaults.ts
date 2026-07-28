// Default model and alias resolution for directive handling.
import {
  buildModelAliasIndex,
  type ModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  resolveSubagentConfiguredModelSelection,
} from "../../agents/model-selection.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Resolve default provider/model plus alias index for directive parsing. */
export function resolveDefaultModel(params: { cfg: OpenClawConfig; agentId?: string }): {
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
} {
  const mainModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    // Default-model lookup is on every reply; plugin runtime normalization can
    // cold-load plugins, so keep this to static/configured model aliases here.
    allowPluginNormalization: false,
  });
  const defaultProvider = mainModel.provider;
  const defaultModel = mainModel.model;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider,
    agentId: params.agentId,
    allowPluginNormalization: false,
  });
  return { defaultProvider, defaultModel, aliasIndex };
}

/**
 * Resolve the configured model for a spawned subagent reply.
 * Locked sessions keep their durable model selection.
 */
export function resolveSubagentSessionDefaultModel(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionEntry?: Partial<
    Pick<SessionEntry, "modelSelectionLocked" | "spawnDepth" | "subagentRole">
  >;
  defaultProvider: string;
}): { provider: string; model: string } | null {
  const isSubagent =
    (typeof params.sessionEntry?.spawnDepth === "number" && params.sessionEntry.spawnDepth >= 1) ||
    Boolean(params.sessionEntry?.subagentRole);
  if (!isSubagent || !params.agentId || params.sessionEntry?.modelSelectionLocked === true) {
    return null;
  }
  const configured = resolveSubagentConfiguredModelSelection({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!configured) {
    return null;
  }
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    allowPluginNormalization: false,
  });
  const resolved = resolveModelRefFromString({
    cfg: params.cfg,
    raw: configured,
    defaultProvider: params.defaultProvider,
    aliasIndex,
    allowPluginNormalization: false,
  });
  return resolved ? { provider: resolved.ref.provider, model: resolved.ref.model } : null;
}
