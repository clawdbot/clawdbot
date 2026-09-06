// Doctor consumes provider retirement facts only after selecting the exact auth route.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import { loadAuthProfileStoreForSecretsRuntime } from "../../../agents/auth-profiles/store-runtime.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { createModelAuthAvailabilityResolver } from "../../../agents/model-auth-availability.js";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  isModelKeyAllowedBySet,
  resolveConfiguredModelRef,
  resolveConfiguredModelPolicyAllow,
  resolveModelRefFromString,
} from "../../../agents/model-selection-shared.js";
import {
  canonicalizeProviderModelId,
  projectProviderModelRouteConfig,
} from "../../../agents/provider-model-route.js";
import { mergeAgentModelEntryForConfig } from "../../../config/model-input.js";
import { resolveMergedModelProviderConfig } from "../../../config/model-provider-config.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  loadManifestMetadataSnapshot,
  isManifestPluginAvailableForControlPlane,
} from "../../../plugins/manifest-contract-eligibility.js";
import { buildManifestBuiltInModelSuppressionResolver } from "../../../plugins/manifest-model-suppression.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import {
  applyModelOverrideToSessionEntry,
  isModelSelectionLocked,
} from "../../../sessions/model-overrides.js";
import { listMutableCodexRouteAgentEntries } from "./codex-route-agent-entries.js";
import { readModelConfigPrimaryRef } from "./codex-route-model-ref.js";
import { rewriteModelReferenceSlot } from "./codex-route-model-slots.js";

export type ModelRefRepair =
  | { kind: "unchanged" }
  | { kind: "replace"; modelRef: string; reason: "reference-preservation" }
  | {
      kind: "replace";
      modelRef: string;
      reason: "retirement";
      retirementScope: "route" | "provider";
    }
  | { kind: "clear"; provider: string; modelRef: string; retirementScope: "route" | "provider" };
export type ModelRefRepairResolver = (params: {
  modelRef: string;
  agentId?: string;
  authProfileId?: string;
  authProfileSource?: SessionEntry["authProfileOverrideSource"];
}) => ModelRefRepair;

