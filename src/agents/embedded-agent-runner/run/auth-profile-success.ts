import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { MODEL_APIS, type ModelApi } from "../../../config/types.models.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { redactIdentifier } from "../../../logging/redact-identifier.js";
import type { ProviderRouteOverridePresence } from "../../../plugin-sdk/provider-model-types.js";
import { resolveProviderModelRoutes } from "../../../plugins/provider-model-routes.js";
import { looksLikeSecretSentinel, resolveSecretSentinel } from "../../../secrets/sentinel.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { markAuthProfileSuccess } from "../../auth-profiles.js";
import { recordRuntimeAuthMaterialization } from "../../auth-profiles/runtime-materializations.js";
import {
  fingerprintAuthProfileOwnerShape,
  fingerprintAwsSdkRuntimeOwner,
  fingerprintOpaqueRuntimeOwner,
  fingerprintResolvedAuthProfileCredential,
  fingerprintResolvedProviderAuth,
  type AgentExecutionAuthBinding,
} from "../../execution-auth-binding.js";
import type { ResolvedProviderAuth } from "../../model-auth.js";
import { modelMatchesProviderModelRoute } from "../../provider-model-route.js";
import { log } from "../logger.js";
import type { EmbeddedRunTerminalState } from "./terminal-outcome.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const POST_RUN_AUTH_PROFILE_SUCCESS_SLOW_MS = 1_000;

export function markEmbeddedRunAuthProfileSuccess(input: {
  authProfileStateMode?: "read-write" | "read-only";
  profileId?: string;
  profileStore: AuthProfileStore;
  provider: string;
  agentDir?: string;
  runId: string;
  sessionId: string;
}): void {
  if (input.authProfileStateMode === "read-only" || !input.profileId) {
    return;
  }
  const successProfileId = input.profileId;
  const safeSuccessProfileId = redactIdentifier(successProfileId, { len: 12 });
  const successProvider = resolveAuthProfileStateProvider(
    input.profileStore,
    successProfileId,
    input.provider,
  );
  const successStarted = Date.now();
  void markAuthProfileSuccess({
    store: input.profileStore,
    provider: successProvider,
    profileId: successProfileId,
    agentDir: input.agentDir,
  })
    .then(() => {
      const durationMs = Date.now() - successStarted;
      if (durationMs >= POST_RUN_AUTH_PROFILE_SUCCESS_SLOW_MS) {
        log.warn(
          `post-run auth-profile success bookkeeping completed after ${durationMs}ms: ` +
            `runId=${input.runId} sessionId=${input.sessionId} ` +
            `provider=${sanitizeForLog(successProvider)} profileId=${safeSuccessProfileId}`,
        );
      } else if (log.isEnabled("trace")) {
        log.trace(
          `post-run auth-profile success bookkeeping completed: ` +
            `runId=${input.runId} sessionId=${input.sessionId} durationMs=${durationMs}`,
        );
      }
    })
    .catch((error: unknown) => {
      log.warn(
        `post-run auth-profile success bookkeeping failed: ` +
          `runId=${input.runId} sessionId=${input.sessionId} ` +
          `provider=${sanitizeForLog(successProvider)} profileId=${safeSuccessProfileId} ` +
          `error=${formatErrorMessage(error)}`,
      );
    });
}

