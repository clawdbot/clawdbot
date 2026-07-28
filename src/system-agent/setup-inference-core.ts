import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import {
  loadAuthProfileStoreForRuntime,
  updateAuthProfileStoreWithLock,
} from "../agents/auth-profiles/store.js";
import { readCodexCliActiveApiKey } from "../agents/cli-credentials.js";
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import {
  detectInferenceBackends,
  type InferenceBackendKind,
} from "../commands/onboard-inference.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import {
  type ProviderAuthChoiceMetadata,
  resolveManifestProviderAuthChoice,
  resolveManifestProviderAuthChoices,
} from "../plugins/provider-auth-choices.js";
import { resolvePluginProviders } from "../plugins/providers.runtime.js";
import type { SetupRecommendedInstall } from "../plugins/recommended-tool-installs.js";
import type { ProviderAuthResult } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { loadAuthoredSetupConfig } from "./onboarding-welcome.js";
import { probeLocalCommand } from "./probes.js";
import type {
  SetupInferenceAuthOption,
  SetupInferenceManualProvider,
} from "./setup-inference-auth-options.js";
import { resolveSetupInferenceCandidateBrandId } from "./setup-inference-brand.js";
import {
  captureSystemAgentOwnerPluginArtifacts,
  type createSystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

export const log = createSubsystemLogger("system-agent/setup-inference");

/**
 * Inference is the one required onboarding step (docs/cli/setup.md
 * "Setup bootstrap"). This module gives structured clients (macOS app) the
 * same ladder the conversation uses, with one hard guarantee: a candidate is
 * persisted as the default model only after a real completion round-trips.
 * A failing candidate must never leave config pointing at a broken model.
 */
export const SETUP_INFERENCE_TEST_TIMEOUT_MS = 90_000;

export const SETUP_INFERENCE_TEST_PROMPT = "Reply with the single word OK. Do not use tools.";

const PROVIDER_AUTO_SETUP_KIND_PREFIX = "provider-auto:";

export const AUTO_LOCAL_MODEL_LEAN_ANNOUNCEMENT =
  "This model is small, so I set up the lean surface — switching to a bigger model later lifts it.";

export type ProviderAutoSetupInferenceKind = `provider-auto:${string}`;

export type SetupInferenceKind = InferenceBackendKind | ProviderAutoSetupInferenceKind;

export type SetupInferenceCandidate = {
  kind: SetupInferenceKind;
  /** Canonical provider identity for clients with bundled brand artwork. */
  brandId?: string;
  label: string;
  detail: string;
  modelRef: string;
  /** @deprecated Gateway wire compatibility for older macOS clients. Always false. */
  recommended: false;
  credentials?: boolean;
  icon?: string;
  website?: string;
};

export type SetupInferenceUnavailableCandidate = {
  id: string;
  label: string;
  detail: string;
  reason: string;
};

export type SetupInferenceDetection = {
  candidates: SetupInferenceCandidate[];
  /** Installed integrations that cannot safely run the tool-free setup probe. */
  unavailableCandidates: SetupInferenceUnavailableCandidate[];
  /** Text-inference key/token methods exposed by installed provider manifests. */
  manualProviders: SetupInferenceManualProvider[];
  /** Interactive provider-owned browser and device-code sign-in methods. */
  authOptions: SetupInferenceAuthOption[];
  /** Curated tools clients can offer when no existing AI access is detected. */
  recommendedInstalls: SetupRecommendedInstall[];
  /** Resolved workspace the setup apply would use (display + default). */
  workspace: string;
  configuredModel?: string;
  /** The connected Gateway already has a configured default-agent model. */
  setupComplete: boolean;
};

export type SetupInferenceStatus =
  | "ok"
  | "auth"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "format"
  | "unavailable"
  | "unknown";

export type SetupInferenceFailureStatus = Exclude<SetupInferenceStatus, "ok">;

export type ActivateSetupInferenceResult =
  | { ok: true; modelRef: string; latencyMs: number; lines: string[] }
  | { ok: false; status: SetupInferenceFailureStatus; error: string };

/**
 * The config commit may have happened, so callers must verify current setup
 * instead of treating this like a definitive candidate failure and retrying.
 */
export class SetupInferenceActivationIndeterminateError extends Error {
  override name = "SetupInferenceActivationIndeterminateError";
}

export class SetupInferenceActivationUnavailableError extends Error {
  override name = "SetupInferenceActivationUnavailableError";
}

/**
 * The live-tested owner no longer matches current config. Activation maps this
 * to `{ ok: false, status: "auth" }` so the guided-onboarding ladder can move
 * to its next candidate instead of crashing the CLI.
 */
export class SetupInferenceOwnerDriftError extends Error {
  override name = "SetupInferenceOwnerDriftError";
}

export type VerifySetupInferenceResult =
  | {
      ok: true;
      modelRef: string;
      latencyMs: number;
      authProfiles?: ProviderAuthResult["profiles"];
    }
  | {
      ok: false;
      status: SetupInferenceFailureStatus;
      error: string;
      authProfiles?: ProviderAuthResult["profiles"];
    };

export type CompleteSetupInferenceResult =
  | { ok: true; modelRef: string; latencyMs: number; text: string }
  | { ok: false; status: SetupInferenceFailureStatus; error: string };

export type BoundVerifySetupInferenceResult =
  | {
      ok: true;
      modelRef: string;
      latencyMs: number;
      binding: SystemAgentVerifiedInferenceBinding;
    }
  | { ok: false; status: SetupInferenceFailureStatus; error: string };

export type ActivateSetupInferenceParams = {
  kind: SetupInferenceKind | "api-key" | "provider-auth";
  /** Exact explicit model to probe and persist instead of the route's starter model. */
  modelRef?: string;
  /** Manual step only: provider-auth choice returned by detection. */
  authChoice?: string;
  /** Manual step only: the pasted API key or token. Never logged. */
  apiKey?: string;
  workspace?: string;
  surface: "cli" | "gateway";
  /** False when an enclosing persistent-operation boundary owns the setup audit. */
  recordSetupAudit?: boolean;
  runtime: RuntimeEnv;
  /** Interactive provider login transport, required for `provider-auth`. */
  prompter?: WizardPrompter;
  /** Cancels provider-owned browser callbacks and device-code polling. */
  signal?: AbortSignal;
  /** Session cancellation gate; interactive credentials must never persist after cancel. */
  isCancelled?: () => boolean;
  onCommitStarted?: () => void;
  deps?: ActivateSetupInferenceDeps;
};

export class SetupInferenceCancelledError extends Error {
  constructor() {
    super("Provider login was cancelled.");
  }
}

export function throwIfSetupInferenceCancelled(
  params: Pick<ActivateSetupInferenceParams, "signal" | "isCancelled">,
): void {
  if (params.signal?.aborted || params.isCancelled?.()) {
    throw new SetupInferenceCancelledError();
  }
}

export async function waitForProviderAuth<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return await promise;
  }
  if (signal.aborted) {
    throw new SetupInferenceCancelledError();
  }
  let rejectAborted: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () => rejectAborted?.(new SetupInferenceCancelledError());
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