/** Metadata and exact profile views stay scoped to Doctor's pre-transaction planning. */
export function createRetiredModelRefRepairResolver(params: {
  cfg: OpenClawConfig;
  retiredModelRefConfig?: Pick<OpenClawConfig, "agents" | "models">;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
  agentIds?: readonly string[];
  warnings?: string[];
  /** Persisted overrides cannot grant successor permissions by changing their owner's config. */
  checkModelPolicy?: boolean;
}): ModelRefRepairResolver {
  const env = params.env ?? process.env;
  const agents = params.agentIds ?? listAgentIds(params.cfg);
  const warn = (message: string) => {
    if (params.warnings && !params.warnings.includes(message)) {
      params.warnings.push(message);
    }
  };
  const owners = new Map(
    agents.map((agentId) => {
      const agentDir = resolveAgentDir(params.cfg, agentId, env);
      const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
      const metadataSnapshot =
        params.metadataSnapshot ??
        loadManifestMetadataSnapshot({ config: params.cfg, workspaceDir, env });
      const retirementCandidates = new Set(
        metadataSnapshot.plugins
          .filter((plugin) =>
            isManifestPluginAvailableForControlPlane({
              snapshot: metadataSnapshot,
              plugin,
              config: params.cfg,
            }),
          )
          .flatMap((plugin) =>
            (plugin.modelCatalog?.suppressions ?? [])
              .filter((rule) => rule.retirement)
              .map((rule) => `${rule.provider}/${rule.model}`.toLowerCase()),
          ),
      );
      const authViews = new Map<
        string | undefined,
        ReturnType<typeof createModelAuthAvailabilityResolver>
      >();
      const prepareModelResolver = (cfg: OpenClawConfig) => {
        const modelOptions = {
          cfg,
          agentId,
          manifestPlugins: metadataSnapshot.plugins,
          allowManifestNormalization: false,
          allowPluginNormalization: false,
        };
        const defaultRef = resolveConfiguredModelRef({
          ...modelOptions,
          defaultProvider: DEFAULT_PROVIDER,
          defaultModel: DEFAULT_MODEL,
        });
        const defaultProvider = defaultRef.provider;
        const aliasIndex = buildModelAliasIndex({ ...modelOptions, defaultProvider });
        return {
          defaultRef,
          resolve: (raw: string) =>
            resolveModelRefFromString({ ...modelOptions, raw, defaultProvider, aliasIndex })?.ref,
        };
      };
      // Preserve old alias/default interpretation without lending it auth or route authority.
      const model = prepareModelResolver(params.retiredModelRefConfig ?? params.cfg);
      const currentModel = params.retiredModelRefConfig ? prepareModelResolver(params.cfg) : model;
      return [
        agentId,
        {
          retirementCandidates,
          model: model.resolve,
          currentModel: currentModel.resolve,
          modelPolicy: params.checkModelPolicy
            ? buildAllowedModelSet({
                cfg: params.cfg,
                catalog: [],
                agentId,
                defaultProvider: currentModel.defaultRef.provider,
                defaultModel: currentModel.defaultRef.model,
                manifestPlugins: metadataSnapshot.plugins,
              })
            : undefined,
          auth(profileId: string | undefined) {
            let view = authViews.get(profileId);
            if (!view) {
              view = createModelAuthAvailabilityResolver({
                cfg: params.cfg,
                agentDir,
                workspaceDir,
                env,
                metadataSnapshot,
                authStore: loadAuthProfileStoreForSecretsRuntime(agentDir, {
                  config: params.cfg,
                  profileId,
                }),
              });
              authViews.set(profileId, view);
            }
            return view;
          },
          suppression(config = params.cfg) {
            return buildManifestBuiltInModelSuppressionResolver({
              config,
              workspaceDir,
              env,
              metadataSnapshot,
            });
          },
        },
      ];
    }),
  );
  const resolveForOwner = (
    input: Parameters<ModelRefRepairResolver>[0],
    agentId: string,
  ): ModelRefRepair => {
    const owner = owners.get(agentId);
    if (!owner) {
      return { kind: "unchanged" };
    }
    const parsed = splitTrailingAuthProfile(input.modelRef);
    const model = owner.model(parsed.model);
    if (!model) {
      return { kind: "unchanged" };
    }
    const provider = model.provider;
    const id = canonicalizeProviderModelId(provider, model.model);
    const canonical = `${provider}/${id}`;
    const validatePolicy = (repair: ModelRefRepair): ModelRefRepair => {
      if (repair.kind !== "replace" || !owner.modelPolicy || owner.modelPolicy.allowAny) {
        return repair;
      }
      const replacement = splitTrailingAuthProfile(repair.modelRef).model;
      if (isModelKeyAllowedBySet(owner.modelPolicy.allowedKeys, replacement)) {
        return repair;
      }
      const policyPath = resolveConfiguredModelPolicyAllow({
        cfg: params.cfg,
        agentId,
      }).repairConfigPath.replace("*", agentId);
      warn(
        `Retained model reference "${canonical}" for agent "${agentId}": "${replacement}" is not permitted. Allow "${replacement}" in ${policyPath} and rerun openclaw doctor --fix, or choose an allowed model override.`,
      );
      return { kind: "unchanged" };
    };
    const current = owner.currentModel(parsed.model);
    const preserved: ModelRefRepair =
      current?.provider === provider && canonicalizeProviderModelId(provider, current.model) === id
        ? { kind: "unchanged" }
        : {
            kind: "replace",
            modelRef: parsed.profile ? `${canonical}@${parsed.profile}` : canonical,
            reason: "reference-preservation",
          };
    if (!owner.retirementCandidates.has(`${provider}/${id}`.toLowerCase())) {
      return validatePolicy(preserved);
    }
    let rule = owner.suppression()({ provider, id, unconditionalOnly: true });
    const retirementScope = rule?.retirement ? "provider" : "route";
    if (!rule?.retirement) {
      const pinnedProfileId =
        (input.authProfileSource === "user" || input.authProfileSource === "user-link"
          ? input.authProfileId
          : undefined) ?? parsed.profile;
      const preferredProfileId = pinnedProfileId ? undefined : input.authProfileId;
      const auth = owner.auth(pinnedProfileId ?? preferredProfileId).evaluateModelAuth(provider, {
        modelId: id,
        pinnedProfileId,
        preferredProfileId,
      });
      // Missing catalog/auth evidence is not proof of retirement. In particular,
      // a native account owned by a runtime cannot be inferred from OAuth elsewhere.
      const configured =
        auth.routeResolution === null &&
        (auth.selectedAuthMode !== undefined || auth.availability === true)
          ? resolveMergedModelProviderConfig(params.cfg, provider)
          : undefined;
      const baseUrl = auth.selectedRoute?.baseUrl ?? configured?.baseUrl;
      if (!baseUrl) {
        warn(
          `Retained ${canonical} for agent "${agentId}": its exact authentication route is unavailable. Restore that provider account and rerun openclaw doctor --fix, or choose a current model explicitly.`,
        );
        return validatePolicy(preserved);
      }
      // API and endpoint conditions must describe the same selected auth route.
      const routeConfig = auth.selectedRoute
        ? projectProviderModelRouteConfig({
            provider,
            config: params.cfg,
            route: auth.selectedRoute,
          })
        : params.cfg;
      rule = owner.suppression(routeConfig)({ provider, id, baseUrl });
    }
    if (!rule?.retirement) {
      return validatePolicy(preserved);
    }
    const successor = rule.retirement.replacedBy;
    if (!successor) {
      return { kind: "clear", provider, modelRef: canonical, retirementScope };
    }
    const modelRef = `${provider}/${successor}`;
    return validatePolicy({
      kind: "replace",
      modelRef: parsed.profile ? `${modelRef}@${parsed.profile}` : modelRef,
      reason: "retirement",
      retirementScope,
    });
  };
  return (input) => {
    if (input.agentId) {
      return resolveForOwner(input, input.agentId);
    }
    const decisions = agents.map((agentId) => resolveForOwner(input, agentId));
    const first = decisions[0];
    // A shared default must remain valid for every inheriting auth owner. Never
    // rewrite a Platform choice because another agent uses a retired subscription route.
    const consistent =
      first &&
      decisions.every(
        (decision) =>
          decision.kind === first.kind &&
          (decision.kind !== "replace" ||
            (first.kind === "replace" && decision.modelRef === first.modelRef)),
      );
    if (!consistent && decisions.some((decision) => decision.kind !== "unchanged")) {
      warn(
        `Retained shared model reference "${input.modelRef}": agent authentication routes require different repairs. Choose a current model in each affected agent's model configuration.`,
      );
    }
    if (!consistent) {
      return { kind: "unchanged" };
    }
    // Shared metadata remains valid if any owner still offers another auth route.
    return "retirementScope" in first &&
      decisions.some(
        (decision) => "retirementScope" in decision && decision.retirementScope === "route",
      )
      ? { ...first, retirementScope: "route" }
      : first;
  };
}

