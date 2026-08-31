import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import {
  type AgentRunResultView,
  extractAgentRunTerminalError,
  extractAgentRunText,
} from "../agents/agent-run-result.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import { normalizeAuthProfileCredential } from "../agents/auth-profiles/credential-normalize.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store.js";
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import { describeFailoverError } from "../agents/failover-error.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { SessionManager } from "../agents/sessions/index.js";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { formatErrorMessage } from "../infra/errors.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { prepareProviderAuthProfilesForPersistence } from "../plugins/provider-auth-persistence.js";
import type { ProviderAuthResult } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  type ActivateSetupInferenceDeps,
  SETUP_INFERENCE_TEST_PROMPT,
  SETUP_INFERENCE_TEST_TIMEOUT_MS,
  SetupInferenceCancelledError,
  type SetupInferenceFailureStatus,
  setupInferenceLog,
} from "./setup-inference-core.js";
import {
  type SetupInferenceTestPlan,
  extractRunWinnerError,
  mapFailoverReasonToSetupStatus,
  resolveStrictSetupAuthProfileError,
  resolveToolFreeCliSetupError,
} from "./setup-inference-plan-helpers.js";
import { resolveSetupInferenceProbeStreamParams } from "./setup-inference-probe.js";

export async function cleanupSetupInferenceTempDir(params: {
  tempDir: string;
  deps: ActivateSetupInferenceDeps;
  runtime?: RuntimeEnv;
}): Promise<void> {
  try {
    const disposeDatabase =
      params.deps.disposeOpenClawAgentDatabaseByPath ??
      (await import("../state/openclaw-agent-db.js")).disposeOpenClawAgentDatabaseByPath;
    disposeDatabase(path.join(params.tempDir, "agent", "openclaw-agent.sqlite"));
  } catch {
    // Windows cannot remove an open SQLite file. Keep cleanup nonfatal, but
    // always try the directory removal so callers do not retain probe secrets.
    setupInferenceLog.warn("Could not dispose the temporary inference auth database.");
  }
  try {
    await (
      params.deps.removeTempDir ?? ((dir: string) => fs.rm(dir, { recursive: true, force: true }))
    )(params.tempDir);
  } catch (error) {
    // Cleanup happens after the inference result or durable activation. It must
    // never turn a verified/committed route into a failed client RPC.
    params.runtime?.error?.(
      `Could not remove temporary AI setup files: ${formatErrorMessage(error)}`,
    );
    setupInferenceLog.warn("Could not remove the temporary inference test directory.");
  }
}

export async function isCodexInstallRecordPersisted(
  record: PluginInstallRecord,
  deps: ActivateSetupInferenceDeps,
): Promise<boolean> {
  try {
    const readInstallRecords =
      deps.readPersistedInstalledPluginIndexInstallRecords ??
      (await import("../plugins/installed-plugin-index-records.js"))
        .readPersistedInstalledPluginIndexInstallRecords;
    const currentInstallRecords = await readInstallRecords();
    return currentInstallRecords !== null && isDeepStrictEqual(currentInstallRecords.codex, record);
  } catch {
    return false;
  }
}

export async function retainUnownedCodexInstall(params: {
  record: PluginInstallRecord;
  verifyOwnership: boolean;
  deps: ActivateSetupInferenceDeps;
}): Promise<boolean> {
  if (params.verifyOwnership && (await isCodexInstallRecordPersisted(params.record, params.deps))) {
    return true;
  }
  if (params.record.source !== "npm" || !params.record.installPath?.trim()) {
    return true;
  }
  try {
    // Never delete an unowned generation: recovery/startup cleanup skips the
    // marker, a successful install commit clears it, and later install/GC may
    // safely reuse or remove the bytes.
    const markRetained =
      params.deps.markRetainedManagedNpmInstall ??
      (await import("../plugins/managed-npm-retention.js")).markRetainedManagedNpmInstall;
    const marked = await markRetained({
      packageDir: params.record.installPath,
      pluginId: "codex",
      reason: "openclaw-inference-activation-not-committed",
    });
    if (!marked) {
      setupInferenceLog.warn("Could not retain the uncommitted Codex runtime package generation.");
    }
    return marked;
  } catch {
    // Retention is best effort and marker-after-adoption is non-destructive.
    // A later install or GC may still reuse or remove the unowned generation.
    setupInferenceLog.warn("Could not retain the uncommitted Codex runtime package generation.");
    return false;
  } finally {
    await clearUnownedCodexInstallCaches(params.deps);
  }
}