export function reportEmbeddedRunSuccessfulAuthBinding(input: {
  profileId?: string;
  profileStore: AuthProfileStore;
  apiKeyInfo: ResolvedProviderAuth | null;
  attempt: EmbeddedRunAttemptResult;
  provider: string;
  agentDir?: string;
  modelId: string;
  modelApi: string;
  modelBaseUrl?: string;
  requestTransportOverrides?: ProviderRouteOverridePresence;
  config?: OpenClawConfig;
  agentHarnessId: string;
  pluginHarnessOwnsTransport: boolean;
  pluginHarnessOwnsAuthBootstrap: boolean;
  onSuccessfulAuthBinding?: (binding: AgentExecutionAuthBinding) => void;
}): void {
  const credential = input.profileId ? input.profileStore.profiles[input.profileId] : undefined;
  const pluginHarnessApiKeyInfo = resolvePluginHarnessApiKeyInfo({
    apiKeyInfo: input.apiKeyInfo,
    pluginHarnessOwnsTransport: input.pluginHarnessOwnsTransport,
  });
  const authFingerprint =
    credential?.type === "oauth" && input.profileId
      ? fingerprintResolvedAuthProfileCredential({
          profileId: input.profileId,
          credential,
          resolvedAuth: input.apiKeyInfo,
        })
      : credential && input.profileId && input.pluginHarnessOwnsAuthBootstrap
        ? input.attempt.authBindingFingerprint
        : credential && input.profileId && input.pluginHarnessOwnsTransport
          ? fingerprintResolvedAuthProfileCredential({
              profileId: input.profileId,
              credential,
              resolvedAuth: pluginHarnessApiKeyInfo,
            })
          : input.apiKeyInfo
            ? fingerprintResolvedProviderAuth(input.apiKeyInfo)
            : undefined;
  const authProfileOwnerFingerprint =
    input.profileId && credential !== undefined
      ? fingerprintAuthProfileOwnerShape({ profileId: input.profileId, credential })
      : undefined;
  const runtimeArtifact = input.pluginHarnessOwnsTransport
    ? input.attempt.runtimeArtifact
    : undefined;
  const runtimeOwnerFingerprint = authFingerprint
    ? undefined
    : input.apiKeyInfo?.mode === "aws-sdk"
      ? fingerprintAwsSdkRuntimeOwner({
          provider: input.provider,
          backendId: input.agentHarnessId,
          auth: input.apiKeyInfo,
        })
      : input.pluginHarnessOwnsTransport
        ? fingerprintOpaqueRuntimeOwner({
            kind: "plugin-harness",
            runner: "embedded",
            provider: input.provider,
            backendId: input.agentHarnessId,
            ...(runtimeArtifact ? { runtimeArtifactFingerprint: runtimeArtifact.fingerprint } : {}),
            ...(input.profileId ? { authProfileId: input.profileId } : {}),
            ...(authProfileOwnerFingerprint ? { authProfileOwnerFingerprint } : {}),
          })
        : undefined;
  const runtimeOwnerKind = runtimeOwnerFingerprint
    ? input.apiKeyInfo?.mode === "aws-sdk"
      ? ("aws-sdk" as const)
      : input.pluginHarnessOwnsTransport
        ? ("plugin-harness" as const)
        : undefined
    : input.pluginHarnessOwnsTransport
      ? ("plugin-harness" as const)
      : undefined;
  const materializedRoute = resolveHarnessAuthMaterialization(input, credential);
  if (materializedRoute) {
    recordRuntimeAuthMaterialization({
      agentDir: input.agentDir,
      provider: input.provider,
      modelId: input.modelId,
      modelApi: materializedRoute.api,
      modelBaseUrl: materializedRoute.baseUrl,
      requestTransportOverrides: materializedRoute.requestTransportOverrides,
      authMode: materializedRoute.authRequirement === "subscription" ? "oauth" : "api-key",
      runtimeOwnerId: input.agentHarnessId,
      ...(input.profileId ? { authProfileId: input.profileId } : {}),
    });
  }
  input.onSuccessfulAuthBinding?.({
    ...(input.profileId ? { authProfileId: input.profileId } : {}),
    agentHarnessId: input.agentHarnessId,
    modelId: input.modelId,
    modelApi: input.modelApi,
    ...(authFingerprint ? { authFingerprint } : {}),
    ...(runtimeOwnerFingerprint ? { runtimeOwnerFingerprint } : {}),
    ...(runtimeOwnerKind ? { runtimeOwnerKind } : {}),
    ...(runtimeOwnerKind ? { runtimeOwnerId: input.agentHarnessId } : {}),
    ...(runtimeArtifact
      ? {
          runtimeArtifactId: runtimeArtifact.id,
          runtimeArtifactFingerprint: runtimeArtifact.fingerprint,
        }
      : {}),
  });
}

type EmbeddedRunAuthSuccessInput = Parameters<typeof markEmbeddedRunAuthProfileSuccess>[0] &
  Omit<Parameters<typeof reportEmbeddedRunSuccessfulAuthBinding>[0], "profileStore"> & {
    terminalReason: EmbeddedRunTerminalState["outcome"]["reason"];
    bindingProfileStore: AuthProfileStore;
    onSuccessfulAuthProfile?: (profileId: string | undefined) => void;
  };

