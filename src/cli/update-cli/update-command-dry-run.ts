import { theme } from "../../../packages/terminal-core/src/theme.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawDatabaseSchemaPreflight } from "../../state/openclaw-database-preflight.js";
import { createCliLocalization, type CliLocalization } from "../i18n/runtime.js";
import { resolveGlobalManager } from "./shared.js";
import { formatSchemaRefusalLines, hasSchemaRefusal } from "./update-command-git.js";
import type { ManagedServiceRootRedirect } from "./update-command-service.js";

type UpdateDryRunPreview = {
  dryRun: true;
  root: string;
  installKind: "git" | "package" | "unknown";
  mode: UpdateRunResult["mode"];
  updateInstallKind: "git" | "package" | "unknown";
  switchToGit: boolean;
  switchToPackage: boolean;
  restart: boolean;
  requestedChannel: UpdateChannel | null;
  storedChannel: UpdateChannel | null;
  effectiveChannel: UpdateChannel;
  tag: string;
  currentVersion: string | null;
  targetVersion: string | null;
  downgradeRisk: boolean;
  actions: string[];
  notes: string[];
};

function printDryRunPreview(
  preview: UpdateDryRunPreview,
  jsonMode: boolean,
  localization: CliLocalization,
  humanActions: readonly string[],
  humanNotes: readonly string[],
): void {
  if (jsonMode) {
    defaultRuntime.writeJson(preview);
    return;
  }

  defaultRuntime.log(theme.heading(localization.t("cli.update.dryRun.heading")));
  defaultRuntime.log(theme.muted(localization.t("cli.update.dryRun.noChanges")));
  defaultRuntime.log("");
  defaultRuntime.log(`  ${localization.t("cli.update.dryRun.root")}: ${theme.muted(preview.root)}`);
  defaultRuntime.log(
    `  ${localization.t("cli.update.dryRun.installKind")}: ${theme.muted(preview.installKind)}`,
  );
  defaultRuntime.log(`  ${localization.t("cli.update.dryRun.mode")}: ${theme.muted(preview.mode)}`);
  defaultRuntime.log(
    `  ${localization.t("cli.update.dryRun.channel")}: ${theme.muted(preview.effectiveChannel)}`,
  );
  defaultRuntime.log(
    `  ${localization.t("cli.update.dryRun.tagSpec")}: ${theme.muted(preview.tag)}`,
  );
  if (preview.currentVersion) {
    defaultRuntime.log(
      `  ${localization.t("cli.update.dryRun.currentVersion")}: ${theme.muted(preview.currentVersion)}`,
    );
  }
  if (preview.targetVersion) {
    defaultRuntime.log(
      `  ${localization.t("cli.update.dryRun.targetVersion")}: ${theme.muted(preview.targetVersion)}`,
    );
  }
  if (preview.downgradeRisk) {
    defaultRuntime.log(theme.warn(`  ${localization.t("cli.update.dryRun.downgradeWarning")}`));
  }

  defaultRuntime.log("");
  defaultRuntime.log(theme.heading(localization.t("cli.update.dryRun.plannedActions")));
  for (const action of humanActions) {
    defaultRuntime.log(`  - ${action}`);
  }

  if (humanNotes.length > 0) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading(localization.t("cli.update.dryRun.notes")));
    for (const note of humanNotes) {
      defaultRuntime.log(`  - ${theme.muted(note)}`);
    }
  }
}