type SetupInferenceRunEmbeddedAgent = (
  params: Parameters<typeof import("../agents/embedded-agent.js").runEmbeddedAgent>[0] & {
    onSuccessfulAuthBinding?: (binding: AgentExecutionAuthBinding) => void;
    authProfileStateMode?: "read-write" | "read-only";
    preparedModelRuntimeMode?: "isolated-read-only";
  },
) => ReturnType<typeof import("../agents/embedded-agent.js").runEmbeddedAgent>;

export type ActivateSetupInferenceDeps = {
  readConfigFileSnapshot?: typeof import("../config/config.js").readConfigFileSnapshot;
  runEmbeddedAgent?: SetupInferenceRunEmbeddedAgent;
  runCliAgent?: typeof import("../agents/cli-runner.js").runCliAgent;
  ensureCodexRuntimePlugin?: typeof import("../commands/codex-runtime-plugin-install.js").ensureCodexRuntimePluginForModelSelection;
  ensureSelectedAgentHarnessPlugin?: typeof import("../agents/harness/runtime-plugin.js").ensureSelectedAgentHarnessPlugin;
  transformConfigWithPendingPluginInstalls?: typeof import("../plugins/install-record-commit.js").transformConfigWithPendingPluginInstalls;
  refreshPluginRegistryAfterConfigMutation?: typeof import("../plugins/registry-refresh.js").refreshPluginRegistryAfterConfigMutation;
  ensurePluginRegistryLoaded?: typeof import("../plugins/runtime/runtime-registry-loader.js").ensurePluginRegistryLoaded;
  resolvePluginProviders?: typeof resolvePluginProviders;
  resolveManifestProviderAuthChoice?: typeof resolveManifestProviderAuthChoice;
  enablePluginInConfig?: typeof enablePluginInConfig;
  updateAuthProfileStoreWithLock?: typeof updateAuthProfileStoreWithLock;
  loadPersistedAuthProfileStore?: typeof loadPersistedAuthProfileStore;
  loadAuthProfileStoreForRuntime?: typeof loadAuthProfileStoreForRuntime;
  ensureAuthProfileStore?: typeof import("../agents/auth-profiles/store.js").ensureAuthProfileStore;
  resolveCliAuthBindingFingerprint?: typeof import("../agents/cli-auth-epoch.js").resolveCliAuthBindingFingerprint;
  resolveCliRuntimeArtifactFingerprint?: typeof import("../agents/cli-auth-epoch.js").resolveCliRuntimeArtifactFingerprint;
  resolveCliRuntimeOwnerFingerprint?: typeof import("../agents/cli-auth-epoch.js").resolveCliRuntimeOwnerFingerprint;
  resolveApiKeyForProvider?: typeof import("../agents/model-auth.js").resolveApiKeyForProvider;
  readCodexCliActiveApiKey?: typeof readCodexCliActiveApiKey;
  loadPluginRegistrySnapshot?: SystemAgentVerifiedInferenceDeps["loadPluginRegistrySnapshot"];
  fingerprintPluginRuntimeArtifact?: SystemAgentVerifiedInferenceDeps["fingerprintPluginRuntimeArtifact"];
  captureSystemAgentOwnerPluginArtifacts?: typeof captureSystemAgentOwnerPluginArtifacts;
  createSystemAgentVerifiedInferenceBinding?: typeof createSystemAgentVerifiedInferenceBinding;
  readPersistedInstalledPluginIndexInstallRecords?: typeof import("../plugins/installed-plugin-index-records.js").readPersistedInstalledPluginIndexInstallRecords;
  markRetainedManagedNpmInstall?: typeof import("../plugins/managed-npm-retention.js").markRetainedManagedNpmInstall;
  clearLoadInstalledPluginIndexInstallRecordsCache?: typeof import("../plugins/installed-plugin-index-records.js").clearLoadInstalledPluginIndexInstallRecordsCache;
  clearPluginMetadataLifecycleCaches?: typeof import("../plugins/plugin-metadata-lifecycle.js").clearPluginMetadataLifecycleCaches;
  invalidatePluginRuntimeDiscoveryAfterConfigMutation?: typeof import("../plugins/registry-refresh.js").invalidatePluginRuntimeDiscoveryAfterConfigMutation;
  disposeOpenClawAgentDatabaseByPath?: typeof import("../state/openclaw-agent-db.js").disposeOpenClawAgentDatabaseByPath;
  createTempDir?: () => Promise<string>;
  removeTempDir?: (dir: string) => Promise<void>;
  timeoutMs?: number;
};