export function reportEmbeddedRunAuthSuccess(input: EmbeddedRunAuthSuccessInput): void {
  if (input.terminalReason !== "completed") {
    return;
  }
  markEmbeddedRunAuthProfileSuccess(input);
  reportEmbeddedRunSuccessfulAuthBinding({ ...input, profileStore: input.bindingProfileStore });
  input.onSuccessfulAuthProfile?.(input.profileId);
}

function resolveHarnessAuthMaterialization(
  input: Parameters<typeof reportEmbeddedRunSuccessfulAuthBinding>[0],
  credential: AuthProfileStore["profiles"][string] | undefined,
) {
  const preparedApiKeyProfileId = input.apiKeyInfo?.profileId;
  // Prepared API-key routes are host-resolved before a harness turn. Only the
  // exact SecretRef profile may turn that completed request into a catalog fact.
  const resolvedReferencedApiKey =
    credential?.type === "api_key" &&
    credential.keyRef !== undefined &&
    input.apiKeyInfo?.mode === "api-key" &&
    preparedApiKeyProfileId !== undefined &&
    preparedApiKeyProfileId === input.profileId &&
    input.apiKeyInfo.source === `profile:${preparedApiKeyProfileId}`;
  if (
    !input.pluginHarnessOwnsAuthBootstrap ||
    (input.apiKeyInfo && !resolvedReferencedApiKey) ||
    (hasInlineCredentialMaterial(credential) && !resolvedReferencedApiKey) ||
    !isModelApi(input.modelApi)
  ) {
    return undefined;
  }
  const resolution = resolveProviderModelRoutes({
    provider: input.provider,
    modelId: input.modelId,
    api: input.modelApi,
    baseUrl: input.modelBaseUrl,
    config: input.config,
    executedRequestTransportOverrides: input.requestTransportOverrides ?? "none",
  });
  if (resolution?.kind !== "routes") {
    return undefined;
  }
  const routes = resolution.routes.filter(
    (route) =>
      route.api === input.modelApi &&
      route.requestTransportOverrides === (input.requestTransportOverrides ?? "none") &&
      (!input.modelBaseUrl ||
        modelMatchesProviderModelRoute({
          provider: input.provider,
          api: input.modelApi,
          baseUrl: input.modelBaseUrl,
          route,
        })),
  );
  return routes.length === 1 ? routes[0] : undefined;
}

function isModelApi(value: string): value is ModelApi {
  return (MODEL_APIS as readonly string[]).includes(value);
}

function hasInlineCredentialMaterial(
  credential: AuthProfileStore["profiles"][string] | undefined,
): boolean {
  if (!credential) {
    return false;
  }
  if (credential.type === "api_key") {
    return Boolean(credential.key?.trim());
  }
  if (credential.type === "token") {
    return Boolean(credential.token?.trim());
  }
  return Boolean(credential.access?.trim() && credential.refresh?.trim());
}

function resolvePluginHarnessApiKeyInfo(input: {
  apiKeyInfo: ResolvedProviderAuth | null;
  pluginHarnessOwnsTransport: boolean;
}): ResolvedProviderAuth | null {
  const apiKeyInfo = input.apiKeyInfo;
  const apiKey = apiKeyInfo?.apiKey;
  if (
    !input.pluginHarnessOwnsTransport ||
    !apiKeyInfo ||
    !apiKey ||
    !looksLikeSecretSentinel(apiKey)
  ) {
    return apiKeyInfo;
  }
  const resolvedApiKey = resolveSecretSentinel(apiKey);
  return resolvedApiKey ? { ...apiKeyInfo, apiKey: resolvedApiKey } : null;
}

function resolveAuthProfileStateProvider(
  store: AuthProfileStore,
  profileId: string,
  fallbackProvider: string,
): string {
  const profileProvider = store.profiles?.[profileId]?.provider?.trim();
  if (profileProvider) {
    return profileProvider;
  }
  return profileId.split(":", 1)[0]?.trim() || fallbackProvider;
}
