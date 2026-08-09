// Post-selection model/auth sanity checks shown during onboarding and agent setup.
import { normalizeProviderIdForAuth } from "@openclaw/model-catalog-core/provider-id";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { createModelAuthAvailabilityResolver } from "../agents/model-auth-availability.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { publishPreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.js";
import { buildProviderAuthRecoveryHint } from "../agents/provider-auth-recovery-hint.js";
import { canonicalizeProviderModelId } from "../agents/provider-model-route.js";
import type { ModelApi } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderModelRouteAuthRequirement } from "../plugin-sdk/provider-model-types.js";
import type { WizardPrompter } from "../wizard/prompts.js";

type ModelRouteObservation = {
  api?: ModelApi | null;
  baseUrl?: unknown;
};

type DefaultModelAuthStatus = {
  provider: string;
  model: string;
} & (
  | { status: "ready"; hasAuth: true }
  | {
      status: "missing";
      hasAuth: false;
      authRequirement?: ProviderModelRouteAuthRequirement;
    }
  | { status: "indeterminate"; hasAuth: false }
  | { status: "incompatible"; hasAuth: false; code: string; message: string }
);

/**
 * Resolve the default model ref and its auth readiness. A catalog observation
 * makes transport-specific auth exact; absent observations remain
 * indeterminate when provider facts cannot choose one route. Shared by the
 * onboarding model check and the finalize hatch gating.
 */
export function resolveDefaultModelAuthStatus(
  config: OpenClawConfig,
  options?: {
    agentId?: string;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
    observedRoutes?: readonly ModelRouteObservation[];
  },
): DefaultModelAuthStatus {
  const ref = resolveDefaultModelForAgent({
    cfg: config,
    agentId: options?.agentId,
  });
  const store = ensureAuthProfileStore(options?.agentDir, {
    allowKeychainPrompt: false,
    config,
    ...(ref.provider === "openai" ? { externalCliProviderIds: ["openai"] } : {}),
    readOnly: true,
  });
  const evaluation = createModelAuthAvailabilityResolver({
    cfg: config,
    authStore: store,
    ...(options?.agentDir ? { agentDir: options.agentDir } : {}),
    ...(options?.env ? { env: options.env } : {}),
  }).evaluateModelAuth(ref.provider, {
    modelId: ref.model,
    ...(options?.observedRoutes?.length ? { observedRoutes: options.observedRoutes } : {}),
  });
  if (evaluation.routeResolution?.kind === "incompatible") {
    return {
      provider: ref.provider,
      model: ref.model,
      status: "incompatible",
      hasAuth: false,
      code: evaluation.routeResolution.code,
      message: evaluation.routeResolution.message,
    };
  }
  const availability = evaluation.availability;
  const authRequirement = evaluation.selectedRoute?.authRequirement;
  if (availability === true) {
    return { provider: ref.provider, model: ref.model, status: "ready", hasAuth: true };
  }
  if (
    availability === undefined &&
    (normalizeProviderIdForAuth(ref.provider) === "openai" ||
      evaluation.routeResolution !== null ||
      evaluation.evidence !== undefined)
  ) {
    return { provider: ref.provider, model: ref.model, status: "indeterminate", hasAuth: false };
  }
  return {
    provider: ref.provider,
    model: ref.model,
    status: "missing",
    hasAuth: false,
    ...(authRequirement ? { authRequirement } : {}),
  };
}

