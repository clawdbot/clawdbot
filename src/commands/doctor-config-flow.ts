/** Main doctor config flow: preflight, migrations, previews, repairs, and final write decision. */
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { readAgentRosterProperty } from "../agents/agent-scope-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { configIncludeOwnsAgentRoster } from "../config/agent-roster-provenance.js";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import { CONFIG_PATH } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  noteImplicitFallbackClobberWarnings,
  noteOpencodeProviderOverrides,
  noteSandboxOriginProxyWarning,
} from "./doctor-config-analysis.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";
import { cronCodexRuntimePolicyTargetKey } from "./doctor/cron/store-migration.js";
import { emitDoctorNotes, sanitizeDoctorNote } from "./doctor/emit-notes.js";
import { finalizeDoctorConfigFlow } from "./doctor/finalize-config-flow.js";
import {
  applyLegacyCompatibilityStep,
  applyUnknownConfigKeyStep,
} from "./doctor/shared/config-flow-steps.js";
import {
  applyDoctorConfigMutation,
  type DoctorConfigMutationResult,
  type DoctorConfigMutationState,
} from "./doctor/shared/config-mutation-state.js";
import { materializeDefaultAgentRoles } from "./doctor/shared/default-agent-role-materialization.js";
import { isSingleTopLevelIncludeMigration } from "./doctor/shared/include-migration-ownership.js";
import { normalizeCompatibilityConfigValues } from "./doctor/shared/legacy-config-core-migrate.js";

function hasLegacyInternalHookHandlers(raw: unknown): boolean {
  const handlers = (raw as { hooks?: { internal?: { handlers?: unknown } } })?.hooks?.internal
    ?.handlers;
  return Array.isArray(handlers) && handlers.length > 0;
}

function collectInvalidHookTransformsDirWarnings(
  cfg: OpenClawConfig,
  configPath: string,
): string[] {
  const transformsDir = cfg.hooks?.transformsDir?.trim();
  if (!transformsDir) {
    return [];
  }
  const configDir = path.dirname(configPath);
  const transformsRoot = path.join(configDir, "hooks", "transforms");
  const resolved = path.isAbsolute(transformsDir)
    ? path.resolve(transformsDir)
    : path.resolve(transformsRoot, transformsDir);
  const relative = path.relative(transformsRoot, resolved);
  const escapesRoot =
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (!escapesRoot) {
    return [];
  }
  return [
    `- hooks.transformsDir: ${transformsDir} is outside ${transformsRoot}. Hook transform modules must live under ${transformsRoot}; move custom transforms there or remove hooks.transformsDir.`,
  ];
}

