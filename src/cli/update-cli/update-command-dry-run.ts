import type { MessageParam } from "@openclaw/localization-core";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  type OpenClawDatabaseSchemaPreflight,
} from "../../state/openclaw-database-preflight.js";
import type { CliMessageKey } from "../i18n/locales/en.js";
import { createCliLocalization, type CliLocalization } from "../i18n/runtime.js";
import { resolveGlobalManager } from "./shared.js";
import { hasSchemaRefusal } from "./update-command-git.js";
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

type PreviewEntry = {
  canonical?: string;
  key: CliMessageKey;
  params?: Readonly<Record<string, MessageParam>>;
};

function renderEntry(entry: PreviewEntry, localization: CliLocalization): string {
  return localization.t(entry.key, entry.params);
}

function canonicalEntries(entries: readonly PreviewEntry[]): string[] {
  return entries.flatMap((entry) => (entry.canonical === undefined ? [] : [entry.canonical]));
}

function printDryRunPreview(
  preview: Omit<UpdateDryRunPreview, "actions" | "notes">,
  jsonMode: boolean,
  localization: CliLocalization,
  actions: readonly PreviewEntry[],
  notes: readonly PreviewEntry[],
): void {
  const structuredPreview: UpdateDryRunPreview = {
    ...preview,
    actions: canonicalEntries(actions),
    notes: canonicalEntries(notes),
  };
  if (jsonMode) {
    defaultRuntime.writeJson(structuredPreview);
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
  for (const action of actions) {
    defaultRuntime.log(`  - ${renderEntry(action, localization)}`);
  }

  if (notes.length > 0) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading(localization.t("cli.update.dryRun.notes")));
    for (const note of notes) {
      defaultRuntime.log(`  - ${theme.muted(renderEntry(note, localization))}`);
    }
  }
}