export type DetectSetupInferenceDeps = {
  detectInferenceBackends?: typeof detectInferenceBackends;
  probeLocalCommand?: typeof probeLocalCommand;
  resolveManifestProviderAuthChoices?: typeof resolveManifestProviderAuthChoices;
  resolvePluginProviders?: typeof resolvePluginProviders;
  enablePluginInConfig?: typeof enablePluginInConfig;
};

export function toProviderAutoSetupKind(choiceId: string): ProviderAutoSetupInferenceKind {
  return `${PROVIDER_AUTO_SETUP_KIND_PREFIX}${encodeURIComponent(choiceId)}`;
}

export function parseProviderAutoSetupChoiceId(kind: string): string | undefined {
  if (!kind.startsWith(PROVIDER_AUTO_SETUP_KIND_PREFIX)) {
    return undefined;
  }
  const encoded = kind.slice(PROVIDER_AUTO_SETUP_KIND_PREFIX.length);
  if (!encoded) {
    return undefined;
  }
  try {
    return decodeURIComponent(encoded) || undefined;
  } catch {
    return undefined;
  }
}

export function invalidSetupConfigError(snapshot: {
  path: string;
  issues?: Array<{ path?: string; message: string }>;
}): string {
  const issue = snapshot.issues?.[0];
  const detail = issue ? ` (${issue.path ? `${issue.path}: ` : ""}${issue.message})` : "";
  return `OpenClaw config ${snapshot.path} is invalid${detail}. Fix it before running setup.`;
}

export function resolveCandidatePresentation(
  candidate: Pick<SetupInferenceCandidate, "kind" | "modelRef">,
  authChoices: readonly ProviderAuthChoiceMetadata[],
): Pick<SetupInferenceCandidate, "brandId" | "icon" | "website"> {
  const choice = authChoices.find(
    (entry) =>
      entry.choiceId === candidate.kind ||
      entry.deprecatedChoiceIds?.includes(candidate.kind) === true,
  );
  const brandId = resolveSetupInferenceCandidateBrandId(candidate, choice?.providerId);
  return {
    ...(brandId ? { brandId } : {}),
    ...(choice?.icon ? { icon: choice.icon } : {}),
    ...(choice?.website ? { website: choice.website } : {}),
  };
}

export async function resolveSetupInferenceWorkspace(params: {
  configExists: boolean;
  configValid: boolean;
}): Promise<{ workspace: string; hasAuthoredSetup: boolean }> {
  const { authoredConfig, hasAuthoredSetup } = await loadAuthoredSetupConfig(params);
  const { DEFAULT_WORKSPACE } = await import("../commands/onboard-helpers.js");
  return {
    workspace: resolveUserPath(
      authoredConfig?.agents?.defaults?.workspace?.trim() || DEFAULT_WORKSPACE,
    ),
    hasAuthoredSetup,
  };
}