function collectUnsupportedInternalHookEntryWarnings(cfg: OpenClawConfig): string[] {
  const entries = cfg.hooks?.internal?.entries;
  if (!entries) {
    return [];
  }
  const unsupportedKeysByEntry = Object.entries(entries)
    .filter(([, entry]) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map(([hookKey, entry]) => {
      const unsupportedKeys = ["handler", "module", "extraDirs", "installs"].filter((key) =>
        Object.hasOwn(entry, key),
      );
      return { hookKey, unsupportedKeys };
    })
    .filter(({ unsupportedKeys }) => unsupportedKeys.length > 0);

  if (unsupportedKeysByEntry.length === 0) {
    return [];
  }

  return unsupportedKeysByEntry.map(
    ({ hookKey, unsupportedKeys }) =>
      `- hooks.internal.entries.${hookKey}: unsupported loader key${unsupportedKeys.length === 1 ? "" : "s"} ${unsupportedKeys.join(", ")} will not load hook modules. Use bootstrap-extra-files for session bootstrap content, or create a managed/workspace hook directory with HOOK.md + handler.js. Doctor cannot rewrite this automatically because per-hook entry keys are open-ended hook configuration.`,
  );
}

function collectConfiguredChannelIds(cfg: OpenClawConfig): string[] {
  const channels =
    cfg.channels && typeof cfg.channels === "object" && !Array.isArray(cfg.channels)
      ? cfg.channels
      : null;
  if (!channels) {
    return [];
  }
  return Object.keys(channels).filter((channelId) => channelId !== "defaults");
}

// Past-tense "Removed X" lines must not appear under a "Doctor changes" panel
// when the run did not write to disk; retitle to signal the preview state.
function emitDoctorChangesPanel(
  changeLines: ReadonlyArray<string>,
  shouldRepair: boolean,
  options: { sanitize?: boolean } = {},
): void {
  if (changeLines.length === 0) {
    return;
  }
  const body = changeLines.join("\n");
  const message = options.sanitize ? sanitizeDoctorNote(body) : body;
  const title = shouldRepair ? "Doctor changes" : "Doctor changes preview";
  note(message, title);
}

async function refreshGatewayAuthStateAfterAuthProfileRepair(): Promise<void> {
  try {
    await callGateway({
      method: "secrets.reload",
      params: {},
      timeoutMs: 3000,
    });
  } catch {
    // Best-effort only: doctor --fix must still succeed when no gateway is running
    // or the live gateway cannot reload unrelated secret-backed channels.
  }
  try {
    await callGateway({
      method: "models.authStatus",
      params: { refresh: true },
      timeoutMs: 3000,
    });
  } catch {
    // Best-effort only: doctor --fix must still succeed when no gateway is running.
  }
}

/**
 * Loads config, runs doctor migrations/repairs, and returns the config write plan.
 *
 * This is the config-side orchestration boundary for doctor; it keeps preview notes, repair
 * mutations, gateway auth refreshes, and final write confirmation in one ordered flow.
 */
export async function loadAndMaybeMigrateDoctorConfig(params: {
  options: DoctorOptions;
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
  runtime?: RuntimeEnv;
  prompter?: DoctorPrompter;
}) {
  const shouldRepair = params.options.repair === true || params.options.yes === true;
  const preflight = await runDoctorConfigPreflight({
    repairPrefixedConfig: shouldRepair,
    recoverCorruptTargetStore: shouldRepair,
    doctorOnlyStateMigrations: shouldRepair,
  });
  const snapshot = preflight.snapshot;
  const baseCfg = preflight.baseConfig;
  let state: DoctorConfigMutationState = {
    cfg: baseCfg,
    candidate: structuredClone(baseCfg),
    pendingChanges: false,
    fixHints: [],
  };
  const explicitSetPaths: string[][] = [];
  let shouldRepairCronCodexModelRefsAfterConfigWrite = false;
  let openAICodexAuthProfileIdMap: ReadonlyMap<string, string> | undefined;
  const doctorFixCommand = formatCliCommand("openclaw doctor --fix");
  const applyConfigMutation = (
    mutation: DoctorConfigMutationResult & { warnings?: string[] },
    options: { fixHint: string; sanitize?: boolean; emitWarnings?: boolean },
  ): void => {
    emitDoctorChangesPanel(
      mutation.changes,
      shouldRepair,
      options.sanitize ? { sanitize: true } : {},
    );
    if (options.emitWarnings && mutation.warnings?.length) {
      emitDoctorNotes({ note, warningNotes: mutation.warnings });
    }
    state = applyDoctorConfigMutation({
      state,
      mutation,
      shouldRepair,
      fixHint: options.fixHint,
    });
  };
  const sourceMeta = (snapshot.sourceConfig as { meta?: { lastTouchedVersion?: unknown } })?.meta;
  const sourceLastTouchedVersion =
    typeof sourceMeta?.lastTouchedVersion === "string" ? sourceMeta.lastTouchedVersion : undefined;

  const legacyStep = applyLegacyCompatibilityStep({
    snapshot,
    state,
    shouldRepair,
    doctorFixCommand,
  });
  state = legacyStep.state;
  const legacyMigrationPartiallyValid = legacyStep.partiallyValid === true;
  const legacyMigrationBlocksWrite = legacyStep.blocksWrite === true;
  const rosterMigrationNeeded = [snapshot.sourceConfigBeforeMigrations, snapshot.parsed].some(
    (source) => source !== undefined && migratePersistedImplicitMainRoster(source).changed,
  );
  const includeOwnsRoster = configIncludeOwnsAgentRoster(snapshot);
  if (snapshot.exists && rosterMigrationNeeded && !includeOwnsRoster) {
    // Runtime roster normalization is read-only; doctor --fix owns persistence.
    const migrated = migratePersistedImplicitMainRoster(state.candidate).config as OpenClawConfig;
    const migratedRoster = readAgentRosterProperty(migrated);
    const migratedEntries = migratedRoster?.kind === "entries" ? migratedRoster.value : undefined;
    const { list: _legacyList, ...candidateAgents } = state.candidate.agents ?? {};
    const rosterRepair = {
      config: {
        ...state.candidate,
        agents: {
          ...candidateAgents,
          entries: migratedEntries as NonNullable<OpenClawConfig["agents"]>["entries"],
        },
      },
      changes: ["Prepared agents.entries with exactly one explicit default agent for persistence."],
    };
    applyConfigMutation(rosterRepair, {
      fixHint: `Run "${doctorFixCommand}" to persist the explicit agent roster.`,
    });
    // Read-time normalization already exposes this roster in the runtime shape.
    // Preserve doctor's write intent so the atomic writer does not restore the authored omission.
    explicitSetPaths.push(["agents", "entries"]);
  }
  applyConfigMutation(materializeDefaultAgentRoles(state.candidate), {
    fixHint: `Run "${doctorFixCommand}" to persist explicit ambient agent targets.`,
  });
  const { collectBlockedLegacyOpenAICodexProviderPlan } =
    await import("./doctor/shared/legacy-config-migrations.runtime.models.js");
  const blockedCodexProviderPlan = collectBlockedLegacyOpenAICodexProviderPlan(state.candidate);
  const blockedCodexModelIdentities = new Set(blockedCodexProviderPlan.blockedModelIdentities);
  if (preflight.cronCodexRuntimePolicyTargets?.length) {
    const { repairCronCodexRuntimePolicies } =
      await import("./doctor/cron/runtime-policy-migration.js");
    const cronRuntimeRepair = repairCronCodexRuntimePolicies({
      cfg: state.candidate,
      targets: preflight.cronCodexRuntimePolicyTargets,
      blockedModelIdentities: blockedCodexModelIdentities,
    });
    applyConfigMutation(cronRuntimeRepair, {
      fixHint: `Run "${doctorFixCommand}" to preserve migrated cron runtime policy.`,
      emitWarnings: true,
    });
    const blockedTargets = new Set(
      cronRuntimeRepair.blockedTargets.map(cronCodexRuntimePolicyTargetKey),
    );
    shouldRepairCronCodexModelRefsAfterConfigWrite = preflight.cronCodexRuntimePolicyTargets.some(
      (target) => !blockedTargets.has(cronCodexRuntimePolicyTargetKey(target)),
    );
  }
  const pluginLegacyIssues = await (async () => {
    if (snapshot.parsed === snapshot.sourceConfig) {
      return [];
    }
    const { findDoctorLegacyConfigIssues } =
      await import("./doctor/shared/legacy-config-issues.js");
    return findDoctorLegacyConfigIssues(snapshot.parsed, snapshot.parsed);
  })();
  const seenLegacyIssues = new Set(
    snapshot.legacyIssues.map((issue) => `${issue.path}:${issue.message}`),
  );
  const pluginIssueLines = pluginLegacyIssues
    .filter((issue) => {
      const key = `${issue.path}:${issue.message}`;
      if (seenLegacyIssues.has(key)) {
        return false;
      }
      seenLegacyIssues.add(key);
      return true;
    })
    .map((issue) => `- ${issue.path}: ${issue.message}`);
  const legacyIssueLines = [...legacyStep.issueLines, ...pluginIssueLines];
  if (
    pluginIssueLines.length > 0 &&
    !shouldRepair &&
    !state.fixHints.includes(`Run "${doctorFixCommand}" to migrate legacy config keys.`)
  ) {
    state.fixHints.push(`Run "${doctorFixCommand}" to migrate legacy config keys.`);
  }
  if (legacyIssueLines.length > 0) {
    note(legacyIssueLines.join("\n"), "Legacy config keys detected");
  }
  emitDoctorChangesPanel(legacyStep.changeLines, shouldRepair);
  if (hasLegacyInternalHookHandlers(snapshot.parsed)) {
    note(
      [
        "- hooks.internal.handlers: legacy inline hook modules are no longer part of the public config surface.",
        "- Migrate each entry to a managed or workspace hook directory with HOOK.md + handler.js, then enable it through hooks.internal.entries.<hookKey> as needed.",
        "- openclaw doctor --fix does not rewrite this shape automatically.",
      ].join("\n"),
      "Legacy config keys detected",
    );
  }
  const hookTransformsDirWarnings = collectInvalidHookTransformsDirWarnings(
    state.cfg,
    snapshot.path,
  );
  if (hookTransformsDirWarnings.length > 0) {
    note(sanitizeDoctorNote(hookTransformsDirWarnings.join("\n")), "Doctor warnings");
  }
  const unsupportedInternalHookEntryWarnings = collectUnsupportedInternalHookEntryWarnings(
    state.cfg,
  );
  if (unsupportedInternalHookEntryWarnings.length > 0) {
    note(sanitizeDoctorNote(unsupportedInternalHookEntryWarnings.join("\n")), "Doctor warnings");
  }

  // Parsed config supplies invalid-key evidence only; migrations still mutate the
  // include/env-resolved candidate so doctor never writes unresolved source values.
  const normalized = normalizeCompatibilityConfigValues(state.candidate, {
    blockedModelIdentities: blockedCodexModelIdentities,
    sourceRaw: snapshot.parsed,
  });
  applyConfigMutation(normalized, {
    fixHint: `Run "${doctorFixCommand}" to apply these changes.`,
  });

  const { prepareRetiredPhoneControlCleanup } = await import("./doctor-retired-phone-control.js");
  const retiredPhoneControlCleanup = await prepareRetiredPhoneControlCleanup({
    cfg: state.candidate,
    env: process.env,
  });
  applyConfigMutation(
    {
      config: retiredPhoneControlCleanup.config,
      changes: retiredPhoneControlCleanup.configChanges,
      warnings: retiredPhoneControlCleanup.warnings,
    },
    {
      fixHint: `Run "${doctorFixCommand}" to retire Phone Control lease configuration.`,
      emitWarnings: true,
    },
  );
  if (retiredPhoneControlCleanup.cleanupPending && !shouldRepair) {
    note(
      `Retired Phone Control lease state remains. Run "${doctorFixCommand}" to archive it.`,
      "Legacy state detected",
    );
  }

  const pluginActivationSourceConfig = state.candidate;
  const { applyPluginAutoEnable } = await import("../config/plugin-auto-enable.js");
  applyConfigMutation(applyPluginAutoEnable({ config: state.candidate, env: process.env }), {
    fixHint: `Run "${doctorFixCommand}" to apply these changes.`,
  });

  if (!shouldRepair) {
    const { repairStaleAgentModelRefs } =
      await import("./doctor/shared/stale-agent-model-ref-repair.js");
    const staleAgentModelRepair = repairStaleAgentModelRefs(state.candidate, { env: process.env });
    applyConfigMutation(staleAgentModelRepair, {
      fixHint: `Run "${doctorFixCommand}" to remove stale agent model references.`,
      sanitize: true,
      emitWarnings: true,
    });
  }

  const { collectPluginToolAllowlistWarnings } =
    await import("./doctor/shared/plugin-tool-allowlist-warnings.js");
  const pluginToolAllowlistWarnings = collectPluginToolAllowlistWarnings({
    cfg: state.candidate,
    env: process.env,
  });
  if (pluginToolAllowlistWarnings.length > 0) {
    note(sanitizeDoctorNote(pluginToolAllowlistWarnings.join("\n")), "Doctor warnings");
  }

  const hasConfiguredChannels = collectConfiguredChannelIds(state.candidate).length > 0;
  let collectMutableAllowlistWarnings:
    | typeof import("./doctor/shared/channel-doctor.js").collectChannelDoctorMutableAllowlistWarnings
    | undefined;
  if (hasConfiguredChannels) {
    const channelDoctor = await import("./doctor/shared/channel-doctor.js");
    collectMutableAllowlistWarnings = channelDoctor.collectChannelDoctorMutableAllowlistWarnings;
    const channelDoctorSequence = await channelDoctor.runChannelDoctorConfigSequences({
      cfg: state.candidate,
      env: process.env,
      shouldRepair,
    });
    emitDoctorNotes({
      note,
      changeNotes: channelDoctorSequence.changeNotes,
      warningNotes: channelDoctorSequence.warningNotes,
    });

    for (const staleCleanup of await channelDoctor.collectChannelDoctorStaleConfigMutations(
      state.candidate,
      { env: process.env },
    )) {
      applyConfigMutation(staleCleanup, {
        fixHint: `Run "${doctorFixCommand}" to remove stale channel plugin references.`,
        sanitize: true,
      });
    }
  }

  const { repairHooksTokenReuseGatewayAuth } =
    await import("./doctor/shared/hooks-token-reuse-repair.js");
  applyConfigMutation(await repairHooksTokenReuseGatewayAuth(state.candidate, process.env), {
    fixHint: `Run "${doctorFixCommand}" to rotate hooks.token away from Gateway auth.`,
  });

  if (shouldRepair) {
    const { runDoctorRepairSequence } = await import("./doctor/repair-sequencing.js");
    const repairSequence = await runDoctorRepairSequence({
      state,
      doctorFixCommand,
      env: process.env,
      blockedCodexProviderPlan,
    });
    state = repairSequence.state;
    openAICodexAuthProfileIdMap = repairSequence.openAICodexAuthProfileIdMap;
    if (repairSequence.authProfilesRepaired) {
      await refreshGatewayAuthStateAfterAuthProfileRepair();
    }
    emitDoctorNotes({
      note,
      changeNotes: repairSequence.changeNotes,
      warningNotes: repairSequence.warningNotes,
    });
  } else {
    const { collectDoctorPreviewNotes } = await import("./doctor/shared/preview-warnings.js");
    const previewNotes = await collectDoctorPreviewNotes({
      cfg: state.candidate,
      activationSourceConfig: pluginActivationSourceConfig,
      doctorFixCommand,
      env: process.env,
      allowExec: params.options.allowExec === true,
      blockedCodexProviderPlan,
    });
    emitDoctorNotes({
      note,
      infoNotes: previewNotes.infoNotes,
      warningNotes: previewNotes.warningNotes,
    });
  }

  const mutableAllowlistWarnings = collectMutableAllowlistWarnings
    ? await collectMutableAllowlistWarnings({
        cfg: state.candidate,
        env: process.env,
      })
    : [];
  if (mutableAllowlistWarnings.length > 0) {
    note(sanitizeDoctorNote(mutableAllowlistWarnings.join("\n")), "Doctor warnings");
  }

  const unknownStep = applyUnknownConfigKeyStep({
    state,
    shouldRepair,
    doctorFixCommand,
  });
  state = unknownStep.state;
  if (unknownStep.removed.length > 0 || unknownStep.repairs.length > 0) {
    const lines = [
      ...unknownStep.removed.map((pathLocal) => `- ${pathLocal}`),
      ...unknownStep.repairs.map((change) => `- ${change}`),
    ].join("\n");
    note(lines, shouldRepair ? "Doctor changes" : "Unknown config keys");
  }
  if (unknownStep.warnings.length > 0) {
    note(unknownStep.warnings.join("\n"), "Doctor warnings");
  }

  const finalized = await finalizeDoctorConfigFlow({
    cfg: state.cfg,
    candidate: state.candidate,
    pendingChanges: state.pendingChanges,
    shouldRepair,
    fixHints: state.fixHints,
    confirm: params.confirm,
    note,
  });
  const cfg = finalized.cfg;
  const shouldWriteConfig = finalized.shouldWriteConfig && !legacyMigrationBlocksWrite;
  const singleTopLevelIncludeWrite =
    shouldWriteConfig &&
    isSingleTopLevelIncludeMigration({
      parsed: snapshot.parsed,
      sourceConfig: snapshot.sourceConfig,
      candidate: cfg,
    });

  const configuredOpencodePluginIds = [
    cfg.models?.providers?.opencode || cfg.models?.providers?.["opencode-zen"]
      ? "opencode"
      : undefined,
    cfg.models?.providers?.["opencode-go"] ? "opencode-go" : undefined,
  ].filter((pluginId): pluginId is string => pluginId !== undefined);
  const activeOpencodePluginIds =
    configuredOpencodePluginIds.length > 0
      ? (await import("../plugins/providers.js")).resolveEnabledProviderPluginIds({
          config: cfg,
          onlyPluginIds: configuredOpencodePluginIds,
        })
      : [];
  noteOpencodeProviderOverrides(cfg, {
    opencodePluginActive: activeOpencodePluginIds.includes("opencode"),
    opencodeGoPluginActive: activeOpencodePluginIds.includes("opencode-go"),
  });
  noteImplicitFallbackClobberWarnings(cfg);
  noteSandboxOriginProxyWarning(cfg);

  return {
    cfg,
    path: snapshot.path ?? CONFIG_PATH,
    shouldWriteConfig,
    sourceConfigValid: snapshot.valid,
    ...(sourceLastTouchedVersion ? { sourceLastTouchedVersion } : {}),
    ...(legacyMigrationPartiallyValid ? { skipPluginValidationOnWrite: true } : {}),
    ...(shouldWriteConfig && explicitSetPaths.length > 0 ? { explicitSetPaths } : {}),
    ...(singleTopLevelIncludeWrite ? { skipWizardMetadataForIncludeWrite: true } : {}),
    ...(shouldRepairCronCodexModelRefsAfterConfigWrite
      ? { shouldRepairCronCodexModelRefsAfterConfigWrite: true }
      : {}),
    ...(shouldRepair &&
    retiredPhoneControlCleanup.cleanupPending &&
    retiredPhoneControlCleanup.cleanupSafe
      ? { retiredPhoneControlStateCleanupPending: true }
      : {}),
    ...(blockedCodexProviderPlan.blockedModelIdentities.length > 0
      ? { blockedCodexModelIdentities: blockedCodexProviderPlan.blockedModelIdentities }
      : {}),
    ...(openAICodexAuthProfileIdMap?.size ? { openAICodexAuthProfileIdMap } : {}),
  };
}