function schemaRefusalEntries(schemas: OpenClawDatabaseSchemaPreflight): PreviewEntry[] {
  if (!hasSchemaRefusal(schemas)) {
    return [];
  }
  const entries: PreviewEntry[] = [];
  for (const database of schemas.incompatible) {
    const agent = database.agentId ? ` (agent ${database.agentId})` : "";
    entries.push({
      canonical: `Would refuse update: ${database.kind} database${agent} ${database.path} has schema ${database.foundVersion}; target supports ${database.supportedVersion}; writer build ${database.writerAppVersion ?? "unknown"}.`,
      key: database.agentId
        ? "cli.update.dryRun.note.schemaIncompatibleAgent"
        : "cli.update.dryRun.note.schemaIncompatible",
      params: {
        kind: database.kind,
        ...(database.agentId ? { agentId: database.agentId } : {}),
        path: database.path,
        foundVersion: database.foundVersion,
        supportedVersion: database.supportedVersion,
        writerVersion: database.writerAppVersion ?? "unknown",
      },
    });
  }
  for (const database of schemas.indeterminate) {
    entries.push({
      canonical: `Would refuse update: could not inspect ${database.kind} database ${database.path}: ${database.reason}; retry once the gateway releases it.`,
      key: "cli.update.dryRun.note.schemaIndeterminate",
      params: { kind: database.kind, path: database.path, reason: database.reason },
    });
  }
  entries.push(
    {
      canonical: OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
      key: "cli.update.dryRun.note.schemaDocs",
      params: { url: OPENCLAW_DATABASE_SCHEMA_DOCS_URL },
    },
    {
      canonical:
        "Installing manually via npm bypasses this guard; back up first and verify compatibility.",
      key: "cli.update.dryRun.note.schemaManualInstall",
    },
  );
  return entries;
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
  managedServiceNodeRunner: string | undefined;
  currentNodeRunner: string;
  cliName: string;
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

  const actions: PreviewEntry[] = [];
  if (params.requestedChannel && params.requestedChannel !== params.storedChannel) {
    actions.push({
      canonical: `Persist update.channel=${params.requestedChannel} in config`,
      key: "cli.update.dryRun.action.persistChannel",
      params: { channel: params.requestedChannel },
    });
  }
  if (params.switchToGit) {
    actions.push({
      canonical: "Switch install mode from package to git checkout (dev channel)",
      key: "cli.update.dryRun.action.switchToGit",
    });
  } else if (params.switchToPackage) {
    actions.push({
      canonical: `Switch install mode from git to package manager (${mode})`,
      key: "cli.update.dryRun.action.switchToPackage",
      params: { mode },
    });
  } else if (params.updateInstallKind === "git") {
    actions.push({
      canonical: `Run git update flow on channel ${params.channel} (fetch/rebase/build/doctor)`,
      key: "cli.update.dryRun.action.gitUpdate",
      params: { channel: params.channel },
    });
  } else if (params.packageAlreadyCurrent) {
    const spec = params.packageInstallSpec ?? params.tag;
    const version = params.targetVersion ?? "unknown";
    actions.push({
      canonical: `Refresh package install with spec ${spec}; current version already matches ${version}`,
      key: "cli.update.dryRun.action.refreshPackage",
      params: { spec, version },
    });
  } else {
    const spec = params.packageInstallSpec ?? params.tag;
    actions.push({
      canonical: `Run global package manager update with spec ${spec}`,
      key: "cli.update.dryRun.action.packageUpdate",
      params: { spec },
    });
  }
  actions.push(
    {
      canonical: "Run plugin update sync after core update",
      key: "cli.update.dryRun.action.plugins",
    },
    {
      canonical: "Refresh shell completion cache (if needed)",
      key: "cli.update.dryRun.action.completion",
    },
    params.shouldRestart
      ? {
          canonical: "Restart gateway service and run doctor checks",
          key: "cli.update.dryRun.action.restart",
        }
      : {
          canonical: "Skip restart (because --no-restart is set)",
          key: "cli.update.dryRun.action.noRestart",
        },
  );

  const notes: PreviewEntry[] = [];
  if (params.opts.tag && params.updateInstallKind === "git") {
    notes.push({
      canonical: "--tag applies to npm installs only; git updates ignore it.",
      key: "cli.update.dryRun.note.gitTag",
    });
  }
  if (params.fallbackToLatest) {
    notes.push({
      canonical: "Beta channel resolves to latest for this run (fallback).",
      key: "cli.update.dryRun.note.betaFallback",
    });
  }
  if (params.managedServiceRootRedirect) {
    const { root, previousRoot } = params.managedServiceRootRedirect;
    notes.push(
      {
        canonical: `Package update targets managed service root ${root} instead of invoking root ${previousRoot}.`,
        key: "cli.update.dryRun.note.managedRootTarget",
        params: { root },
      },
      {
        key: "cli.update.dryRun.note.managedRootDiffers",
        params: { previousRoot },
      },
      {
        key: "cli.update.dryRun.note.managedRootReconcile",
        params: { cli: params.cliName },
      },
    );
    if (params.managedServiceNodeRunner) {
      notes.push({
        key: "cli.update.dryRun.note.managedNode",
        params: { node: params.managedServiceNodeRunner },
      });
    }
  } else if (params.managedServiceNodeRunner) {
    notes.push(
      {
        key: "cli.update.dryRun.note.managedNodeDiffers",
        params: {
          currentNode: params.currentNodeRunner,
          managedNode: params.managedServiceNodeRunner,
        },
      },
      { key: "cli.update.dryRun.note.managedNodeUse" },
    );
  }
  if (params.explicitTag && !canResolveRegistryVersionForPackageTarget(params.tag)) {
    notes.push({
      canonical: "Non-registry package specs skip npm version lookup and downgrade previews.",
      key: "cli.update.dryRun.note.nonRegistry",
    });
  }
  notes.push(...schemaRefusalEntries(params.packageSchemaPreflight));
  if (params.updateInstallKind === "git") {
    notes.push({
      canonical:
        "Database schema compatibility of the git target is verified during the real update; this preview does not check it.",
      key: "cli.update.dryRun.note.gitSchemaCheck",
    });
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
    },
    Boolean(params.opts.json),
    localization,
    actions,
    notes,
  );
}
