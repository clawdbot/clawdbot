import { formatCliCommand } from "../cli/command-format.js";
import { findLegacyConfigIssues } from "../config/legacy.js";
import { CONFIG_PATH } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { noteOpencodeProviderOverrides } from "./doctor-config-analysis.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { normalizeCompatibilityConfigValues } from "./doctor-legacy-config.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";
import { emitDoctorNotes, sanitizeDoctorNote } from "./doctor/emit-notes.js";
import { finalizeDoctorConfigFlow } from "./doctor/finalize-config-flow.js";
import {
  applyLegacyCompatibilityStep,
  applyUnknownConfigKeyStep,
} from "./doctor/shared/config-flow-steps.js";
import { applyDoctorConfigMutation } from "./doctor/shared/config-mutation-state.js";
import {
  collectMissingDefaultAccountBindingWarnings,
  collectMissingExplicitDefaultAccountWarnings,
} from "./doctor/shared/default-account-warnings.js";

function hasLegacyInternalHookHandlers(raw: unknown): boolean {
  const handlers = (raw as { hooks?: { internal?: { handlers?: unknown } } })?.hooks?.internal
    ?.handlers;
  return Array.isArray(handlers) && handlers.length > 0;
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

export async function loadAndMaybeMigrateDoctorConfig(params: {
  options: DoctorOptions;
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
  runtime?: RuntimeEnv;
  prompter?: DoctorPrompter;
}) {
  const shouldRepair = params.options.repair === true || params.options.yes === true;
  const preflight = await runDoctorConfigPreflight({ repairPrefixedConfig: shouldRepair });
  let snapshot = preflight.snapshot;
  const baseCfg = preflight.baseConfig;
  let cfg: OpenClawConfig = baseCfg;
  let candidate = structuredClone(baseCfg);
  let pendingChanges = false;
  let fixHints: string[] = [];
  const doctorFixCommand = formatCliCommand("openclaw doctor --fix");

  const legacyStep = applyLegacyCompatibilityStep({
    snapshot,
    state: { cfg, candidate, pendingChanges, fixHints },
    shouldRepair,
    doctorFixCommand,
  });
  ({ cfg, candidate, pendingChanges, fixHints } = legacyStep.state);
  const pluginLegacyIssues = await (async () => {
    if (snapshot.parsed === snapshot.sourceConfig) {
      return [];
    }
    const { collectRelevantDoctorPluginIds, listPluginDoctorLegacyConfigRules } =
      await import("../plugins/doctor-contract-registry.js");
    return findLegacyConfigIssues(
      snapshot.parsed,
      snapshot.parsed,
      listPluginDoctorLegacyConfigRules({
        pluginIds: collectRelevantDoctorPluginIds(snapshot.parsed),
      }),
    );
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
    !fixHints.includes(`Run "${doctorFixCommand}" to migrate legacy config keys.`)
  ) {
    fixHints = [...fixHints, `Run "${doctorFixCommand}" to migrate legacy config keys.`];
  }
  if (legacyIssueLines.length > 0) {
    note(legacyIssueLines.join("\n"), "Legacy config keys detected");
  }
  if (legacyStep.changeLines.length > 0) {
    note(legacyStep.changeLines.join("\n"), "Doctor changes");
  }
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

  const normalized = normalizeCompatibilityConfigValues(candidate);
  if (normalized.changes.length > 0) {
    note(normalized.changes.join("\n"), "Doctor changes");
    ({ cfg, candidate, pendingChanges, fixHints } = applyDoctorConfigMutation({
      state: { cfg, candidate, pendingChanges, fixHints },
      mutation: normalized,
      shouldRepair,
      fixHint: `Run "${doctorFixCommand}" to apply these changes.`,
    }));
  }

  const { applyPluginAutoEnable } = await import("../config/plugin-auto-enable.js");
  const autoEnable = applyPluginAutoEnable({ config: candidate, env: process.env });
  if (autoEnable.changes.length > 0) {
    note(autoEnable.changes.join("\n"), "Doctor changes");
    ({ cfg, candidate, pendingChanges, fixHints } = applyDoctorConfigMutation({
      state: { cfg, candidate, pendingChanges, fixHints },
      mutation: autoEnable,
      shouldRepair,
      fixHint: `Run "${doctorFixCommand}" to apply these changes.`,
    }));
  }

  const { collectPluginToolAllowlistWarnings } =
    await import("./doctor/shared/plugin-tool-allowlist-warnings.js");
  const pluginToolAllowlistWarnings = collectPluginToolAllowlistWarnings({
    cfg: candidate,
    env: process.env,
  });
  if (pluginToolAllowlistWarnings.length > 0) {
    note(sanitizeDoctorNote(pluginToolAllowlistWarnings.join("\n")), "Doctor warnings");
  }

  const hasConfiguredChannels = collectConfiguredChannelIds(candidate).length > 0;
  let collectMutableAllowlistWarnings:
    | typeof import("./doctor/shared/channel-doctor.js").collectChannelDoctorMutableAllowlistWarnings
    | undefined;
  if (hasConfiguredChannels) {
    const channelDoctor = await import("./doctor/shared/channel-doctor.js");
    collectMutableAllowlistWarnings = channelDoctor.collectChannelDoctorMutableAllowlistWarnings;
    const channelDoctorSequence = await channelDoctor.runChannelDoctorConfigSequences({
      cfg: candidate,
      env: process.env,
      shouldRepair,
    });
    emitDoctorNotes({
      note,
      changeNotes: channelDoctorSequence.changeNotes,
      warningNotes: channelDoctorSequence.warningNotes,
    });

    for (const staleCleanup of await channelDoctor.collectChannelDoctorStaleConfigMutations(
      candidate,
      { env: process.env },
    )) {
      if (staleCleanup.changes.length === 0) {
        continue;
      }
      note(sanitizeDoctorNote(staleCleanup.changes.join("\n")), "Doctor changes");
      ({ cfg, candidate, pendingChanges, fixHints } = applyDoctorConfigMutation({
        state: { cfg, candidate, pendingChanges, fixHints },
        mutation: staleCleanup,
        shouldRepair,
        fixHint: `Run "${doctorFixCommand}" to remove stale channel plugin references.`,
      }));
    }
  }

  const missingDefaultAccountBindingWarnings =
    collectMissingDefaultAccountBindingWarnings(candidate);
  if (missingDefaultAccountBindingWarnings.length > 0) {
    note(missingDefaultAccountBindingWarnings.join("\n"), "Doctor warnings");
  }
  const missingExplicitDefaultWarnings = collectMissingExplicitDefaultAccountWarnings(candidate);
  if (missingExplicitDefaultWarnings.length > 0) {
    note(missingExplicitDefaultWarnings.join("\n"), "Doctor warnings");
  }

  if (shouldRepair) {
    const { runDoctorRepairSequence } = await import("./doctor/repair-sequencing.js");
    const repairSequence = await runDoctorRepairSequence({
      state: { cfg, candidate, pendingChanges, fixHints },
      doctorFixCommand,
      env: process.env,
    });
    ({ cfg, candidate, pendingChanges, fixHints } = repairSequence.state);
    emitDoctorNotes({
      note,
      changeNotes: repairSequence.changeNotes,
      warningNotes: repairSequence.warningNotes,
    });
  } else {
    const { collectDoctorPreviewWarnings } = await import("./doctor/shared/preview-warnings.js");
    emitDoctorNotes({
      note,
      warningNotes: await collectDoctorPreviewWarnings({
        cfg: candidate,
        doctorFixCommand,
        env: process.env,
      }),
    });
  }

  const mutableAllowlistWarnings = collectMutableAllowlistWarnings
    ? await collectMutableAllowlistWarnings({
        cfg: candidate,
        env: process.env,
      })
    : [];
  if (mutableAllowlistWarnings.length > 0) {
    note(sanitizeDoctorNote(mutableAllowlistWarnings.join("\n")), "Doctor warnings");
  }

  const unknownStep = applyUnknownConfigKeyStep({
    state: { cfg, candidate, pendingChanges, fixHints },
    shouldRepair,
    doctorFixCommand,
  });
  ({ cfg, candidate, pendingChanges, fixHints } = unknownStep.state);
  if (unknownStep.removed.length > 0) {
    const lines = unknownStep.removed.map((path) => `- ${path}`).join("\n");
    note(lines, shouldRepair ? "Doctor changes" : "Unknown config keys");
  }

  const finalized = await finalizeDoctorConfigFlow({
    cfg,
    candidate,
    pendingChanges,
    shouldRepair,
    fixHints,
    confirm: params.confirm,
    note,
  });
  cfg = finalized.cfg;

  noteOpencodeProviderOverrides(cfg);

  return {
    cfg,
    path: snapshot.path ?? CONFIG_PATH,
    shouldWriteConfig: finalized.shouldWriteConfig,
    sourceConfigValid: snapshot.valid,
  };
}