async function clearUnownedCodexInstallCaches(deps: ActivateSetupInferenceDeps): Promise<void> {
  try {
    const clearInstallRecords =
      deps.clearLoadInstalledPluginIndexInstallRecordsCache ??
      (await import("../plugins/installed-plugin-index-records.js"))
        .clearLoadInstalledPluginIndexInstallRecordsCache;
    clearInstallRecords();
  } catch {
    setupInferenceLog.warn(
      "Could not clear the plugin install-record cache after failed Codex activation.",
    );
  }
  try {
    const clearPluginMetadata =
      deps.clearPluginMetadataLifecycleCaches ??
      (await import("../plugins/plugin-metadata-lifecycle.js")).clearPluginMetadataLifecycleCaches;
    clearPluginMetadata();
  } catch {
    setupInferenceLog.warn("Could not clear plugin metadata caches after failed Codex activation.");
  }
  try {
    const invalidateRuntimeDiscovery =
      deps.invalidatePluginRuntimeDiscoveryAfterConfigMutation ??
      (await import("../plugins/registry-refresh.js"))
        .invalidatePluginRuntimeDiscoveryAfterConfigMutation;
    await invalidateRuntimeDiscovery({ logger: setupInferenceLog });
  } catch {
    setupInferenceLog.warn(
      "Could not clear plugin runtime discovery after failed Codex activation.",
    );
  }
}

export async function restoreSetupPluginMetadata(params: {
  readSnapshot: () => Promise<
    Awaited<ReturnType<typeof import("../config/config.js").readConfigFileSnapshot>>
  >;
  workspaceDir: string;
  deps: ActivateSetupInferenceDeps;
}): Promise<void> {
  try {
    const snapshot = await params.readSnapshot();
    const sourceConfig =
      snapshot.exists && snapshot.valid ? (snapshot.sourceConfig ?? snapshot.config) : {};
    const refreshPluginRegistry =
      params.deps.refreshPluginRegistryAfterConfigMutation ??
      (await import("../plugins/registry-refresh.js")).refreshPluginRegistryAfterConfigMutation;
    await refreshPluginRegistry({
      config: sourceConfig,
      reason: "source-changed",
      workspaceDir: params.workspaceDir,
      logger: setupInferenceLog,
    });
  } catch {
    setupInferenceLog.warn("Could not restore plugin metadata after the inference setup probe.");
  }
}

function isMergePatchObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function mergePatchConflicts(base: unknown, current: unknown, patch: unknown): boolean {
  if (!isMergePatchObject(patch)) {
    return !isDeepStrictEqual(base, current);
  }
  const baseIsObject = isMergePatchObject(base);
  const currentIsObject = isMergePatchObject(current);
  if (baseIsObject !== currentIsObject) {
    return true;
  }
  if (!baseIsObject && !currentIsObject && !isDeepStrictEqual(base, current)) {
    return true;
  }
  const baseRecord = baseIsObject ? base : {};
  const currentRecord = currentIsObject ? current : {};
  return Object.entries(patch).some(([key, childPatch]) =>
    mergePatchConflicts(baseRecord[key], currentRecord[key], childPatch),
  );
}