type ModelRefRewriteContext = {
  path: string;
  agentId?: string;
  resolve: ModelRefRepairResolver;
  changes: string[];
  warnings?: string[];
  preservePrimaryWithoutSuccessor?: boolean;
};
type RetiredModelSlotRepair = ModelRefRewriteContext & {
  owner: Record<string, unknown>;
  inheritedModelRef?: string;
  inheritedModels?: Record<string, unknown>;
  inheritedModelPolicy?: Record<string, unknown>;
};

function createRetiredModelRefRewriter(params: ModelRefRewriteContext) {
  return (modelRef: string, path: string): string | null | undefined => {
    const decision = params.resolve({ modelRef, agentId: params.agentId });
    if (decision.kind === "unchanged") {
      return undefined;
    }
    if (
      decision.kind === "clear" &&
      params.preservePrimaryWithoutSuccessor &&
      (path === `${params.path}.model` || path === `${params.path}.model.primary`)
    ) {
      params.warnings?.push(
        `Retained retired ${path} "${modelRef}": no provider successor is declared and this global default has no agent default to inherit. Choose a supported default with openclaw models set.`,
      );
      return undefined;
    }
    params.changes.push(
      decision.kind === "replace"
        ? decision.reason === "reference-preservation"
          ? `Preserved ${path} model "${modelRef}" as "${decision.modelRef}" after config repair.`
          : `Replaced retired ${path} "${modelRef}" with "${decision.modelRef}".`
        : `Removed retired ${path} "${modelRef}" so it inherits the configured default model.`,
    );
    return decision.kind === "replace" ? decision.modelRef : null;
  };
}

