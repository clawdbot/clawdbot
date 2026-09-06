// Provider-neutral live inference ladder for OpenClaw sessions.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { listAgentIds } from "../agents/agent-scope.js";
import { hasAvailableAuthForProvider } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  resolveSystemAgentConfiguredRouteFromConfig,
  type SystemAgentConfiguredRoute,
} from "./inference-route.js";
import {
  verifySetupInference,
  type BoundVerifySetupInferenceResult,
  type VerifySetupInferenceResult,
} from "./setup-inference.js";

const RETRYABLE_INFERENCE_STATUSES = new Set([
  "auth",
  "rate_limit",
  "billing",
  "timeout",
  "format",
  "unavailable",
]);

// Only failures that establish provider-wide unavailability retire every route.
// Credential failures may clear with another owner, while format failures can be
// model-specific, so both stay scoped to the attempted route.
const PROVIDER_WIDE_FAILURE_STATUSES = new Set(["timeout", "unavailable"]);

type InferenceFallbackDeps = {
  readConfig?: () => Promise<OpenClawConfig>;
  resolveRoute?: (
    config: OpenClawConfig,
    agentId: string,
  ) => Promise<SystemAgentConfiguredRoute | null>;
  hasAuth?: typeof hasAvailableAuthForProvider;
  verify?: (params: {
    runtime: RuntimeEnv;
    bindSession: true;
    agentId: string;
  }) => Promise<BoundVerifySetupInferenceResult>;
};

async function readCurrentConfig(): Promise<OpenClawConfig> {
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.exists || !snapshot.valid) {
    return {};
  }
  return snapshot.runtimeConfig ?? snapshot.config;
}

type InferenceFallbackParams = {
  requestingAgentId?: string;
  runtime: RuntimeEnv;
  deps?: InferenceFallbackDeps;
};

type ConfiguredRoutePolicy = {
  expand: (route: SystemAgentConfiguredRoute) => Promise<SystemAgentConfiguredRoute[]>;
  accept: (route: SystemAgentConfiguredRoute) => Promise<boolean>;
  verify: (route: SystemAgentConfiguredRoute) => Promise<VerifySetupInferenceResult>;
};

type ConfiguredRouteResult =
  | { ok: true; route: SystemAgentConfiguredRoute }
  | Extract<VerifySetupInferenceResult, { ok: false }>;

export function verifySystemAgentInferenceWithFallback(
  params: InferenceFallbackParams & { routePolicy: ConfiguredRoutePolicy },
): Promise<ConfiguredRouteResult>;
export function verifySystemAgentInferenceWithFallback(
  params: InferenceFallbackParams,
): Promise<BoundVerifySetupInferenceResult>;

/** Requester first. Other configured, authenticated providers: provider-id order. */
export async function verifySystemAgentInferenceWithFallback(
  params: InferenceFallbackParams & { routePolicy?: ConfiguredRoutePolicy },
): Promise<BoundVerifySetupInferenceResult | ConfiguredRouteResult> {
  const deps = params.deps ?? {};
  const routePolicy = params.routePolicy;
  const config = await (deps.readConfig ?? readCurrentConfig)();
  const requestedAgentId = resolveAmbientOwnerAgentId(config, params.requestingAgentId);
  const candidateAgentIds = new Set([
    requestedAgentId,
    ...listAgentIds(config).map((agentId) => normalizeAgentId(agentId)),
  ]);
  const resolveRoute = deps.resolveRoute ?? resolveSystemAgentConfiguredRouteFromConfig;
  const routes: Array<{ agentId: string; provider: string; route: SystemAgentConfiguredRoute }> =
    [];
  for (const agentId of candidateAgentIds) {
    const route = await resolveRoute(config, agentId);
    if (!route) {
      continue;
    }
    const provider = normalizeProviderId(route.provider);
    if (!provider) {
      continue;
    }
    routes.push({ agentId, provider, route });
  }
  const first = routes.find((candidate) => candidate.agentId === requestedAgentId);
  const orderedOwners = [
    ...(first ? [first] : []),
    ...routes
      .filter((candidate) => candidate !== first)
      .toSorted(
        (left, right) =>
          left.provider.localeCompare(right.provider) || left.agentId.localeCompare(right.agentId),
      ),
  ];
  const ordered = routePolicy
    ? (
        await Promise.all(
          orderedOwners.map(async ({ route }) =>
            (await routePolicy.expand(route)).map((expanded) => ({
              agentId: expanded.agentId,
              provider: normalizeProviderId(expanded.provider),
              route: expanded,
            })),
          ),
        )
      ).flat()
    : orderedOwners;
  const hasAuth = deps.hasAuth ?? hasAvailableAuthForProvider;
  const verify = deps.verify ?? verifySetupInference;
  let lastFailure: Extract<VerifySetupInferenceResult, { ok: false }> | undefined;
  const failedProviders = new Set<string>();
  const attemptedOwners = new Set<string>();
  for (const candidate of ordered) {
    if (failedProviders.has(candidate.provider)) {
      continue;
    }
    // Dedup by credential owner (provider + auth profile + agent dir), not just
    // provider, so distinct credential owners of one provider are each tried.
    // JSON-encode the tuple so unrestricted field values cannot collide.
    const ownerKey = JSON.stringify([
      candidate.provider,
      candidate.route.authProfileId ?? null,
      candidate.route.agentDir ?? null,
      ...(routePolicy ? [candidate.route.model] : []),
    ]);
    if (attemptedOwners.has(ownerKey)) {
      continue;
    }
    if (routePolicy && !(await routePolicy.accept(candidate.route))) {
      continue;
    }
    if (
      !routePolicy &&
      candidate !== first &&
      !(await hasAuth({
        provider: candidate.provider,
        cfg: config,
        preferredProfile: candidate.route.authProfileId,
        agentDir: candidate.route.agentDir,
        modelId: candidate.route.model,
      }))
    ) {
      continue;
    }
    attemptedOwners.add(ownerKey);
    if (routePolicy) {
      const result = await routePolicy.verify(candidate.route);
      if (result.ok) {
        return { ok: true, route: candidate.route };
      }
      lastFailure = result;
    } else {
      const result = await verify({
        runtime: params.runtime,
        bindSession: true,
        agentId: candidate.agentId,
      });
      if (result.ok) {
        return result;
      }
      lastFailure = result;
    }
    // Identity or owner-integrity uncertainty stays fail-closed as unknown.
    if (!RETRYABLE_INFERENCE_STATUSES.has(lastFailure.status)) {
      return lastFailure;
    }
    // Expanded model probes do not establish that sibling models are unavailable.
    if (!routePolicy && PROVIDER_WIDE_FAILURE_STATUSES.has(lastFailure.status)) {
      failedProviders.add(candidate.provider);
    }
  }
  return (
    lastFailure ?? {
      ok: false,
      status: "unknown",
      error: "OpenClaw could not verify a usable inference route. Check model setup and try again.",
    }
  );
}
