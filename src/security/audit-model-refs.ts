import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { modelKey } from "../agents/model-selection-normalize.js";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type AuditModelRef = { id: string; source: string };

function resolveAuditModelId(
  cfg: OpenClawConfig,
  raw: string,
  aliasIndex: ReturnType<typeof buildModelAliasIndex>,
): string {
  const resolved = resolveModelRefFromString({
    cfg,
    raw,
    defaultProvider: DEFAULT_PROVIDER,
    aliasIndex,
    allowPluginNormalization: false,
  })?.ref;
  return resolved ? modelKey(resolved.provider, resolved.model) : raw;
}

function addModelRef(params: {
  out: AuditModelRef[];
  cfg: OpenClawConfig;
  aliasIndex: ReturnType<typeof buildModelAliasIndex>;
  raw: unknown;
  source: string;
}): void {
  if (typeof params.raw !== "string") {
    return;
  }
  const raw = params.raw.trim();
  if (!raw) {
    return;
  }
  params.out.push({
    id: resolveAuditModelId(params.cfg, raw, params.aliasIndex),
    source: params.source,
  });
}

export function collectAuditModelRefs(cfg: OpenClawConfig): AuditModelRef[] {
  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    allowPluginNormalization: false,
  });
  const out: AuditModelRef[] = [];
  const add = (raw: unknown, source: string) => addModelRef({ out, cfg, aliasIndex, raw, source });

  add(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model), "agents.defaults.model.primary");
  for (const fallback of resolveAgentModelFallbackValues(cfg.agents?.defaults?.model)) {
    add(fallback, "agents.defaults.model.fallbacks");
  }
  add(
    resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel),
    "agents.defaults.imageModel.primary",
  );
  for (const fallback of resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel)) {
    add(fallback, "agents.defaults.imageModel.fallbacks");
  }

  const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const agent of list) {
    if (!agent || typeof agent !== "object") {
      continue;
    }
    const id =
      typeof (agent as { id?: unknown }).id === "string" ? (agent as { id: string }).id : "";
    const model = (agent as { model?: unknown }).model;
    if (typeof model === "string") {
      add(model, `agents.list.${id}.model`);
    } else if (model && typeof model === "object") {
      add((model as { primary?: unknown }).primary, `agents.list.${id}.model.primary`);
      const fallbacks = (model as { fallbacks?: unknown }).fallbacks;
      if (Array.isArray(fallbacks)) {
        for (const fallback of fallbacks) {
          add(fallback, `agents.list.${id}.model.fallbacks`);
        }
      }
    }
  }

  return out;
}
