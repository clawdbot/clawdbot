/**
 * Provider/backend/credential eligibility for CLI-backend dispatch of
 * embedded runs. Shared by the dispatch itself and by callers that must
 * budget for CLI latency before starting the run (active-memory recall's
 * timeout default); both sides seeing one decision keeps timeouts and
 * routing from drifting apart. Kept separate from the dispatch module so
 * the plugin runtime surface does not eagerly load the run machinery.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../../plugins/cli-backends.runtime.js";
import {
  ensureAuthProfileStore,
  resolveAuthProfileOrder,
  resolveModelAuthMode,
} from "../model-auth.js";
import { resolveCliRuntimeExecutionProvider } from "../model-runtime-aliases.js";

type EmbeddedCliBackendDispatchEligibilityParams = {
  provider?: string;
  model?: string;
  agentId?: string;
  /** Explicitly pinned auth profile for the run; decisive when it resolves. */
  authProfileId?: string;
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
};

/**
 * Decides whether an opted-in embedded run would execute through the CLI
 * backend. Resolution stays on stored credential metadata — no credential
 * materialization, refresh locks, or network calls on this per-turn path.
 */
export function resolveEmbeddedCliBackendDispatchEligibility(
  params: EmbeddedCliBackendDispatchEligibilityParams,
): { provider: string } | undefined {
  // Canonical refs (anthropic/<model> routed to claude-cli via agentRuntime
  // config) must dispatch the same as runs that arrive with the CLI runtime
  // provider id directly, so resolve the configured execution runtime before
  // gating.
  const backends = new Map(
    resolveRuntimeCliBackends().map((backend) => [normalizeProviderId(backend.id), backend]),
  );
  const requestedProvider = normalizeProviderId(params.provider ?? "");
  const provider = backends.has(requestedProvider)
    ? requestedProvider
    : normalizeProviderId(
        resolveCliRuntimeExecutionProvider({
          provider: params.provider ?? "",
          cfg: params.config,
          agentId: params.agentId,
          modelId: params.model,
          // A pinned profile can be what maps a canonical ref onto its CLI
          // runtime (e.g. multiple compatible profiles, no configured
          // agentRuntime); omitting it here would strand the run on the
          // passthrough before the credential-type check ever sees the pin.
          authProfileId: params.authProfileId,
        }) ?? "",
      );
  // The backend plugin owns the claim that its provider's direct-API
  // passthrough cannot run on subscription credentials. Providers whose
  // registered backend does not declare it — and config-only backends with
  // no plugin descriptor — keep the passthrough unchanged.
  if (!backends.get(provider)?.subscriptionAuthDispatch) {
    return undefined;
  }
  const authMode = resolveAuthModeSafe(params, provider);
  // An API key (also mixed/aws-sdk stores that include one) keeps the faster
  // direct passthrough working; only subscription (oauth/token) or
  // unresolvable credentials route through the CLI backend.
  if (authMode === "api-key" || authMode === "mixed" || authMode === "aws-sdk") {
    return undefined;
  }
  return { provider };
}

function resolveAuthModeSafe(
  params: {
    authProfileId?: string;
    config?: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
  },
  provider: string,
): ReturnType<typeof resolveModelAuthMode> {
  try {
    const store = ensureAuthProfileStore(params.agentDir, { config: params.config });
    // A run pinned to an explicit profile executes on that credential, so its
    // type decides regardless of the general order; an unresolvable pinned id
    // falls back to ordered selection like the passthrough does.
    const pinnedType = params.authProfileId
      ? store.profiles[params.authProfileId.trim()]?.type
      : undefined;
    // Mixed stores must follow the same ordered selection the passthrough
    // uses: the first ordered profile decides the mode. A store-wide
    // aggregate would read oauth+api_key as "mixed" and keep the passthrough
    // even when auth.order selects the subscription profile first.
    const [selectedProfileId] = resolveAuthProfileOrder({
      cfg: params.config,
      store,
      provider,
    });
    const selectedType =
      pinnedType ?? (selectedProfileId ? store.profiles[selectedProfileId]?.type : undefined);
    if (selectedType === "api_key") {
      return "api-key";
    }
    if (selectedType === "oauth" || selectedType === "token") {
      return selectedType;
    }
    return resolveModelAuthMode(provider, params.config, store, {
      workspaceDir: params.workspaceDir,
    });
  } catch {
    // Unreadable credential stores behave like missing credentials: the
    // passthrough cannot work either, so the CLI backend is still the
    // best-effort path.
    return undefined;
  }
}