export function applyManualAuthConfig(
  config: OpenClawConfig,
  manualAuth: NonNullable<SetupInferenceTestPlan["manualAuth"]>,
  configKind: "runtime" | "source",
  enablePlugin: typeof enablePluginInConfig = enablePluginInConfig,
): OpenClawConfig {
  let enabledConfig = config;
  if (manualAuth.pluginId) {
    const enableResult = enablePlugin(config, manualAuth.pluginId);
    if (!enableResult.enabled) {
      throw new Error(`Provider plugin ${manualAuth.pluginId} is ${enableResult.reason}.`);
    }
    enabledConfig = enableResult.config;
  }
  // Runtime validation includes resolved defaults; source validation must compare
  // only authored state so normal materialization cannot impersonate a concurrent edit.
  const configBase =
    configKind === "runtime" ? manualAuth.runtimeConfigBase : manualAuth.sourceConfigBase;
  if (mergePatchConflicts(configBase, enabledConfig, manualAuth.configPatch)) {
    throw new Error(
      "Provider configuration changed during the live inference test, so the verified credential was not saved. Review the current provider settings and retry.",
    );
  }
  return applyMergePatch(enabledConfig, manualAuth.configPatch) as OpenClawConfig;
}

export type ManualAuthPersistenceReceipt = {
  agentDir: string;
  profiles: Array<{
    profileId: string;
    credential: ReturnType<typeof normalizeAuthProfileCredential>;
  }>;
  /** Profiles created by this activation; rollback must not delete prior identical entries. */
  insertedProfileIds: ReadonlySet<string>;
  rollbackProtectedSecretStorage: () => void;
};

type ManualAuthProfilesReadback = "present" | "absent" | "mismatch" | "unknown";

type ManualAuthPersistenceResult =
  | { status: "persisted"; receipt: ManualAuthPersistenceReceipt }
  | { status: "not-persisted" }
  | { status: "unknown"; receipt: ManualAuthPersistenceReceipt };

function modelSelectionReferencesProfile(value: unknown, profileIds: ReadonlySet<string>): boolean {
  if (typeof value === "string") {
    const profile = splitTrailingAuthProfile(value).profile;
    return profile !== undefined && profileIds.has(profile);
  }
  if (!isMergePatchObject(value)) {
    return false;
  }
  if (modelSelectionReferencesProfile(value.primary, profileIds)) {
    return true;
  }
  return (
    Array.isArray(value.fallbacks) &&
    value.fallbacks.some((fallback) => modelSelectionReferencesProfile(fallback, profileIds))
  );
}

export function configReferencesManualAuthProfiles(
  config: OpenClawConfig,
  receipt: ManualAuthPersistenceReceipt,
): boolean {
  const profileIds = new Set(receipt.profiles.map((profile) => profile.profileId));
  if (Object.keys(config.auth?.profiles ?? {}).some((profileId) => profileIds.has(profileId))) {
    return true;
  }
  if (
    Object.values(config.auth?.order ?? {}).some((order) =>
      order.some((profileId) => profileIds.has(profileId)),
    )
  ) {
    return true;
  }
  if (modelSelectionReferencesProfile(config.agents?.defaults?.model, profileIds)) {
    return true;
  }
  return listAgentEntries(config).some((agent) =>
    modelSelectionReferencesProfile(agent.model, profileIds),
  );
}

function readManualAuthProfiles(
  receipt: ManualAuthPersistenceReceipt,
  deps: ActivateSetupInferenceDeps,
): ManualAuthProfilesReadback {
  let store: ReturnType<typeof loadPersistedAuthProfileStore>;
  try {
    store = (deps.loadPersistedAuthProfileStore ?? loadPersistedAuthProfileStore)(receipt.agentDir);
  } catch {
    return "unknown";
  }
  if (!store) {
    return "unknown";
  }
  if (
    receipt.profiles.every((profile) =>
      isDeepStrictEqual(store.profiles[profile.profileId], profile.credential),
    )
  ) {
    return "present";
  }
  if (receipt.profiles.every((profile) => store.profiles[profile.profileId] === undefined)) {
    return "absent";
  }
  return "mismatch";
}

