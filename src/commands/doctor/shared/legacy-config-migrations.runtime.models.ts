import {
  defineLegacyConfigMigration,
  ensureRecord,
  getRecord,
} from "../../../config/legacy.shared.js";
import { isModelThinkingFormat } from "../../../config/types.models.js";
import * as catalog from "./legacy-config-migrations.runtime.models.catalog.js";
import * as codex from "./legacy-config-migrations.runtime.models.codex.js";
import * as refs from "./legacy-config-migrations.runtime.models.refs.js";
import * as vllm from "./legacy-config-migrations.runtime.models.vllm.js";

export { collectBlockedLegacyOpenAICodexProviderPlan } from "./legacy-config-migrations.runtime.models.codex.js";
export type { BlockedLegacyOpenAICodexProviderPlan } from "./legacy-config-migrations.runtime.models.codex.js";

/** Legacy config migration specs for model/provider runtime config compatibility. */
const LEGACY_DEFAULT_MODEL_MIGRATION = defineLegacyConfigMigration({
  id: "defaultModel->agents.defaults.model",
  describe: "Move the retired root default model to agent defaults",
  legacyRules: [
    {
      path: ["defaultModel"],
      message: 'defaultModel moved to agents.defaults.model. Run "openclaw doctor --fix".',
    },
  ],
  apply: (raw, changes) => {
    if (!Object.hasOwn(raw, "defaultModel")) {
      return;
    }
    const legacyDefaultModel = raw.defaultModel;
    const currentDefaults = getRecord(getRecord(raw.agents)?.defaults);
    if (currentDefaults?.model === undefined && typeof legacyDefaultModel === "string") {
      const defaults = ensureRecord(ensureRecord(raw, "agents"), "defaults");
      defaults.model = legacyDefaultModel;
      changes.push("Moved defaultModel → agents.defaults.model.");
    } else {
      changes.push("Removed defaultModel (agents.defaults.model already set or value invalid).");
    }
    delete raw.defaultModel;
  },
});

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS = [
  LEGACY_DEFAULT_MODEL_MIGRATION,
  defineLegacyConfigMigration({
    id: "models.pricing-retired",
    describe: "Remove the retired client-side model pricing bootstrap toggle",
    legacyRules: [
      {
        path: ["models", "pricing"],
        message:
          'models.pricing is retired because pricing ships with the hosted catalog; run "openclaw doctor --fix" to remove it.',
      },
    ],
    apply: (raw, changes) => {
      const models = getRecord(raw.models);
      if (!models || !Object.hasOwn(models, "pricing")) {
        return;
      }
      delete models.pricing;
      changes.push("Removed models.pricing (pricing now ships with the hosted model catalog).");
    },
  }),
  defineLegacyConfigMigration({
    id: "models.providers.*.models.*.compat->provider-catalog",
    describe: "Move known-model compatibility capability ownership into provider catalogs",
    legacyRules: catalog.MODEL_COMPAT_CATALOG_RULES,
    apply: catalog.migrateModelCompatCatalogOwnership,
  }),
  defineLegacyConfigMigration({
    id: "models.providers.codex-routes->models.providers.openai",
    describe: "Move legacy Codex-route provider config to canonical OpenAI provider config",
    legacyRules: [
      {
        path: ["models", "providers"],
        message:
          'models.providers.codex and models.providers.openai-codex are legacy; run "openclaw doctor --fix" to move them to models.providers.openai.',
        match: (value, root) => codex.hasAutoFixableLegacyOpenAICodexProvider(value, root),
      },
      {
        path: ["models", "providers"],
        message:
          'openai-codex-responses is legacy; run "openclaw doctor --fix" to use openai-chatgpt-responses.',
        match: (value) => {
          const providers = getRecord(value);
          return providers
            ? Object.values(providers).some((providerValue) => {
                const provider = getRecord(providerValue);
                return (
                  provider?.api === codex.LEGACY_OPENAI_CODEX_RESPONSES_API ||
                  (Array.isArray(provider?.models) &&
                    provider.models.some(
                      (model) => getRecord(model)?.api === codex.LEGACY_OPENAI_CODEX_RESPONSES_API,
                    ))
                );
              })
            : false;
        },
      },
    ],
    apply: codex.migrateLegacyOpenAICodexProvider,
  }),
  defineLegacyConfigMigration({
    id: "models.canonical-model-refs",
    describe: "Canonicalize retired and noncanonical model refs",
    legacyRules: codex.MODEL_REF_CANONICALIZATION_RULES,
    apply: (raw, changes) => {
      const rewritten = refs.rewriteKnownModelRefs(raw, "config", changes);
      const rewrittenRecord = getRecord(rewritten.value);
      if (!rewritten.changed || !rewrittenRecord) {
        return;
      }
      for (const key of Object.keys(raw)) {
        delete raw[key];
      }
      for (const [key, value] of Object.entries(rewrittenRecord)) {
        refs.setRecordEntry(raw, key, value);
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "agents.defaults.models->agents.defaults.modelPolicy.allow",
    describe: "Make the legacy model override restriction explicit",
    legacyRules: [
      {
        path: ["agents", "defaults", "models"],
        message:
          'agents.defaults.models no longer restricts model overrides; run "openclaw doctor --fix" to preserve the previous restriction in agents.defaults.modelPolicy.allow.',
        match: (_value, root) => refs.collectLegacyDefaultModelAllowRefs(root) !== null,
      },
    ],
    apply: refs.migrateExplicitDefaultModelAllowPolicy,
  }),
  defineLegacyConfigMigration({
    id: "agents.defaults.models.vllm.params.qwenThinkingFormat->models.providers.vllm.models.compat.thinkingFormat",
    describe: "Move legacy vLLM Qwen thinking params to model compat metadata",
    legacyRules: [
      vllm.LEGACY_VLLM_QWEN_AGENT_THINKING_FORMAT_RULE,
      vllm.LEGACY_VLLM_QWEN_PROVIDER_THINKING_FORMAT_RULE,
      vllm.LEGACY_VLLM_QWEN_PROVIDER_MODEL_THINKING_FORMAT_RULE,
      vllm.LEGACY_VLLM_QWEN_NORMALIZED_PROVIDER_THINKING_FORMAT_RULE,
      vllm.LEGACY_VLLM_QWEN_DEFAULT_PARAMS_THINKING_FORMAT_RULE,
      vllm.LEGACY_VLLM_QWEN_AGENT_PARAMS_THINKING_FORMAT_RULE,
    ],
    apply: (raw, changes) => {
      const agentsDefaults = getRecord(getRecord(raw.agents)?.defaults);
      const defaultModels = getRecord(agentsDefaults?.models);
      if (defaultModels) {
        for (const [key, entry] of Object.entries(defaultModels)) {
          const modelId = vllm.parseVllmAgentModelKey(key);
          const entryRecord = getRecord(entry);
          const params = getRecord(entryRecord?.params);
          if (!modelId || !entryRecord || !params) {
            continue;
          }

          const legacyFormat = vllm.getLegacyVllmQwenThinkingFormat(params);
          if (!legacyFormat) {
            continue;
          }

          const target = legacyFormat.compat
            ? vllm.findOrCreateVllmModelEntry(raw, modelId)
            : undefined;
          if (legacyFormat.compat && !target) {
            continue;
          }
          vllm.applyLegacyVllmQwenThinkingFormat({
            sourcePath: `agents.defaults.models.${JSON.stringify(key)}.params`,
            legacyParams: params,
            target: target ?? { model: {}, index: -1 },
            legacyFormat,
            changes,
          });
          if (Object.keys(params).length === 0) {
            delete entryRecord.params;
          }
        }
      }

      const vllmProvider = vllm.findVllmProvider(getRecord(getRecord(raw.models)?.providers));
      const vllmModels = vllmProvider?.models;
      if (Array.isArray(vllmModels)) {
        for (const [index, model] of vllmModels.entries()) {
          const modelRecord = getRecord(model);
          const params = getRecord(modelRecord?.params);
          if (!modelRecord || !params) {
            continue;
          }
          const legacyFormat = vllm.getLegacyVllmQwenThinkingFormat(params);
          if (!legacyFormat) {
            continue;
          }
          vllm.applyLegacyVllmQwenThinkingFormat({
            sourcePath: `models.providers.vllm.models[${index}].params`,
            legacyParams: params,
            target: { model: modelRecord, index },
            legacyFormat,
            changes,
          });
          if (Object.keys(params).length === 0) {
            delete modelRecord.params;
          }
        }
      }

      const providerParams = getRecord(vllmProvider?.params);
      if (providerParams) {
        const providerLegacyFormat = vllm.getLegacyVllmQwenThinkingFormat(providerParams);
        if (providerLegacyFormat) {
          const providerModelIds = [
            ...vllm.collectVllmModelIdsFromSelection(agentsDefaults?.model),
            ...vllm.collectVllmModelIdsFromAgentModelMap(defaultModels),
            ...vllm.collectVllmModelIdsFromAgentList(getRecord(raw.agents)?.list),
          ];
          const targets = vllm.combineVllmModelTargets(
            vllm.listExistingVllmModelTargets(raw),
            vllm.createVllmModelTargets(raw, providerModelIds),
          );
          if (targets.length === 0) {
            vllm.removeUntargetedLegacyVllmQwenThinkingFormat({
              sourcePath: "models.providers.vllm.params",
              legacyParams: providerParams,
              legacyFormat: providerLegacyFormat,
              changes,
            });
          } else {
            for (const target of targets) {
              vllm.applyLegacyVllmQwenThinkingFormat({
                sourcePath: "models.providers.vllm.params",
                legacyParams: providerParams,
                target,
                legacyFormat: providerLegacyFormat,
                changes,
              });
            }
          }
          if (Object.keys(providerParams).length === 0) {
            delete vllmProvider?.params;
          }
        }
      }

      const defaultParams = getRecord(agentsDefaults?.params);
      if (defaultParams) {
        const defaultLegacyFormat = vllm.getLegacyVllmQwenThinkingFormat(defaultParams);
        if (defaultLegacyFormat) {
          const defaultModelIds = [
            ...vllm.collectVllmModelIdsFromSelection(agentsDefaults?.model),
            ...vllm.collectVllmModelIdsFromAgentModelMap(defaultModels),
          ];
          const targets =
            defaultModelIds.length > 0
              ? vllm.createVllmModelTargets(raw, defaultModelIds)
              : vllm.listExistingVllmModelTargets(raw);
          if (targets.length === 0) {
            vllm.removeUntargetedLegacyVllmQwenThinkingFormat({
              sourcePath: "agents.defaults.params",
              legacyParams: defaultParams,
              legacyFormat: defaultLegacyFormat,
              changes,
            });
          } else {
            for (const target of targets) {
              vllm.applyLegacyVllmQwenThinkingFormat({
                sourcePath: "agents.defaults.params",
                legacyParams: defaultParams,
                target,
                legacyFormat: defaultLegacyFormat,
                changes,
              });
            }
          }
          if (Object.keys(defaultParams).length === 0) {
            delete agentsDefaults?.params;
          }
        }
      }

      const agentList = getRecord(raw.agents)?.list;
      if (!Array.isArray(agentList)) {
        return;
      }
      for (const [index, agent] of agentList.entries()) {
        const agentRecord = getRecord(agent);
        const agentParams = getRecord(agentRecord?.params);
        const agentLegacyFormat = agentParams
          ? vllm.getLegacyVllmQwenThinkingFormat(agentParams)
          : undefined;
        if (!agentRecord || !agentParams || !agentLegacyFormat) {
          continue;
        }
        const explicitAgentModelIds = [
          ...vllm.collectVllmModelIdsFromSelection(agentRecord.model),
          ...vllm.collectVllmModelIdsFromAgentModelMap(agentRecord.models),
        ];
        const inheritedDefaultModelIds = [
          ...vllm.collectVllmModelIdsFromSelection(agentsDefaults?.model),
          ...vllm.collectVllmModelIdsFromAgentModelMap(defaultModels),
        ];
        const agentModelIds =
          explicitAgentModelIds.length > 0 ? explicitAgentModelIds : inheritedDefaultModelIds;
        const targets =
          agentModelIds.length > 0
            ? vllm.createVllmModelTargets(raw, agentModelIds)
            : vllm.listExistingVllmModelTargets(raw);
        if (targets.length === 0) {
          vllm.removeUntargetedLegacyVllmQwenThinkingFormat({
            sourcePath: `agents.list[${index}].params`,
            legacyParams: agentParams,
            legacyFormat: agentLegacyFormat,
            changes,
          });
        } else {
          for (const target of targets) {
            vllm.applyLegacyVllmQwenThinkingFormat({
              sourcePath: `agents.list[${index}].params`,
              legacyParams: agentParams,
              target,
              legacyFormat: agentLegacyFormat,
              changes,
            });
          }
        }
        if (Object.keys(agentParams).length === 0) {
          delete agentRecord.params;
        }
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "models.providers.*.models.*.compat.thinkingFormat-invalid",
    describe: "Remove unrecognized compat.thinkingFormat values from provider model entries",
    legacyRules: [vllm.INVALID_THINKING_FORMAT_RULE],
    apply: (raw, changes) => {
      const providers = getRecord(getRecord(raw.models)?.providers);
      if (!providers) {
        return;
      }

      for (const [providerId, provider] of Object.entries(providers)) {
        const models = getRecord(provider)?.models;
        if (!Array.isArray(models)) {
          continue;
        }

        for (const [index, model] of models.entries()) {
          const compat = getRecord(getRecord(model)?.compat);
          if (!compat) {
            continue;
          }
          const thinkingFormat = compat.thinkingFormat;
          if (typeof thinkingFormat !== "string" || isModelThinkingFormat(thinkingFormat)) {
            continue;
          }

          delete compat.thinkingFormat;
          changes.push(
            `Removed models.providers.${providerId}.models.${index}.compat.thinkingFormat (unrecognized value ${JSON.stringify(thinkingFormat)}; runtime default applies).`,
          );
        }
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "models.providers.*.models.*.contextWindow-stale",
    describe: "Repair stale contextWindow values to match catalog defaults",
    legacyRules: [vllm.STALE_CONTEXT_WINDOW_RULE],
    apply: (raw, changes) => {
      const providers = getRecord(getRecord(raw.models)?.providers);
      if (!providers) {
        return;
      }

      for (const [providerId, provider] of Object.entries(providers)) {
        const models = getRecord(provider)?.models;
        if (!Array.isArray(models)) {
          continue;
        }

        for (const [index, model] of models.entries()) {
          if (!getRecord(model)) {
            continue;
          }
          const modelId = typeof model.id === "string" ? model.id : undefined;
          if (!modelId) {
            continue;
          }
          const contextWindow = model.contextWindow;
          if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow)) {
            continue;
          }

          const fix = catalog.resolveStaleContextWindowFix({ providerId, modelId, contextWindow });
          if (!fix) {
            continue;
          }

          model.contextWindow = fix.correct;
          changes.push(
            `Repaired models.providers.${providerId}.models[${index}].${modelId}.contextWindow (${contextWindow} → ${fix.correct} to match catalog default).`,
          );
        }
      }
    },
  }),
];