function modelSettingsWithoutAlias(value: unknown): unknown {
  const record = asOptionalRecord(value);
  if (!record) {
    return value;
  }
  const { alias: _alias, ...settings } = record;
  return settings;
}

/** Apply the same retirement decision to config selectors and cron payload selectors. */
export function repairRetiredModelSlots(params: RetiredModelSlotRepair): void {
  const rewrite = createRetiredModelRefRewriter(params);
  const rewriteSlot = (container: unknown, key: string, path: string) =>
    rewriteModelReferenceSlot({
      container: asOptionalRecord(container),
      key,
      path,
      resolve: rewrite,
    });
  // Speech and media generation select their own capability provider routes.
  for (const key of ["model", "utilityModel", "imageModel", "pdfModel"] as const) {
    rewriteSlot(params.owner, key, `${params.path}.${key}`);
    const selector = asOptionalRecord(params.owner[key]);
    if (selector && Object.keys(selector).length === 0) {
      delete params.owner[key];
    }
  }
  // Cron stores fallback refs beside payload.model, rather than inside its selector.
  rewriteSlot({ selector: params.owner }, "selector", params.path);
  for (const key of ["heartbeat", "subagents", "compaction"] as const) {
    rewriteSlot(params.owner[key], "model", `${params.path}.${key}.model`);
  }
  rewriteSlot(
    asOptionalRecord(params.owner.compaction)?.memoryFlush,
    "model",
    `${params.path}.compaction.memoryFlush.model`,
  );
  rewriteSlot(
    asOptionalRecord(asOptionalRecord(params.owner.tools)?.exec)?.reviewer,
    "model",
    `${params.path}.tools.exec.reviewer.model`,
  );
  rewriteSlot(params.owner.tts, "summaryModel", `${params.path}.tts.summaryModel`);
  let models = asOptionalRecord(params.owner.models);
  for (const [modelRef, inherited] of Object.entries(params.inheritedModels ?? {})) {
    const decision = params.resolve({ modelRef, agentId: params.agentId });
    if (decision.kind !== "replace") {
      continue;
    }
    const retainAlias = decision.reason === "retirement" && decision.retirementScope === "route";
    // A shared map can remain on the old route for API accounts. Materialize
    // the retired owner's settings locally, with authored successor values winning.
    const settings = [
      inherited,
      models?.[modelRef],
      params.inheritedModels?.[decision.modelRef],
      models?.[decision.modelRef],
    ]
      // A retained model owns its alias; copying it would rebind healthy account selections.
      .map((value, index) => (retainAlias && index < 2 ? modelSettingsWithoutAlias(value) : value))
      .filter((value) => value !== undefined)
      .reduce<unknown>(mergeAgentModelEntryForConfig, undefined);
    if (JSON.stringify(settings) === JSON.stringify(models?.[decision.modelRef])) {
      continue;
    }
    models ??= {};
    params.owner.models = models;
    models[decision.modelRef] = settings;
    params.changes.push(
      `Preserved inherited ${modelRef} settings in ${params.path}.models.${decision.modelRef}.`,
    );
  }
  for (const modelRef of Object.keys(models ?? {})) {
    const decision = params.resolve({ modelRef, agentId: params.agentId });
    if (decision.kind === "unchanged" || !models) {
      continue;
    }
    const replacement = decision.kind === "replace" ? decision.modelRef : params.inheritedModelRef;
    if (!replacement) {
      continue;
    }
    const retain = "retirementScope" in decision && decision.retirementScope === "route";
    const existing = models[replacement];
    const source = retain ? modelSettingsWithoutAlias(models[modelRef]) : models[modelRef];
    const settings =
      decision.kind === "replace"
        ? existing === undefined
          ? source
          : mergeAgentModelEntryForConfig(source, existing)
        : (existing ?? {});
    if (retain && JSON.stringify(settings) === JSON.stringify(existing)) {
      continue;
    }
    models[replacement] = settings;
    if (!retain) {
      delete models[modelRef];
    }
    params.changes.push(
      retain
        ? `Preserved ${params.path}.models.${modelRef} for other authentication routes and added ${replacement}.`
        : `Moved retired ${params.path}.models.${modelRef} to ${replacement}.`,
    );
  }
  const policy = asOptionalRecord(params.owner.modelPolicy);
  const allowed = policy?.allow ?? params.inheritedModelPolicy?.allow;
  if (Array.isArray(allowed)) {
    let changed = false;
    const rewritten = allowed.flatMap((value, index) => {
      if (typeof value !== "string") {
        return [value];
      }
      const decision = params.resolve({ modelRef: value, agentId: params.agentId });
      if (decision.kind === "unchanged") {
        return [value];
      }
      const replacement =
        decision.kind === "replace" ? decision.modelRef : params.inheritedModelRef;
      // Keep a restrictive policy restrictive even when no successor exists.
      if (!replacement || replacement === value) {
        return [value];
      }
      const retain = "retirementScope" in decision && decision.retirementScope === "route";
      if (retain && allowed.includes(replacement)) {
        return [value];
      }
      changed = true;
      params.changes.push(
        retain
          ? `Preserved ${params.path}.modelPolicy.allow.${index} "${value}" for other authentication routes and allowed "${replacement}".`
          : `Replaced retired ${params.path}.modelPolicy.allow.${index} "${value}" with "${replacement}".`,
      );
      return retain ? [value, replacement] : [replacement];
    });
    if (changed) {
      params.owner.modelPolicy = { ...policy, allow: [...new Set(rewritten)] };
    }
  }
}

