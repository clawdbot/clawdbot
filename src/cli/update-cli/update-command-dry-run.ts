import { theme } from "../../../packages/terminal-core/src/theme.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawDatabaseSchemaPreflight } from "../../state/openclaw-database-preflight.js";
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

function printDryRunPreview(preview: UpdateDryRunPreview, jsonMode: boolean): void {
  if (jsonMode) {
    defaultRuntime.writeJson(preview);
    return;
  }

  defaultRuntime.log(theme.heading("Update dry-run"));
  defaultRuntime.log(theme.muted("No changes were applied."));
  defaultRuntime.log("");
  defaultRuntime.log(`  Root: ${theme.muted(preview.root)}`);
  defaultRuntime.log(`  Install kind: ${theme.muted(preview.installKind)}`);
  defaultRuntime.log(`  Mode: ${theme.muted(preview.mode)}`);
  defaultRuntime.log(`  Channel: ${theme.muted(preview.effectiveChannel)}`);
  defaultRuntime.log(`  Tag/spec: ${theme.muted(preview.tag)}`);
  if (preview.currentVersion) {
    defaultRuntime.log(`  Current version: ${theme.muted(preview.currentVersion)}`);
  }
  if (preview.targetVersion) {
    defaultRuntime.log(`  Target version: ${theme.muted(preview.targetVersion)}`);
  }
  if (preview.downgradeRisk) {
    defaultRuntime.log(theme.warn("  Downgrade confirmation would be required in a real run."));
  }

  defaultRuntime.log("");
  defaultRuntime.log(theme.heading("Planned actions:"));
  for (const action of preview.actions) {
    defaultRuntime.log(`  - ${action}`);
  }

  if (preview.notes.length > 0) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Notes:"));
    for (const note of preview.notes) {
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
  if (params.requestedChannel && params.requestedChannel !== params.storedChannel) {
    actions.push(`Persist update.channel=${params.requestedChannel} in config`);
  }
  if (params.switchToGit) {
    actions.push("Switch install mode from package to git checkout (dev channel)");
  } else if (params.switchToPackage) {
    actions.push(`Switch install mode from git to package manager (${mode})`);
  } else if (params.updateInstallKind === "git") {
    actions.push(`Run git update flow on channel ${params.channel} (fetch/rebase/build/doctor)`);
  } else if (params.packageAlreadyCurrent) {
    actions.push(
      `Refresh package install with spec ${params.packageInstallSpec ?? params.tag}; current version already matches ${params.targetVersion}`,
    );
  } else {
    actions.push(
      `Run global package manager update with spec ${params.packageInstallSpec ?? params.tag}`,
    );
  }
  actions.push("Run plugin update sync after core update");
  actions.push("Refresh shell completion cache (if needed)");
  actions.push(
    params.shouldRestart
      ? "Restart gateway service and run doctor checks"
      : "Skip restart (because --no-restart is set)",
  );

  const notes: string[] = [];
  if (params.opts.tag && params.updateInstallKind === "git") {
    notes.push("--tag applies to npm installs only; git updates ignore it.");
  }
  if (params.fallbackToLatest) {
    notes.push("Beta channel resolves to latest for this run (fallback).");
  }
  if (params.managedServiceRootRedirect) {
    notes.push(
      `Package update targets managed service root ${params.managedServiceRootRedirect.root} instead of invoking root ${params.managedServiceRootRedirect.previousRoot}.`,
    );
  }
  if (params.explicitTag && !canResolveRegistryVersionForPackageTarget(params.tag)) {
    notes.push("Non-registry package specs skip npm version lookup and downgrade previews.");
  }
  if (hasSchemaRefusal(params.packageSchemaPreflight)) {
    notes.push(...formatSchemaRefusalLines(params.packageSchemaPreflight, true));
  }
  if (params.updateInstallKind === "git") {
    // The git target revision is resolved inside the real update run, so its
    // schema support cannot be previewed here without duplicating that flow.
    notes.push(
      "Database schema compatibility of the git target is verified during the real update; this preview does not check it.",
    );
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
  );
}
