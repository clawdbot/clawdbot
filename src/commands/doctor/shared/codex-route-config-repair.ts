import { AGENT_MODEL_CONFIG_KEYS } from "@openclaw/model-catalog-core/configured-model-refs";
import { asOptionalRecord as asMutableRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { listMutableCodexRouteAgentEntries } from "./codex-route-agent-entries.js";
import {
  maybeMigrateLegacyLosslessCompactionConfig,
  rewriteAgentCompactionRefs,
} from "./codex-route-compaction-repair.js";
import {
  collectLegacyLosslessCompactionConfigs,
  getSharedDefaultCompactionOverrideConsumers,
} from "./codex-route-compaction-scan.js";
import {
  asAgentRuntimePolicyConfig,
  readAgentPrimaryModelRef,
  readLegacyDefaultsRuntime,
  resolveRuntime,
  type LegacyCodexModelIdentity,
} from "./codex-route-model-ref.js";
import {
  recordCodexModelHit,
  rewriteModelConfigSlot,
  rewriteModelsMap,
} from "./codex-route-model-slots.js";
import {
  clearConfigLegacyAgentRuntimePolicies,
  ensureCodexRuntimePolicy,
  rewriteModelConfigSlotIfCanonicalCodexRuntime,
  rewriteStringModelSlotIfCanonicalCodexRuntime,
} from "./codex-route-runtime-policy.js";
import type {
  CodexRouteHit,
  ConfigRouteRepairResult,
  MutableRecord,
  SharedDefaultCompactionOverrideConsumers,
} from "./codex-route-types.js";

function rewriteModelPolicyAllowRefs(params: {
  hits: CodexRouteHit[];
  agent: MutableRecord;
  path: string;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): void {
  const modelPolicy = asMutableRecord(params.agent.modelPolicy);
  if (!Array.isArray(modelPolicy?.allow)) {
    return;
  }
  modelPolicy.allow = modelPolicy.allow.map((entry, index) => {
    if (typeof entry !== "string") {
      return entry;
    }
    return (
      recordCodexModelHit({
        hits: params.hits,
        path: `${params.path}.modelPolicy.allow.${index}`,
        model: entry.trim(),
        blockedModelIdentities: params.blockedModelIdentities,
      }) ?? entry
    );
  });
}

function rewriteAgentModelRefs(params: {
  cfg: OpenClawConfig;
  preRepairCfg: OpenClawConfig;
  hits: CodexRouteHit[];
  agent: MutableRecord | undefined;
  path: string;
  agentId?: string;
  currentRuntime?: string;
  inheritedModelRef?: string;
  inheritedCompaction?: unknown;
  inheritedCompactionPath?: string;
  rewriteModelsMap?: boolean;
  preserveUnsupportedCompactionOverrides?: SharedDefaultCompactionOverrideConsumers;
  preserveUnsupportedCompactionPaths?: ReadonlySet<string>;
  rewrittenInheritedCompactionModels?: Map<string, string>;
  runtimePolicyChanges: string[];
  unsupportedCompactionChanges: string[];
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  env?: NodeJS.ProcessEnv;
}): void {
  if (!params.agent) {
    return;
  }
  const preserveCodexRuntimePolicyForNewHits = (fromIndex: number) => {
    for (const hit of params.hits.slice(fromIndex)) {
      ensureCodexRuntimePolicy({
        cfg: params.cfg,
        agent: params.agent!,
        agentPath: params.path,
        agentId: params.agentId,
        modelRef: hit.canonicalModel,
        legacyModelRef: hit.model,
        isDefaults: params.path === "agents.defaults",
        preRepairCfg: params.preRepairCfg,
        changes: params.runtimePolicyChanges,
        env: params.env,
      });
    }
  };
  for (const key of AGENT_MODEL_CONFIG_KEYS) {
    const start = params.hits.length;
    if (key === "model") {
      rewriteModelConfigSlot({
        hits: params.hits,
        container: params.agent,
        key,
        path: `${params.path}.${key}`,
        runtime: params.currentRuntime,
        blockedModelIdentities: params.blockedModelIdentities,
      });
      preserveCodexRuntimePolicyForNewHits(start);
    } else {
      rewriteModelConfigSlotIfCanonicalCodexRuntime({
        cfg: params.cfg,
        agentId: params.agentId,
        hits: params.hits,
        container: params.agent,
        key,
        path: `${params.path}.${key}`,
        blockedModelIdentities: params.blockedModelIdentities,
        env: params.env,
      });
    }
  }
  rewriteStringModelSlotIfCanonicalCodexRuntime({
    cfg: params.cfg,
    agentId: params.agentId,
    hits: params.hits,
    container: asMutableRecord(params.agent.heartbeat),
    key: "model",
    path: `${params.path}.heartbeat.model`,
    blockedModelIdentities: params.blockedModelIdentities,
    env: params.env,
  });
  rewriteModelConfigSlotIfCanonicalCodexRuntime({
    cfg: params.cfg,
    agentId: params.agentId,
    hits: params.hits,
    container: asMutableRecord(params.agent.subagents),
    key: "model",
    path: `${params.path}.subagents.model`,
    blockedModelIdentities: params.blockedModelIdentities,
    env: params.env,
  });
  rewriteAgentCompactionRefs({
    cfg: params.cfg,
    preRepairCfg: params.preRepairCfg,
    hits: params.hits,
    agent: params.agent,
    path: params.path,
    agentId: params.agentId,
    currentRuntime: params.currentRuntime,
    inheritedModelRef: params.inheritedModelRef,
    inheritedCompaction: params.inheritedCompaction,
    inheritedCompactionPath: params.inheritedCompactionPath,
    preserveUnsupportedCompactionOverrides: params.preserveUnsupportedCompactionOverrides,
    preserveUnsupportedCompactionPaths: params.preserveUnsupportedCompactionPaths,
    rewrittenInheritedCompactionModels: params.rewrittenInheritedCompactionModels,
    runtimePolicyChanges: params.runtimePolicyChanges,
    unsupportedCompactionChanges: params.unsupportedCompactionChanges,
    blockedModelIdentities: params.blockedModelIdentities,
    env: params.env,
  });
  const mediaModels = asMutableRecord(params.agent.mediaModels);
  for (const key of ["image", "video"] as const) {
    rewriteModelConfigSlot({
      hits: params.hits,
      container: mediaModels ?? {},
      key,
      path: `${params.path}.mediaModels.${key}`,
      blockedModelIdentities: params.blockedModelIdentities,
    });
  }
  const modelPolicyStart = params.hits.length;
  rewriteModelPolicyAllowRefs({
    hits: params.hits,
    agent: params.agent,
    path: params.path,
    blockedModelIdentities: params.blockedModelIdentities,
  });
  preserveCodexRuntimePolicyForNewHits(modelPolicyStart);
  if (params.rewriteModelsMap) {
    const start = params.hits.length;
    rewriteModelsMap({
      hits: params.hits,
      models: asMutableRecord(params.agent.models),
      path: `${params.path}.models`,
      blockedModelIdentities: params.blockedModelIdentities,
    });
    preserveCodexRuntimePolicyForNewHits(start);
  }
}

function rewriteConfigModelRefsWithCompactionPolicy(params: {
  cfg: OpenClawConfig;
  preserveSharedDefaultCompactionOverrides: SharedDefaultCompactionOverrideConsumers;
  ignoreLegacyAgentRuntimePins?: boolean;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  env?: NodeJS.ProcessEnv;
}): ConfigRouteRepairResult {
  const nextConfig = structuredClone(params.cfg);
  const hits: CodexRouteHit[] = [];
  const runtimePolicyChanges: string[] = [];
  const unsupportedCompactionChanges: string[] = [];
  const ignoreLegacyAgentRuntimePins =
    params.ignoreLegacyAgentRuntimePins ??
    configRepairWouldClearLegacyRuntimePins({
      cfg: nextConfig,
      blockedModelIdentities: params.blockedModelIdentities,
      env: params.env,
    });
  unsupportedCompactionChanges.push(
    ...maybeMigrateLegacyLosslessCompactionConfig({
      cfg: nextConfig,
      ignoreLegacyAgentRuntimePins,
      env: params.env,
    }),
  );
  const preservedLegacyLosslessCompactionPaths = new Set(
    collectLegacyLosslessCompactionConfigs({
      cfg: nextConfig,
      ignoreLegacyAgentRuntimePins,
      env: params.env,
    }).flatMap((hit) => (hit.modelPath ? [hit.providerPath, hit.modelPath] : [hit.providerPath])),
  );
  const defaultsRuntime = ignoreLegacyAgentRuntimePins
    ? undefined
    : readLegacyDefaultsRuntime(nextConfig.agents?.defaults);
  const rewrittenInheritedCompactionModels = new Map<string, string>();
  rewriteAgentModelRefs({
    cfg: nextConfig,
    preRepairCfg: params.cfg,
    hits,
    agent: asMutableRecord(nextConfig.agents?.defaults),
    path: "agents.defaults",
    currentRuntime: resolveRuntime({ defaultsRuntime }),
    rewriteModelsMap: true,
    preserveUnsupportedCompactionOverrides: params.preserveSharedDefaultCompactionOverrides,
    preserveUnsupportedCompactionPaths: preservedLegacyLosslessCompactionPaths,
    rewrittenInheritedCompactionModels,
    runtimePolicyChanges,
    unsupportedCompactionChanges,
    blockedModelIdentities: params.blockedModelIdentities,
    env: params.env,
  });
  const inheritedModelRef = readAgentPrimaryModelRef(nextConfig.agents?.defaults);
  const agents = listMutableCodexRouteAgentEntries(nextConfig);
  for (const { agent: agentRecord, agentId, path } of agents) {
    rewriteAgentModelRefs({
      cfg: nextConfig,
      preRepairCfg: params.cfg,
      hits,
      agent: agentRecord,
      path,
      agentId,
      currentRuntime: resolveRuntime({
        agentRuntime: ignoreLegacyAgentRuntimePins
          ? undefined
          : asAgentRuntimePolicyConfig(agentRecord.agentRuntime),
        defaultsRuntime,
      }),
      inheritedModelRef,
      inheritedCompaction: nextConfig.agents?.defaults?.compaction,
      inheritedCompactionPath: "agents.defaults.compaction",
      rewriteModelsMap: true,
      preserveUnsupportedCompactionPaths: preservedLegacyLosslessCompactionPaths,
      rewrittenInheritedCompactionModels,
      runtimePolicyChanges,
      unsupportedCompactionChanges,
      blockedModelIdentities: params.blockedModelIdentities,
      env: params.env,
    });
  }
  rewriteNonAgentModelRefs({
    cfg: nextConfig,
    hits,
    blockedModelIdentities: params.blockedModelIdentities,
    env: params.env,
  });
  // A retained legacy provider can still own config, session, or cron refs that need these pins.
  // Keep global pins intact until the manual provider conflict is reconciled as one unit.
  const shouldClearRuntimePins =
    !params.blockedModelIdentities?.size && hits.some((hit) => !isCompactionOnlyRouteHit(hit));
  const runtimePinChanges = shouldClearRuntimePins
    ? clearConfigLegacyAgentRuntimePolicies(nextConfig)
    : [];
  return {
    cfg:
      hits.length > 0 ||
      runtimePolicyChanges.length > 0 ||
      runtimePinChanges.length > 0 ||
      unsupportedCompactionChanges.length > 0
        ? nextConfig
        : params.cfg,
    changes: hits,
    runtimePinChanges,
    runtimePolicyChanges,
    unsupportedCompactionChanges,
  };
}

function rewriteNonAgentModelRefs(params: {
  cfg: OpenClawConfig;
  hits: CodexRouteHit[];
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  env?: NodeJS.ProcessEnv;
}): void {
  const channelsModelByChannel = asMutableRecord(params.cfg.channels?.modelByChannel);
  for (const [channelId, channelMap] of Object.entries(channelsModelByChannel ?? {})) {
    const targets = asMutableRecord(channelMap);
    if (!targets) {
      continue;
    }
    for (const targetId of Object.keys(targets)) {
      rewriteStringModelSlotIfCanonicalCodexRuntime({
        cfg: params.cfg,
        hits: params.hits,
        container: targets,
        key: targetId,
        path: `channels.modelByChannel.${channelId}.${targetId}`,
        blockedModelIdentities: params.blockedModelIdentities,
        env: params.env,
      });
    }
  }
  for (const [index, mapping] of (params.cfg.hooks?.mappings ?? []).entries()) {
    rewriteStringModelSlotIfCanonicalCodexRuntime({
      cfg: params.cfg,
      hits: params.hits,
      container: mapping as MutableRecord,
      key: "model",
      path: `hooks.mappings.${index}.model`,
      blockedModelIdentities: params.blockedModelIdentities,
      env: params.env,
    });
  }
  rewriteStringModelSlotIfCanonicalCodexRuntime({
    cfg: params.cfg,
    hits: params.hits,
    container: asMutableRecord(params.cfg.hooks?.gmail),
    key: "model",
    path: "hooks.gmail.model",
    blockedModelIdentities: params.blockedModelIdentities,
    env: params.env,
  });
  rewriteStringModelSlotIfCanonicalCodexRuntime({
    cfg: params.cfg,
    hits: params.hits,
    container: asMutableRecord(params.cfg.tts),
    key: "summaryModel",
    path: "tts.summaryModel",
    blockedModelIdentities: params.blockedModelIdentities,
    env: params.env,
  });
  rewriteStringModelSlotIfCanonicalCodexRuntime({
    cfg: params.cfg,
    hits: params.hits,
    container: asMutableRecord(asMutableRecord(params.cfg.channels?.discord)?.voice),
    key: "model",
    path: "channels.discord.voice.model",
    blockedModelIdentities: params.blockedModelIdentities,
    env: params.env,
  });
}

export function configRepairWouldClearLegacyRuntimePins(params: {
  cfg: OpenClawConfig;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const dryRun = rewriteConfigModelRefsWithCompactionPolicy({
    cfg: params.cfg,
    preserveSharedDefaultCompactionOverrides: { model: true, provider: true },
    ignoreLegacyAgentRuntimePins: false,
    blockedModelIdentities: params.blockedModelIdentities,
    env: params.env,
  });
  return dryRun.runtimePinChanges.length > 0;
}

export function rewriteConfigModelRefs(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): ConfigRouteRepairResult {
  const preserveSharedDefaultCompactionOverrides = getSharedDefaultCompactionOverrideConsumers({
    cfg: params.cfg,
    ignoreLegacyAgentRuntimePins: configRepairWouldClearLegacyRuntimePins(params),
    env: params.env,
  });
  return rewriteConfigModelRefsWithCompactionPolicy({
    cfg: params.cfg,
    preserveSharedDefaultCompactionOverrides,
    blockedModelIdentities: params.blockedModelIdentities,
    env: params.env,
  });
}

function isCompactionOnlyRouteHit(hit: CodexRouteHit): boolean {
  return (
    hit.path.startsWith("agents.") &&
    (hit.path.endsWith(".compaction.model") || hit.path.endsWith(".compaction.memoryFlush.model"))
  );
}