export function repairRetiredConfigModelRefs(
  cfg: OpenClawConfig,
  resolve: ModelRefRepairResolver,
  warnings: string[] = [],
) {
  const config = structuredClone(cfg);
  const changes: string[] = [];
  const defaults = asOptionalRecord(config.agents?.defaults);
  if (defaults) {
    repairRetiredModelSlots({
      owner: defaults,
      path: "agents.defaults",
      resolve,
      changes,
      warnings,
      preservePrimaryWithoutSuccessor: true,
    });
  }
  for (const { agent, agentId, path } of listMutableCodexRouteAgentEntries(config)) {
    const inheritedModelRef = readModelConfigPrimaryRef(defaults?.model);
    const repairInheritedPrimary =
      !readModelConfigPrimaryRef(agent.model) &&
      inheritedModelRef &&
      resolve({ modelRef: inheritedModelRef, agentId }).kind === "replace";
    const inheritedFallbacks =
      resolveAgentModelFallbacksOverride(config, agentId) === undefined
        ? asOptionalRecord(defaults?.model)?.fallbacks
        : undefined;
    const repairInheritedFallbacks =
      Array.isArray(inheritedFallbacks) &&
      inheritedFallbacks.some(
        (modelRef) =>
          typeof modelRef === "string" && resolve({ modelRef, agentId }).kind !== "unchanged",
      );
    if (repairInheritedPrimary || repairInheritedFallbacks) {
      // A new explicit primary disables fallback inheritance. Carry inherited
      // fallbacks when pinning it, but keep a healthy shared primary inherited.
      const ownModel = asOptionalRecord(agent.model);
      agent.model =
        typeof defaults?.model === "string" && !ownModel
          ? defaults.model
          : {
              ...(repairInheritedPrimary ? { primary: inheritedModelRef } : {}),
              ...(Array.isArray(inheritedFallbacks) ? { fallbacks: [...inheritedFallbacks] } : {}),
              ...ownModel,
            };
    }
    repairRetiredModelSlots({
      owner: agent,
      agentId,
      path,
      resolve,
      changes,
      warnings,
      inheritedModelRef,
      inheritedModels: asOptionalRecord(defaults?.models),
      inheritedModelPolicy: asOptionalRecord(defaults?.modelPolicy),
    });
  }
  const rewrite = createRetiredModelRefRewriter({ path: "", resolve, changes, warnings });
  const rewriteSlot = (container: unknown, key: string, path: string) =>
    rewriteModelReferenceSlot({
      container: asOptionalRecord(container),
      key,
      path,
      resolve: rewrite,
    });
  rewriteSlot(config.tools?.exec?.reviewer, "model", "tools.exec.reviewer.model");
  rewriteSlot(config.tts, "summaryModel", "tts.summaryModel");
  rewriteSlot(config.hooks?.gmail, "model", "hooks.gmail.model");
  for (const [index, mapping] of (config.hooks?.mappings ?? []).entries()) {
    rewriteSlot(mapping, "model", `hooks.mappings.${index}.model`);
  }
  for (const [channel, targets] of Object.entries(config.channels?.modelByChannel ?? {})) {
    for (const target of Object.keys(targets ?? {})) {
      rewriteSlot(targets, target, `channels.modelByChannel.${channel}.${target}`);
    }
  }
  const discord = asOptionalRecord(config.channels?.discord);
  const rewriteVoice = (container: unknown, path: string) => {
    rewriteSlot(container, "model", `${path}.model`);
    rewriteSlot(asOptionalRecord(container)?.tts, "summaryModel", `${path}.tts.summaryModel`);
  };
  rewriteVoice(discord?.voice, "channels.discord.voice");
  for (const [account, settings] of Object.entries(asOptionalRecord(discord?.accounts) ?? {})) {
    rewriteVoice(asOptionalRecord(settings)?.voice, `channels.discord.accounts.${account}.voice`);
  }
  return { config: changes.length ? config : cfg, changes };
}