export function manualAuthProfilesPersisted(
  receipt: ManualAuthPersistenceReceipt,
  deps: ActivateSetupInferenceDeps,
): boolean {
  return readManualAuthProfiles(receipt, deps) === "present";
}

export async function persistManualAuthProfiles(params: {
  profiles: ProviderAuthResult["profiles"];
  agentDir: string;
  deps: ActivateSetupInferenceDeps;
  secretStorage?: { config: OpenClawConfig; env?: NodeJS.ProcessEnv };
}): Promise<ManualAuthPersistenceResult> {
  const prepared = params.secretStorage
    ? prepareProviderAuthProfilesForPersistence({
        profiles: params.profiles,
        config: params.secretStorage.config,
        ...(params.secretStorage.env ? { env: params.secretStorage.env } : {}),
      })
    : { profiles: [...params.profiles], rollback: () => {} };
  const profiles = prepared.profiles.map((profile) => ({
    profileId: profile.profileId,
    credential: normalizeAuthProfileCredential(profile.credential),
  }));
  const insertedProfileIds = new Set<string>();
  const receipt = {
    agentDir: params.agentDir,
    profiles,
    insertedProfileIds,
    rollbackProtectedSecretStorage: prepared.rollback,
  };
  let collision = false;
  const update = params.deps.updateAuthProfileStoreWithLock ?? updateAuthProfileStoreWithLock;
  const updated = await update({
    agentDir: params.agentDir,
    saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
    updater: (store) => {
      let changed = false;
      for (const profile of profiles) {
        const existing = store.profiles[profile.profileId];
        if (existing && !isDeepStrictEqual(existing, profile.credential)) {
          collision = true;
          return false;
        }
        if (!existing) {
          store.profiles[profile.profileId] = profile.credential;
          insertedProfileIds.add(profile.profileId);
          changed = true;
        }
      }
      return changed;
    },
  });
  if (collision) {
    prepared.rollback();
    return { status: "not-persisted" };
  }
  // The store helper can report a post-commit chmod failure as null. Read back
  // the exact unique profiles before deciding whether the transaction failed.
  const readback = readManualAuthProfiles(receipt, params.deps);
  if (updated !== null || readback === "present") {
    return { status: "persisted", receipt };
  }
  if (readback === "absent") {
    prepared.rollback();
    return { status: "not-persisted" };
  }
  return { status: "unknown", receipt };
}

function rollbackManualAuthSecretStorage(receipt: ManualAuthPersistenceReceipt): boolean {
  try {
    receipt.rollbackProtectedSecretStorage();
    return true;
  } catch {
    return false;
  }
}

export async function rollbackManualAuthProfiles(
  receipt: ManualAuthPersistenceReceipt,
  deps: ActivateSetupInferenceDeps,
): Promise<boolean> {
  if (receipt.insertedProfileIds.size === 0) {
    return rollbackManualAuthSecretStorage(receipt);
  }
  const update = deps.updateAuthProfileStoreWithLock ?? updateAuthProfileStoreWithLock;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let updated: Awaited<ReturnType<typeof update>> = null;
    try {
      updated = await update({
        agentDir: receipt.agentDir,
        saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
        updater: (store) => {
          let changed = false;
          for (const profile of receipt.profiles) {
            if (!receipt.insertedProfileIds.has(profile.profileId)) {
              continue;
            }
            if (isDeepStrictEqual(store.profiles[profile.profileId], profile.credential)) {
              delete store.profiles[profile.profileId];
              changed = true;
            }
          }
          return changed;
        },
      });
    } catch {
      // A thrown write may still have committed. Only readback or a later
      // locked attempt may prove removal; otherwise the caller reports the
      // activation as indeterminate.
    }
    if (
      updated &&
      receipt.profiles.every(
        (profile) =>
          !receipt.insertedProfileIds.has(profile.profileId) ||
          updated.profiles[profile.profileId] === undefined,
      )
    ) {
      return rollbackManualAuthSecretStorage(receipt);
    }
    let persistedStore: ReturnType<typeof loadPersistedAuthProfileStore>;
    try {
      persistedStore = (deps.loadPersistedAuthProfileStore ?? loadPersistedAuthProfileStore)(
        receipt.agentDir,
      );
    } catch {
      persistedStore = null;
    }
    if (
      persistedStore &&
      receipt.profiles.every(
        (profile) =>
          !receipt.insertedProfileIds.has(profile.profileId) ||
          persistedStore.profiles[profile.profileId] === undefined,
      )
    ) {
      return rollbackManualAuthSecretStorage(receipt);
    }
  }
  return false;
}

