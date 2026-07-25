import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { listAgentEntries } from "../agents/agent-scope.js";
import { normalizeAuthProfileCredential } from "../agents/auth-profiles/credential-normalize.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store.js";
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import { describeFailoverError } from "../agents/failover-error.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { formatErrorMessage } from "../infra/errors.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import type { ProviderAuthResult } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  type ActivateSetupInferenceDeps,
  SETUP_INFERENCE_TEST_PROMPT,
  SETUP_INFERENCE_TEST_TIMEOUT_MS,
  SetupInferenceCancelledError,
  type SetupInferenceFailureStatus,
  log,
} from "./setup-inference-core.js";
import {
  type RunResult,
  type SetupInferenceTestPlan,
  extractRunTerminalError,
  extractRunText,
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
    log.warn("Could not dispose the temporary inference auth database.");
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
    log.warn("Could not remove the temporary inference test directory.");
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
      log.warn("Could not retain the uncommitted Codex runtime package generation.");
    }
    return marked;
  } catch {
    // Retention is best effort and marker-after-adoption is non-destructive.
    // A later install or GC may still reuse or remove the unowned generation.
    log.warn("Could not retain the uncommitted Codex runtime package generation.");
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
    log.warn("Could not clear the plugin install-record cache after failed Codex activation.");
  }
  try {
    const clearPluginMetadata =
      deps.clearPluginMetadataLifecycleCaches ??
      (await import("../plugins/plugin-metadata-lifecycle.js")).clearPluginMetadataLifecycleCaches;
    clearPluginMetadata();
  } catch {
    log.warn("Could not clear plugin metadata caches after failed Codex activation.");
  }
  try {
    const invalidateRuntimeDiscovery =
      deps.invalidatePluginRuntimeDiscoveryAfterConfigMutation ??
      (await import("../plugins/registry-refresh.js"))
        .invalidatePluginRuntimeDiscoveryAfterConfigMutation;
    await invalidateRuntimeDiscovery({ logger: log });
  } catch {
    log.warn("Could not clear plugin runtime discovery after failed Codex activation.");
  }
}

export async function reloadCodexRegistryAfterActivation(params: {
  readSnapshot: () => Promise<
    Awaited<ReturnType<typeof import("../config/config.js").readConfigFileSnapshot>>
  >;
  workspaceDir: string;
  deps: ActivateSetupInferenceDeps;
}): Promise<boolean> {
  let snapshot: Awaited<ReturnType<typeof import("../config/config.js").readConfigFileSnapshot>>;
  try {
    snapshot = await params.readSnapshot();
  } catch {
    log.warn("Could not read config while reloading the plugin registry after Codex activation.");
    return false;
  }
  const runtimeConfig =
    snapshot.exists && snapshot.valid
      ? (snapshot.runtimeConfig ?? snapshot.config)
      : ({} satisfies OpenClawConfig);
  const sourceConfig =
    snapshot.exists && snapshot.valid
      ? (snapshot.sourceConfig ?? snapshot.config)
      : ({} satisfies OpenClawConfig);
  try {
    const refreshPluginRegistry =
      params.deps.refreshPluginRegistryAfterConfigMutation ??
      (await import("../plugins/registry-refresh.js")).refreshPluginRegistryAfterConfigMutation;
    await refreshPluginRegistry({
      config: sourceConfig,
      reason: "source-changed",
      workspaceDir: params.workspaceDir,
      logger: log,
    });
  } catch {
    log.warn("Could not refresh persisted plugin registry metadata after Codex activation.");
  }
  try {
    const ensurePluginRegistryLoaded =
      params.deps.ensurePluginRegistryLoaded ??
      (await import("../plugins/runtime/runtime-registry-loader.js")).ensurePluginRegistryLoaded;
    ensurePluginRegistryLoaded({
      scope: "all",
      config: runtimeConfig,
      activationSourceConfig: sourceConfig,
      workspaceDir: params.workspaceDir,
    });
    return true;
  } catch {
    log.warn("Could not reload the active plugin registry after Codex inference activation.");
    return false;
  }
}

function isMergePatchObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
}): Promise<ManualAuthPersistenceResult> {
  const profiles = params.profiles.map((profile) => ({
    profileId: profile.profileId,
    credential: normalizeAuthProfileCredential(profile.credential),
  }));
  const insertedProfileIds = new Set<string>();
  const receipt = { agentDir: params.agentDir, profiles, insertedProfileIds };
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
    return { status: "not-persisted" };
  }
  // The store helper can report a post-commit chmod failure as null. Read back
  // the exact unique profiles before deciding whether the transaction failed.
  const readback = readManualAuthProfiles(receipt, params.deps);
  if (updated !== null || readback === "present") {
    return { status: "persisted", receipt };
  }
  return readback === "absent" ? { status: "not-persisted" } : { status: "unknown", receipt };
}

export async function rollbackManualAuthProfiles(
  receipt: ManualAuthPersistenceReceipt,
  deps: ActivateSetupInferenceDeps,
): Promise<boolean> {
  if (receipt.insertedProfileIds.size === 0) {
    return true;
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
      return true;
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
      return true;
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
  const sessionFile = path.join(tempDir, "session.jsonl");
  const timeoutMs = deps.timeoutMs ?? SETUP_INFERENCE_TEST_TIMEOUT_MS;
  const started = Date.now();
  let successfulAuth: AgentExecutionAuthBinding | undefined;
  try {
    if (plan.runner === "cli") {
      const unsupportedError = resolveToolFreeCliSetupError(plan);
      if (unsupportedError) {
        return { ok: false, status: "unavailable", error: unsupportedError };
      }
    }
    const strictProfileError = resolveStrictSetupAuthProfileError({
      plan,
      workspaceDir: tempDir,
      deps,
    });
    if (strictProfileError) {
      return { ok: false, status: "auth", error: strictProfileError };
    }

    let result: RunResult;
    if (plan.runner === "cli") {
      const runCli = deps.runCliAgent ?? (await import("../agents/cli-runner.js")).runCliAgent;
      result = (await runCli({
        sessionId,
        sessionKey: `temp:setup-inference:${runId}`,
        agentId: plan.agentId ?? "openclaw",
        trigger: "manual",
        sessionFile,
        workspaceDir: tempDir,
        ...(plan.agentDir ? { agentDir: plan.agentDir } : {}),
        config: plan.config,
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
      })) as RunResult;
    } else {
      const runEmbedded =
        deps.runEmbeddedAgent ?? (await import("../agents/embedded-agent.js")).runEmbeddedAgent;
      result = (await runEmbedded({
        sessionId,
        sessionKey: `temp:setup-inference:${runId}`,
        agentId: plan.agentId ?? "openclaw",
        trigger: "manual",
        sessionFile,
        workspaceDir: tempDir,
        ...(plan.agentDir ? { agentDir: plan.agentDir } : {}),
        config: plan.config,
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
        // The 32-token probe cap is sized for the "reply OK" verification
        // prompt only. Custom completions pass no explicit cap: the stream
        // layer then applies the resolved model's own required maxTokens
        // budget, which both bounds output and never exceeds provider limits.
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
      })) as RunResult;
    }
    if (params.signal?.aborted) {
      throw new SetupInferenceCancelledError();
    }
    const terminalError = extractRunTerminalError(result);
    if (terminalError) {
      const described = describeFailoverError(new Error(terminalError));
      return {
        ok: false,
        status: mapFailoverReasonToSetupStatus(described.reason),
        error: described.message,
      };
    }
    const text = extractRunText(result)?.trim();
    if (!text) {
      return {
        ok: false,
        status: "format",
        error: "The model started but did not send a reply. Try again or pick another option.",
      };
    }
    const winnerError = extractRunWinnerError(plan, result);
    if (winnerError) {
      return { ok: false, status: "format", error: winnerError };
    }
    if (requireExecutionOwner && !successfulAuth) {
      return {
        ok: false,
        status: "unknown",
        error:
          "Inference succeeded, but its runtime did not report an owner that OpenClaw can safely reuse.",
      };
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
    return {
      ok: false,
      status: mapFailoverReasonToSetupStatus(described.reason),
      error: described.message,
    };
  }
}