/** Session selection owns invalidation of context/fallback metadata and profile preservation. */
export function repairRetiredSessionModelRef(
  entry: SessionEntry,
  agentId: string,
  resolve: ModelRefRepairResolver,
  defaultModelRef: string | undefined,
  warnings: string[],
): boolean {
  if (!entry.modelOverride || isModelSelectionLocked(entry)) {
    return false;
  }
  const modelRef = entry.providerOverride
    ? `${entry.providerOverride}/${entry.modelOverride}`
    : entry.modelOverride;
  const decision = resolve({
    modelRef,
    agentId,
    authProfileId: entry.authProfileOverride,
    authProfileSource: entry.authProfileOverrideSource,
  });
  if (decision.kind === "unchanged") {
    return false;
  }
  const replacement = splitTrailingAuthProfile(
    decision.kind === "replace" ? decision.modelRef : (defaultModelRef ?? ""),
  ).model;
  if (
    decision.kind === "clear" &&
    replacement === decision.modelRef &&
    entry.authProfileOverride &&
    (entry.authProfileOverrideSource === "user" || entry.authProfileOverrideSource === "user-link")
  ) {
    const warning = `Retained retired ${decision.modelRef} for agent "${agentId}": clearing this session override would still select it with the same pinned account. Choose a supported default or an allowed model override, then rerun openclaw doctor --fix.`;
    if (!warnings.includes(warning)) {
      warnings.push(warning);
    }
    return false;
  }
  const slash = replacement.indexOf("/");
  return applyModelOverrideToSessionEntry({
    entry,
    selection: {
      provider: replacement.slice(0, slash),
      model: replacement.slice(slash + 1),
      isDefault: decision.kind === "clear",
    },
    preserveAuthProfileOverride:
      decision.kind === "replace" || replacement.slice(0, slash) === decision.provider,
    selectionSource: entry.modelOverrideSource === "auto" ? "auto" : "user",
  }).updated;
}