export async function runSetupInferenceTest(params: {
  plan: SetupInferenceTestPlan;
  prompt?: string;
  tempDir: string;
  deps: ActivateSetupInferenceDeps;
  authProfileStateMode: "read-write" | "read-only";
  requireExecutionOwner: boolean;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; latencyMs: number; auth: AgentExecutionAuthBinding; text: string }
  | {
      ok: false;
      status: SetupInferenceFailureStatus;
      error: string;
    }
> {
  const { plan, tempDir, deps, authProfileStateMode, requireExecutionOwner } = params;
  // Keep probe prefixes aligned with the logging filters; provider transports can also use the
  // session id as cache affinity, so this ephemeral id must stay under OpenAI's 64-character cap.
  const runId = `probe-setup-inference-${randomUUID()}`;
  const sessionId = runId;
  const sessionFile = `in-memory:${sessionId}`;
  const sessionManager = SessionManager.inMemory(tempDir);
  const effectiveAgentId = plan.routeAgentId ?? plan.agentId ?? "openclaw";
  const sessionKey = `agent:${effectiveAgentId}:setup-inference:incognito-${runId}`;
  const timeoutMs = deps.timeoutMs ?? SETUP_INFERENCE_TEST_TIMEOUT_MS;
  const started = Date.now();
  const failed = (status: SetupInferenceFailureStatus, error: string) => {
    setupInferenceLog.warn("Inference setup probe failed.", {
      event: "setup_inference_probe_failed",
      provider: plan.provider,
      model: plan.model,
      runner: plan.runner,
      status,
      timeoutMs,
      durationMs: Date.now() - started,
    });
    return { ok: false as const, status, error };
  };
  const preparedRunAdmission = prepareSystemAgentRunAdmission(
    plan.config,
    runId,
    effectiveAgentId,
    "system-agent.setup-inference",
  );
  let successfulAuth: AgentExecutionAuthBinding | undefined;
  try {
    if (plan.runner === "cli") {
      const unsupportedError = resolveToolFreeCliSetupError(plan);
      if (unsupportedError) {
        return failed("unavailable", unsupportedError);
      }
    }
    const strictProfileError = resolveStrictSetupAuthProfileError({
      plan,
      workspaceDir: tempDir,
      deps,
    });
    if (strictProfileError) {
      return failed("auth", strictProfileError);
    }

    let result: AgentRunResultView;
    if (plan.runner === "cli") {
      const runCli = deps.runCliAgent ?? (await import("../agents/cli-runner.js")).runCliAgent;
      result = (await runCli({
        preparedRunAdmission,
        sessionId,
        sessionKey,
        sessionManager,
        agentId: effectiveAgentId,
        trigger: "manual",
        sessionFile,
        workspaceDir: tempDir,
        ...(plan.agentDir ? { agentDir: plan.agentDir } : {}),
        config: plan.executionConfig ?? plan.config,
        prompt: params.prompt ?? SETUP_INFERENCE_TEST_PROMPT,
        provider: plan.provider,
        model: plan.model,
        ...(plan.authProfileId ? { authProfileId: plan.authProfileId } : {}),
        timeoutMs,
        runId,
        messageChannel: "openclaw",
        messageProvider: "openclaw",
        executionMode: "side-question",
        disableTools: true,
        cleanupCliLiveSessionOnRunEnd: true,
        onSuccessfulAuthBinding: (binding) => {
          successfulAuth = binding;
        },
        ...(params.signal ? { abortSignal: params.signal } : {}),
      })) as AgentRunResultView;
    } else {
      const runEmbedded =
        deps.runEmbeddedAgent ?? (await import("../agents/embedded-agent.js")).runEmbeddedAgent;
      result = (await runEmbedded({
        preparedRunAdmission,
        sessionId,
        sessionKey,
        sessionManager,
        agentId: effectiveAgentId,
        trigger: "manual",
        sessionFile,
        workspaceDir: tempDir,
        ...(plan.agentDir ? { agentDir: plan.agentDir } : {}),
        config: plan.executionConfig ?? plan.config,
        prompt: params.prompt ?? SETUP_INFERENCE_TEST_PROMPT,
        provider: plan.provider,
        model: plan.model,
        ...(plan.authProfileId
          ? { authProfileId: plan.authProfileId, authProfileIdSource: "user" as const }
          : {}),
        authProfileStateMode,
        preparedModelRuntimeMode: "isolated-read-only",
        ...(plan.cleanupBundleMcpOnRunEnd ? { cleanupBundleMcpOnRunEnd: true } : {}),
        ...(plan.agentHarnessRuntimeOverride
          ? { agentHarnessRuntimeOverride: plan.agentHarnessRuntimeOverride }
          : {}),
        timeoutMs,
        runId,
        lane: `session:probe-setup-inference:${plan.provider}`,
        thinkLevel: "off",
        reasoningLevel: "off",
        verboseLevel: "off",
        disableTrajectory: true,
        // Keep the "reply OK" probe bounded while leaving room for reasoning.
        // Custom completions pass no explicit cap: the stream layer applies the
        // resolved model's own maxTokens budget without exceeding its limits.
        ...(params.prompt === undefined
          ? resolveSetupInferenceProbeStreamParams(plan.agentHarnessRuntimeOverride)
          : {}),
        disableTools: true,
        modelRun: true,
        messageChannel: "openclaw",
        messageProvider: "openclaw",
        onSuccessfulAuthBinding: (binding) => {
          successfulAuth = binding;
        },
        ...(params.signal ? { abortSignal: params.signal } : {}),
      })) as AgentRunResultView;
    }
    if (params.signal?.aborted) {
      throw new SetupInferenceCancelledError();
    }
    const terminalError = extractAgentRunTerminalError(result);
    if (terminalError) {
      const described = describeFailoverError(new Error(terminalError));
      return failed(mapFailoverReasonToSetupStatus(described.reason), described.message);
    }
    const text = extractAgentRunText(result)?.trim();
    if (!text) {
      return failed(
        "format",
        "The model started but did not send a reply. Try again or pick another option.",
      );
    }
    const winnerError = await extractRunWinnerError(plan, result);
    if (winnerError) {
      return failed("unknown", winnerError);
    }
    if (requireExecutionOwner && !successfulAuth) {
      return failed(
        "unknown",
        "Inference succeeded, but its runtime did not report an owner that OpenClaw can safely reuse.",
      );
    }
    return {
      ok: true,
      latencyMs: Date.now() - started,
      text,
      auth:
        successfulAuth ??
        (!requireExecutionOwner && plan.authProfileId ? { authProfileId: plan.authProfileId } : {}),
    };
  } catch (error) {
    const described = describeFailoverError(error);
    return failed(mapFailoverReasonToSetupStatus(described.reason), described.message);
  } finally {
    preparedRunAdmission.close();
  }
}