export async function printUpdateDryRun(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  updateInstallKind: "git" | "package" | "unknown";
  switchToGit: boolean;
  switchToPackage: boolean;
  shouldRestart: boolean;
  requestedChannel: UpdateChannel | null;
  storedChannel: UpdateChannel | null;
  channel: UpdateChannel;
  tag: string;
  packageInstallSpec: string | null;
  currentVersion: string | null;
  targetVersion: string | null;
  downgradeRisk: boolean;
  packageAlreadyCurrent: boolean;
  fallbackToLatest: boolean;
  managedServiceRootRedirect: ManagedServiceRootRedirect | null;
  explicitTag: string | null;
  packageSchemaPreflight: OpenClawDatabaseSchemaPreflight;
  timeoutMs: number;
  opts: { tag?: string; json?: boolean };
}): Promise<void> {
  const localization = createCliLocalization();
  let mode: UpdateRunResult["mode"] = "unknown";
  if (params.updateInstallKind === "git") {
    mode = "git";
  } else if (params.updateInstallKind === "package") {
    mode = await resolveGlobalManager({
      root: params.root,
      installKind: params.installKind,
      timeoutMs: params.timeoutMs,
    });
  }

  const actions: string[] = [];
  const humanActions: string[] = [];
  if (params.requestedChannel && params.requestedChannel !== params.storedChannel) {
    actions.push(`Persist update.channel=${params.requestedChannel} in config`);
    humanActions.push(
      localization.t("cli.update.dryRun.action.persistChannel", {
        channel: params.requestedChannel,
      }),
    );
  }
  if (params.switchToGit) {
    actions.push("Switch install mode from package to git checkout (dev channel)");
    humanActions.push(localization.t("cli.update.dryRun.action.switchToGit"));
  } else if (params.switchToPackage) {
    actions.push(`Switch install mode from git to package manager (${mode})`);
    humanActions.push(localization.t("cli.update.dryRun.action.switchToPackage", { mode }));
  } else if (params.updateInstallKind === "git") {
    actions.push(`Run git update flow on channel ${params.channel} (fetch/rebase/build/doctor)`);
    humanActions.push(
      localization.t("cli.update.dryRun.action.gitUpdate", { channel: params.channel }),
    );
  } else if (params.packageAlreadyCurrent) {
    const spec = params.packageInstallSpec ?? params.tag;
    const version = params.targetVersion ?? "unknown";
    actions.push(
      `Refresh package install with spec ${spec}; current version already matches ${version}`,
    );
    humanActions.push(
      localization.t("cli.update.dryRun.action.refreshPackage", {
        spec,
        version,
      }),
    );
  } else {
    const spec = params.packageInstallSpec ?? params.tag;
    actions.push(`Run global package manager update with spec ${spec}`);
    humanActions.push(localization.t("cli.update.dryRun.action.packageUpdate", { spec }));
  }
  actions.push("Run plugin update sync after core update");
  humanActions.push(localization.t("cli.update.dryRun.action.plugins"));
  actions.push("Refresh shell completion cache (if needed)");
  humanActions.push(localization.t("cli.update.dryRun.action.completion"));
  actions.push(
    params.shouldRestart
      ? "Restart gateway service and run doctor checks"
      : "Skip restart (because --no-restart is set)",
  );
  humanActions.push(
    localization.t(
      params.shouldRestart
        ? "cli.update.dryRun.action.restart"
        : "cli.update.dryRun.action.noRestart",
    ),
  );

  const notes: string[] = [];
  const humanNotes: string[] = [];
  if (params.opts.tag && params.updateInstallKind === "git") {
    const note = "--tag applies to npm installs only; git updates ignore it.";
    notes.push(note);
    humanNotes.push(localization.t("cli.update.dryRun.note.gitTag"));
  }
  if (params.fallbackToLatest) {
    const note = "Beta channel resolves to latest for this run (fallback).";
    notes.push(note);
    humanNotes.push(localization.t("cli.update.dryRun.note.betaFallback"));
  }
  if (params.managedServiceRootRedirect) {
    const { root, previousRoot } = params.managedServiceRootRedirect;
    notes.push(
      `Package update targets managed service root ${root} instead of invoking root ${previousRoot}.`,
    );
    humanNotes.push(localization.t("cli.update.dryRun.note.managedRoot", { root, previousRoot }));
  }
  if (params.explicitTag && !canResolveRegistryVersionForPackageTarget(params.tag)) {
    const note = "Non-registry package specs skip npm version lookup and downgrade previews.";
    notes.push(note);
    humanNotes.push(localization.t("cli.update.dryRun.note.nonRegistry"));
  }
  if (hasSchemaRefusal(params.packageSchemaPreflight)) {
    const schemaNotes = formatSchemaRefusalLines(params.packageSchemaPreflight, true);
    notes.push(...schemaNotes);
    humanNotes.push(...schemaNotes);
  }
  if (params.updateInstallKind === "git") {
    // The git target revision is resolved inside the real update run, so its
    // schema support cannot be previewed here without duplicating that flow.
    const note =
      "Database schema compatibility of the git target is verified during the real update; this preview does not check it.";
    notes.push(note);
    humanNotes.push(localization.t("cli.update.dryRun.note.gitSchemaCheck"));
  }

  printDryRunPreview(
    {
      dryRun: true,
      root: params.root,
      installKind: params.installKind,
      mode,
      updateInstallKind: params.updateInstallKind,
      switchToGit: params.switchToGit,
      switchToPackage: params.switchToPackage,
      restart: params.shouldRestart,
      requestedChannel: params.requestedChannel,
      storedChannel: params.storedChannel,
      effectiveChannel: params.channel,
      tag: params.packageInstallSpec ?? params.tag,
      currentVersion: params.currentVersion,
      targetVersion: params.targetVersion,
      downgradeRisk: params.downgradeRisk,
      actions,
      notes,
    },
    Boolean(params.opts.json),
    localization,
    humanActions,
    humanNotes,
  );
}
