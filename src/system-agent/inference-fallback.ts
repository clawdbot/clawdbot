// Provider-neutral live inference ladder for delegated OpenClaw sessions.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { hasAvailableAuthForProvider } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  resolveSystemAgentConfiguredRouteFromConfig,
  type SystemAgentConfiguredRoute,
} from "./inference-route.js";
import { verifySetupInference, type BoundVerifySetupInferenceResult } from "./setup-inference.js";

const RETRYABLE_INFERENCE_STATUSES = new Set([
  "auth",
  "rate_limit",
  "billing",
  "timeout",
  "unavailable",
]);

// auth/billing/rate_limit failures commonly apply to one key/account/project,
// so another credential owner of the same provider may still work. Everything
// else retryable (timeout, unavailable) is provider-wide, so its whole provider
// is skipped for the rest of the ladder.
const CREDENTIAL_SCOPED_FAILURE_STATUSES = new Set(["auth", "billing", "rate_limit"]);

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

/** Requester first. Other configured, authenticated providers: provider-id order. */
export async function verifySystemAgentInferenceWithFallback(params: {
  requestingAgentId?: string;
  runtime: RuntimeEnv;
  deps?: InferenceFallbackDeps;
}): Promise<BoundVerifySetupInferenceResult> {
  const deps = params.deps ?? {};
  const config = await (deps.readConfig ?? readCurrentConfig)();
  const requestedAgentId = normalizeAgentId(
    params.requestingAgentId ?? resolveDefaultAgentId(config),
  );
  const candidateAgentIds = [
    requestedAgentId,
    ...(config.agents?.list ?? []).map((agent) => normalizeAgentId(agent.id)),
    normalizeAgentId(resolveDefaultAgentId(config)),
  ];
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
  const ordered = [
    ...(first ? [first] : []),
    ...routes
      .filter((candidate) => candidate !== first)
      .toSorted(
        (left, right) =>
          left.provider.localeCompare(right.provider) || left.agentId.localeCompare(right.agentId),
      ),
  ];
  const hasAuth = deps.hasAuth ?? hasAvailableAuthForProvider;
  const verify = deps.verify ?? verifySetupInference;
  let lastFailure: BoundVerifySetupInferenceResult | undefined;
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
    ]);
    if (attemptedOwners.has(ownerKey)) {
      continue;
    }
    if (
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
    const result = await verify({
      runtime: params.runtime,
      bindSession: true,
      agentId: candidate.agentId,
    });
    if (result.ok) {
      return result;
    }
    lastFailure = result;
    // Bad/empty answers and owner-integrity failures are not availability failover.
    if (!RETRYABLE_INFERENCE_STATUSES.has(result.status)) {
      return result;
    }
    // A provider-wide failure applies to all of its routes; a credential-scoped
    // one may not, so only the former retires the whole provider.
    if (!CREDENTIAL_SCOPED_FAILURE_STATUSES.has(result.status)) {
      failedProviders.add(candidate.provider);
    }
  }
  return (
    lastFailure ?? {
      ok: false,
      status: "unavailable",
      error: "No configured authenticated inference provider is available.",
    }
  );
}
