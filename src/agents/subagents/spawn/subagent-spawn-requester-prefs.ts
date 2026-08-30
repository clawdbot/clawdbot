import { resolveSessionModelOverrideRouteResolution } from "../../../config/sessions/model-override-provenance.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { FastMode } from "../../../shared/fast-mode.js";
import { resolveFastModeState } from "../../fast-mode.js";
import { createModelManifestPluginContext } from "../../model-selection-shared.js";
import {
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "../../model-selection.js";
import { resolveThinkingDefault } from "../../model-thinking-default.js";
import {
  loadSessionEntry,
  resolveAgentConfig,
  resolveGatewaySessionStoreTarget,
} from "./subagent-spawn.runtime.js";

function resolveRequesterModel(
  params: { cfg: OpenClawConfig; requesterAgentId?: string },
  entry: SessionEntry | undefined,
) {
  const manifestPluginContext = createModelManifestPluginContext({
    cfg: params.cfg,
    agentId: params.requesterAgentId,
  });
  const defaultModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.requesterAgentId,
    manifestPluginContext,
  });
  return (
    (entry
      ? resolvePersistedSelectedModelRef({
          ...manifestPluginContext.getContext(),
          defaultProvider: defaultModel.provider,
          runtimeProvider: entry.modelProvider,
          runtimeModel: entry.model,
          overrideProvider: entry.providerOverride,
          overrideModel: entry.modelOverride,
          overrideRouteResolution: resolveSessionModelOverrideRouteResolution(entry),
        })
      : null) ?? defaultModel
  );
}

export function readRequesterThinkingLevel(params: {
  cfg: OpenClawConfig;
  requesterInternalKey: string;
  requesterAgentId?: string;
}): string | undefined {
  let entry: SessionEntry | undefined;
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.requesterInternalKey,
      agentId: params.requesterAgentId,
    });
    entry = loadSessionEntry({
      storePath: target.storePath,
      sessionKey: target.canonicalKey,
      clone: false,
    });
  } catch {
    entry = undefined;
  }
  if (typeof entry?.thinkingLevel === "string" && entry.thinkingLevel.trim()) {
    return entry.thinkingLevel.trim();
  }
  const requesterAgentThinking = params.requesterAgentId
    ? resolveAgentConfig(params.cfg, params.requesterAgentId)?.thinkingDefault
    : undefined;
  if (requesterAgentThinking) {
    return requesterAgentThinking;
  }
  const selectedModel = resolveRequesterModel(params, entry);
  return resolveThinkingDefault({
    cfg: params.cfg,
    provider: selectedModel.provider,
    model: selectedModel.model,
  });
}

export function readRequesterFastMode(params: {
  cfg: OpenClawConfig;
  requesterInternalKey: string;
  requesterAgentId?: string;
}): FastMode {
  let entry: SessionEntry | undefined;
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.requesterInternalKey,
      agentId: params.requesterAgentId,
    });
    entry = loadSessionEntry({
      storePath: target.storePath,
      sessionKey: target.canonicalKey,
      clone: false,
    });
  } catch {
    entry = undefined;
  }
  const selectedModel = resolveRequesterModel(params, entry);
  return resolveFastModeState({
    cfg: params.cfg,
    provider: selectedModel.provider,
    model: selectedModel.model,
    agentId: params.requesterAgentId,
    sessionEntry: entry,
  }).mode;
}
