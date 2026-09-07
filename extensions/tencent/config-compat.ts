// Tencent config compatibility repairs shipped TokenHub model allowlists.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

const TENCENT_TOKENHUB_HY3_MODEL_REF = "tencent-tokenhub/hy3";
const TENCENT_TOKENHUB_HY3_PREVIEW_MODEL_REF = "tencent-tokenhub/hy3-preview";
const TENCENT_TOKENHUB_HY4_PREVIEW_MODEL_REF = "tencent-tokenhub/hy4-preview";

// Legacy Hy3 preview configs migrate to Hy3, not the fresh-onboarding default.
// Pin this independently of the manifest: a default rotation must not silently
// upgrade existing users to Hy4 with different pricing and model access.
const TENCENT_TOKENHUB_MIGRATION_TARGET_MODEL_REF = TENCENT_TOKENHUB_HY3_MODEL_REF;

// Ordered so the repaired allowlist matches onboard.ts's alias order.
const TENCENT_TOKENHUB_MANAGED_MODEL_REFS = [
  TENCENT_TOKENHUB_HY4_PREVIEW_MODEL_REF,
  TENCENT_TOKENHUB_HY3_MODEL_REF,
  TENCENT_TOKENHUB_HY3_PREVIEW_MODEL_REF,
] as const;

type TencentTokenHubManagedModelRef = (typeof TENCENT_TOKENHUB_MANAGED_MODEL_REFS)[number];

const TENCENT_TOKENHUB_MODEL_ALIASES: Record<TencentTokenHubManagedModelRef, string> = {
  [TENCENT_TOKENHUB_HY4_PREVIEW_MODEL_REF]: "Hy4 preview (TokenHub)",
  [TENCENT_TOKENHUB_HY3_MODEL_REF]: "Hy3 (TokenHub)",
  [TENCENT_TOKENHUB_HY3_PREVIEW_MODEL_REF]: "Hy3 preview (TokenHub)",
};

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
type AgentDefaultModel = AgentDefaults["model"];
type AgentModelEntry = NonNullable<AgentDefaults["models"]>[string];

function isTokenHubModelMapConfigured(models: Record<string, AgentModelEntry>): boolean {
  return TENCENT_TOKENHUB_MANAGED_MODEL_REFS.some((ref) => Object.hasOwn(models, ref));
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

function needsModelRepair(
  models: Record<string, AgentModelEntry>,
  ref: TencentTokenHubManagedModelRef,
): boolean {
  return !Object.hasOwn(models, ref) || needsDefaultAlias(models[ref]);
}

// Only the deprecated hy3-preview ref is migrated. hy3 is a GA model, and
// hy4-preview is a preview that additionally requires the API key's
// allowed-model scope to cover hy4, so silently moving a working hy3 primary
// onto it would break live setups with err_code=401006.
function migrateDefaultModel(model: AgentDefaultModel): {
  model: AgentDefaultModel;
  changed: boolean;
} {
  if (model === TENCENT_TOKENHUB_HY3_PREVIEW_MODEL_REF) {
    return {
      model: { primary: TENCENT_TOKENHUB_MIGRATION_TARGET_MODEL_REF },
      changed: true,
    };
  }
  if (
    model &&
    typeof model === "object" &&
    "primary" in model &&
    model.primary === TENCENT_TOKENHUB_HY3_PREVIEW_MODEL_REF
  ) {
    return {
      model: {
        ...model,
        primary: TENCENT_TOKENHUB_MIGRATION_TARGET_MODEL_REF,
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

  const needsModelMapRepair = TENCENT_TOKENHUB_MANAGED_MODEL_REFS.some((ref) =>
    needsModelRepair(existingModels, ref),
  );
  const migratedModel = migrateDefaultModel(cfg.agents?.defaults?.model);
  if (!needsModelMapRepair && !migratedModel.changed) {
    return { config: cfg, changes: [] };
  }

  const nextModels = { ...existingModels };
  for (const ref of TENCENT_TOKENHUB_MANAGED_MODEL_REFS) {
    nextModels[ref] = withDefaultAlias(existingModels[ref], TENCENT_TOKENHUB_MODEL_ALIASES[ref]);
  }

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
    `Updated Tencent TokenHub agent model defaults to include ${TENCENT_TOKENHUB_MANAGED_MODEL_REFS.join(", ")}.`,
  ];
  if (migratedModel.changed) {
    changes.push(
      `Changed Tencent TokenHub primary default from ${TENCENT_TOKENHUB_HY3_PREVIEW_MODEL_REF} to ${TENCENT_TOKENHUB_MIGRATION_TARGET_MODEL_REF}.`,
    );
  }

  return { config: nextConfig, changes };
}
