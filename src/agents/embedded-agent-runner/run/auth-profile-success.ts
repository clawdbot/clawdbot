import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { redactIdentifier } from "../../../logging/redact-identifier.js";
import { looksLikeSecretSentinel, resolveSecretSentinel } from "../../../secrets/sentinel.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { markAuthProfileSuccess } from "../../auth-profiles.js";
import {
  fingerprintAuthProfileOwnerShape,
  fingerprintAwsSdkRuntimeOwner,
  fingerprintOpaqueRuntimeOwner,
  fingerprintResolvedAuthProfileCredential,
  fingerprintResolvedProviderAuth,
  type AgentExecutionAuthBinding,
} from "../../execution-auth-binding.js";
import type { ResolvedProviderAuth } from "../../model-auth.js";
import { log } from "../logger.js";
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
  input.onSuccessfulAuthBinding?.({
    ...(input.profileId ? { authProfileId: input.profileId } : {}),
    agentHarnessId: input.agentHarnessId,
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
