import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listAgentEntries,
  resolveAmbientOwnerAgentId,
  toAgentEntriesRecord,
} from "../agents/agent-scope-config.js";
import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles/store-runtime.js";
import { createModelAuthAvailabilityResolver } from "../agents/model-auth-availability.js";
import { findModelInCatalog } from "../agents/model-catalog-lookup.js";
import { loadManifestModelCatalog } from "../agents/model-catalog.js";
import { resolveModelCandidateChain } from "../agents/model-fallback-candidates.js";
import { supportsModelTools } from "../agents/model-tool-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { verifySystemAgentInferenceWithFallback } from "../system-agent/inference-fallback.js";
import {
  resolveSystemAgentConfiguredRouteFromConfig,
  type SystemAgentConfiguredRoute,
} from "../system-agent/inference-route.js";
import { cleanupSetupInferenceTempDir } from "../system-agent/setup-inference-persist.js";
import { runSetupInferenceTest } from "../system-agent/setup-inference-test.js";

export type UpdateRepairInferenceResult =
  | {
      ok: true;
      route: Extract<SystemAgentConfiguredRoute, { runner: "embedded" }>;
      modelFallbacks: string[];
    }
  | { ok: false; reason: string };

export async function selectUpdateRepairInference(params: {
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<UpdateRepairInferenceResult> {
  const controller = new AbortController();
  const signal = AbortSignal.any([params.signal, controller.signal]);
  const deadline = Date.now() + params.timeoutMs;
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  const chains = new Map<string, SystemAgentConfiguredRoute[]>();
  const eligibility = new Map<SystemAgentConfiguredRoute, boolean>();
  let tempDir: string | undefined;
  try {
    signal.throwIfAborted();
    const owner = resolveAmbientOwnerAgentId(params.config);
    const configuredEntries = listAgentEntries(params.config);
    const catalog = loadManifestModelCatalog({ config: params.config });
    const accept = async (route: SystemAgentConfiguredRoute): Promise<boolean> => {
      signal.throwIfAborted();
      const cached = eligibility.get(route);
      if (cached !== undefined) {
        return cached;
      }
      const model = findModelInCatalog(catalog, route.provider, route.model);
      const configuredModel = params.config.models?.providers?.[route.provider]?.models.find(
        (entry) => entry.id === route.model,
      );
      if (
        route.runner !== "embedded" ||
        !supportsModelTools(model ?? {}) ||
        !supportsModelTools(configuredModel ?? {})
      ) {
        eligibility.set(route, false);
        return false;
      }
      const authStore = loadAuthProfileStoreForRuntime(route.agentDir, {
        profileId: route.authProfileId,
        readOnly: true,
        allowKeychainPrompt: false,
        config: route.runConfig,
        externalCli: { mode: "none" },
      });
      const accepted =
        createModelAuthAvailabilityResolver({
          cfg: route.runConfig,
          authStore,
          agentDir: route.agentDir,
          externalCliProviderIds: [],
          allowPreparedRuntimeAuth: false,
        }).evaluateModelAuth(route.provider, {
          modelId: route.model,
          api: configuredModel?.api ?? model?.api,
          baseUrl: params.config.models?.providers?.[route.provider]?.baseUrl ?? model?.baseUrl,
          pinnedProfileId: route.authProfileId,
        }).availability === true;
      signal.throwIfAborted();
      eligibility.set(route, accepted);
      return accepted;
    };
    const selected = await verifySystemAgentInferenceWithFallback({
      requestingAgentId: owner,
      runtime: params.runtime,
      deps: { readConfig: async () => params.config },
      routePolicy: {
        expand: async (base) => {
          // Execution aliases identify the runner, not the configured model provider.
          const primaryProvider = base.modelLabel.slice(0, base.modelLabel.indexOf("/"));
          const candidates = resolveModelCandidateChain({
            cfg: params.config,
            agentId: base.agentId,
            provider: primaryProvider,
            model: base.model,
            requestedRouteResolution: "resolved",
          });
          const routes: SystemAgentConfiguredRoute[] = [];
          for (const candidate of candidates) {
            signal.throwIfAborted();
            const primaryProfile =
              candidate.provider === primaryProvider && candidate.model === base.model
                ? base.authProfileId
                : undefined;
            const modelKey = `${candidate.provider}/${candidate.model}`;
            const modelRef = `${modelKey}${primaryProfile ? `@${primaryProfile}` : ""}`;
            const entries = (
              configuredEntries.length ? configuredEntries : [{ id: base.agentId }]
            ).map((entry) =>
              normalizeAgentId(entry.id) === base.agentId
                ? Object.assign({}, entry, {
                    model: { primary: modelRef, fallbacks: [] },
                    models: {
                      ...entry.models,
                      [modelKey]: {
                        ...entry.models?.[modelKey],
                        agentRuntime: { id: "openclaw" },
                      },
                    },
                  })
                : entry,
            );
            const runConfig: OpenClawConfig = {
              ...params.config,
              agents: {
                ...params.config.agents,
                defaults: {
                  ...params.config.agents?.defaults,
                  model: { primary: modelRef, fallbacks: [] },
                },
                entries: toAgentEntriesRecord(entries),
              },
            };
            const route = await resolveSystemAgentConfiguredRouteFromConfig(
              runConfig,
              base.agentId,
            );
            if (route) {
              routes.push(route);
            }
          }
          chains.set(base.agentId, routes);
          return routes;
        },
        accept,
        verify: async (route) => {
          signal.throwIfAborted();
          tempDir ??= await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-repair-probe-"));
          signal.throwIfAborted();
          const result = await runSetupInferenceTest({
            plan: {
              ...route,
              config: route.runConfig,
              routeAgentId: route.agentId,
              modelRef: route.modelLabel,
              // Repair tools belong to the local host, never an external coding CLI.
              agentHarnessRuntimeOverride: "openclaw",
            },
            tempDir,
            deps: { timeoutMs: Math.max(1, deadline - Date.now()) },
            authProfileStateMode: "read-only",
            requireExecutionOwner: false,
            signal,
          });
          signal.throwIfAborted();
          return result.ok
            ? { ok: true, modelRef: route.modelLabel, latencyMs: result.latencyMs }
            : result;
        },
      },
    });
    if (!selected.ok || selected.route.runner !== "embedded") {
      return {
        ok: false,
        reason: selected.ok
          ? "No local, tool-capable inference route is available."
          : selected.error,
      };
    }
    const chain = chains.get(selected.route.agentId) ?? [];
    const modelFallbacks: string[] = [];
    for (const route of chain.slice(chain.indexOf(selected.route) + 1)) {
      if (await accept(route)) {
        modelFallbacks.push(route.modelLabel);
      }
    }
    return { ok: true, route: selected.route, modelFallbacks };
  } catch {
    return {
      ok: false,
      reason: signal.aborted
        ? "Inference selection was aborted or exhausted the repair wall-clock budget."
        : "No usable, authenticated, tool-capable inference route could be verified. Check model setup.",
    };
  } finally {
    clearTimeout(timeout);
    // Await the probe before deleting its state: cancellation must drain the embedded run.
    if (tempDir) {
      await cleanupSetupInferenceTempDir({ tempDir, deps: {}, runtime: params.runtime });
    }
  }
}