function catalogRouteObservation(
  entry: ModelCatalogEntry | undefined,
): ModelRouteObservation | undefined {
  if (!entry) {
    return undefined;
  }
  const baseUrl = entry.baseUrl;
  if (entry.api === undefined && baseUrl === undefined) {
    return undefined;
  }
  return {
    ...(entry.api !== undefined ? { api: entry.api } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

type DefaultModelCatalogFacts = {
  found: boolean;
  observedRoutes?: readonly ModelRouteObservation[];
};

/** Resolve logical model identity and every physical route represented by a catalog. */
export function resolveDefaultModelCatalogFacts(
  config: OpenClawConfig,
  catalog: readonly ModelCatalogEntry[],
  options?: { agentId?: string; routeVariants?: readonly ModelCatalogEntry[] },
): DefaultModelCatalogFacts {
  const ref = resolveDefaultModelForAgent({ cfg: config, agentId: options?.agentId });
  const provider = normalizeProviderIdForAuth(ref.provider);
  const modelId = canonicalizeProviderModelId(provider, ref.model);
  const matches = (entry: ModelCatalogEntry) =>
    normalizeProviderIdForAuth(entry.provider) === provider &&
    canonicalizeProviderModelId(provider, entry.id) === modelId;
  const routeVariants = options?.routeVariants ?? catalog;
  const observedRoutes = routeVariants
    .filter(matches)
    .map(catalogRouteObservation)
    .filter((route): route is ModelRouteObservation => route !== undefined);
  return {
    found: catalog.some(matches) || routeVariants.some(matches),
    ...(observedRoutes.length > 0 ? { observedRoutes } : {}),
  };
}

/** Warn when the selected default model is unknown or has no usable credentials. */
export async function warnIfModelConfigLooksOff(
  config: OpenClawConfig,
  prompter: WizardPrompter,
  options?: {
    agentId?: string;
    agentDir?: string;
    validateCatalog?: boolean;
    env?: NodeJS.ProcessEnv;
    observedRoutes?: readonly ModelRouteObservation[];
  },
) {
  const ref = resolveDefaultModelForAgent({
    cfg: config,
    agentId: options?.agentId,
  });
  const warnings: string[] = [];
  const validationAgentId = options?.agentId ?? resolveDefaultAgentId(config);
  const snapshot =
    options?.validateCatalog === false
      ? { entries: [], routeVariants: [] }
      : (
          await publishPreparedModelRuntimeSnapshot(
            {
              config,
              agentId: validationAgentId,
              agentDir:
                options?.agentDir ??
                (options?.agentId
                  ? resolveAgentDir(config, options.agentId)
                  : resolveDefaultAgentDir(config)),
              inheritedAuthDir: resolveDefaultAgentDir(config),
              workspaceDir: resolveAgentWorkspaceDir(config, validationAgentId),
            },
            { force: true, provenance: "explicit" },
          )
        ).modelCatalog;
  const catalog = snapshot.entries;
  const catalogFacts = resolveDefaultModelCatalogFacts(config, catalog, {
    ...(options?.agentId ? { agentId: options.agentId } : {}),
    routeVariants: snapshot.routeVariants,
  });
  const observedRoutes = options?.observedRoutes ?? catalogFacts.observedRoutes;
  if (options?.validateCatalog !== false) {
    if (catalog.length > 0) {
      if (!catalogFacts.found) {
        warnings.push(
          `Model not found: ${ref.provider}/${ref.model}. Update agents.defaults.model or run /models list.`,
        );
      }
    }
  }

  const authStatus = resolveDefaultModelAuthStatus(config, {
    ...(options?.agentId ? { agentId: options.agentId } : {}),
    ...(options?.agentDir ? { agentDir: options.agentDir } : {}),
    ...(options?.env ? { env: options.env } : {}),
    ...(observedRoutes ? { observedRoutes } : {}),
  });
  if (authStatus.status === "missing") {
    warnings.push(
      `No auth configured for provider "${ref.provider}". The agent may fail until credentials are added. ${buildProviderAuthRecoveryHint(
        {
          provider: ref.provider,
          config,
          includeEnvVar: authStatus.authRequirement !== "subscription",
        },
      )}`,
    );
  } else if (authStatus.status === "incompatible") {
    warnings.push(
      `Model route is incompatible for "${ref.provider}/${ref.model}": ${authStatus.message}`,
    );
  } else if (authStatus.status === "indeterminate") {
    warnings.push(
      `Auth readiness could not be confirmed for "${ref.provider}/${ref.model}". Verify the selected model route and credential source before continuing.`,
    );
  }

  if (warnings.length > 0) {
    await prompter.note(warnings.join("\n"), "Model check");
  }
}
