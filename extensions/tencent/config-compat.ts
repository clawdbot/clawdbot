// Tencent config compatibility repairs shipped TokenHub model allowlists.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

const TENCENT_TOKENHUB_DEFAULT_MODEL_REF = "tencent-tokenhub/hy3";
const TENCENT_TOKENHUB_PREVIEW_MODEL_REF = "tencent-tokenhub/hy3-preview";

const TOKENHUB_DEFAULT_ALIAS = "Hy3 (TokenHub)";
const TOKENHUB_PREVIEW_ALIAS = "Hy3 preview (TokenHub)";

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
type AgentDefaultModel = AgentDefaults["model"];
type AgentModelEntry = NonNullable<AgentDefaults["models"]>[string];

function isTokenHubModelMapConfigured(models: Record<string, AgentModelEntry>): boolean {
  return (
    Object.hasOwn(models, TENCENT_TOKENHUB_DEFAULT_MODEL_REF) ||
    Object.hasOwn(models, TENCENT_TOKENHUB_PREVIEW_MODEL_REF)
  );
}

function withDefaultAlias(entry: AgentModelEntry | undefined, alias: string): AgentModelEntry {
  return {
    ...entry,
    alias: entry?.alias ?? alias,
  };
}

function needsDefaultAlias(entry: AgentModelEntry | undefined): boolean {
  return entry?.alias === undefined;
}

function migrateDefaultModel(model: AgentDefaultModel): {
  model: AgentDefaultModel;
  changed: boolean;
} {
  if (model === TENCENT_TOKENHUB_PREVIEW_MODEL_REF) {
    return {
      model: { primary: TENCENT_TOKENHUB_DEFAULT_MODEL_REF },
      changed: true,
    };
  }
  if (
    model &&
    typeof model === "object" &&
    "primary" in model &&
    model.primary === TENCENT_TOKENHUB_PREVIEW_MODEL_REF
  ) {
    return {
      model: {
        ...model,
        primary: TENCENT_TOKENHUB_DEFAULT_MODEL_REF,
      },
      changed: true,
    };
  }
  return { model, changed: false };
}

export function migrateTencentTokenHubModelDefaults(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const existingModels = cfg.agents?.defaults?.models;
  if (!existingModels || !isTokenHubModelMapConfigured(existingModels)) {
    return { config: cfg, changes: [] };
  }

  const needsDefaultRepair =
    !Object.hasOwn(existingModels, TENCENT_TOKENHUB_DEFAULT_MODEL_REF) ||
    needsDefaultAlias(existingModels[TENCENT_TOKENHUB_DEFAULT_MODEL_REF]);
  const needsPreviewRepair =
    !Object.hasOwn(existingModels, TENCENT_TOKENHUB_PREVIEW_MODEL_REF) ||
    needsDefaultAlias(existingModels[TENCENT_TOKENHUB_PREVIEW_MODEL_REF]);
  const migratedModel = migrateDefaultModel(cfg.agents?.defaults?.model);
  if (!needsDefaultRepair && !needsPreviewRepair && !migratedModel.changed) {
    return { config: cfg, changes: [] };
  }

  const nextModels = {
    ...existingModels,
    [TENCENT_TOKENHUB_DEFAULT_MODEL_REF]: withDefaultAlias(
      existingModels[TENCENT_TOKENHUB_DEFAULT_MODEL_REF],
      TOKENHUB_DEFAULT_ALIAS,
    ),
    [TENCENT_TOKENHUB_PREVIEW_MODEL_REF]: withDefaultAlias(
      existingModels[TENCENT_TOKENHUB_PREVIEW_MODEL_REF],
      TOKENHUB_PREVIEW_ALIAS,
    ),
  };

  const nextConfig: OpenClawConfig = {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models: nextModels,
        ...(migratedModel.model !== undefined ? { model: migratedModel.model } : undefined),
      },
    },
  };

  const changes = [
    `Updated Tencent TokenHub agent model defaults to include ${TENCENT_TOKENHUB_DEFAULT_MODEL_REF} and ${TENCENT_TOKENHUB_PREVIEW_MODEL_REF}.`,
  ];
  if (migratedModel.changed) {
    changes.push(
      `Changed Tencent TokenHub primary default from ${TENCENT_TOKENHUB_PREVIEW_MODEL_REF} to ${TENCENT_TOKENHUB_DEFAULT_MODEL_REF}.`,
    );
  }

  return { config: nextConfig, changes };
}
