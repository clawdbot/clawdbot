import type { LocalizationCatalog } from "@openclaw/localization-core";

export const CLI_ENGLISH_CATALOG = {
  "cli.update.dryRun.heading": "Update dry-run",
  "cli.update.dryRun.noChanges": "No changes were applied.",
  "cli.update.dryRun.root": "Root",
  "cli.update.dryRun.installKind": "Install kind",
  "cli.update.dryRun.mode": "Mode",
  "cli.update.dryRun.channel": "Channel",
  "cli.update.dryRun.tagSpec": "Tag/spec",
  "cli.update.dryRun.currentVersion": "Current version",
  "cli.update.dryRun.targetVersion": "Target version",
  "cli.update.dryRun.downgradeWarning": "Downgrade confirmation would be required in a real run.",
  "cli.update.dryRun.plannedActions": "Planned actions:",
  "cli.update.dryRun.notes": "Notes:",
  "cli.update.dryRun.action.persistChannel": "Persist update.channel={channel} in config",
  "cli.update.dryRun.action.switchToGit":
    "Switch install mode from package to git checkout (dev channel)",
  "cli.update.dryRun.action.switchToPackage":
    "Switch install mode from git to package manager ({mode})",
  "cli.update.dryRun.action.gitUpdate":
    "Run git update flow on channel {channel} (fetch/rebase/build/doctor)",
  "cli.update.dryRun.action.refreshPackage":
    "Refresh package install with spec {spec}; current version already matches {version}",
  "cli.update.dryRun.action.packageUpdate": "Run global package manager update with spec {spec}",
  "cli.update.dryRun.action.plugins": "Run plugin update sync after core update",
  "cli.update.dryRun.action.completion": "Refresh shell completion cache (if needed)",
  "cli.update.dryRun.action.restart": "Restart gateway service and run doctor checks",
  "cli.update.dryRun.action.noRestart": "Skip restart (because --no-restart is set)",
  "cli.update.dryRun.note.gitTag": "--tag applies to npm installs only; git updates ignore it.",
  "cli.update.dryRun.note.betaFallback": "Beta channel resolves to latest for this run (fallback).",
  "cli.update.dryRun.note.managedRootTarget":
    "Targeting managed gateway service package root: {root}",
  "cli.update.dryRun.note.managedRootDiffers":
    "Shell OpenClaw root differs from the managed gateway service root: {previousRoot}",
  "cli.update.dryRun.note.managedRootReconcile":
    "After the update, make sure `{cli}` on PATH resolves to the managed service root or reinstall the gateway service from the shell install you want to use.",
  "cli.update.dryRun.note.managedNode": "Managed gateway service Node: {node}",
  "cli.update.dryRun.note.managedNodeDiffers":
    "Current Node ({currentNode}) differs from the managed gateway service Node ({managedNode}).",
  "cli.update.dryRun.note.managedNodeUse":
    "Using the managed service Node for this update so the gateway can start after the upgrade.",
  "cli.update.dryRun.note.schemaIncompatible":
    "Would refuse update: {kind} database {path} has schema {foundVersion}; target supports {supportedVersion}; writer build {writerVersion}.",
  "cli.update.dryRun.note.schemaIncompatibleAgent":
    "Would refuse update: {kind} database (agent {agentId}) {path} has schema {foundVersion}; target supports {supportedVersion}; writer build {writerVersion}.",
  "cli.update.dryRun.note.schemaIndeterminate":
    "Would refuse update: could not inspect {kind} database {path}: {reason}; retry once the gateway releases it.",
  "cli.update.dryRun.note.schemaDocs": "{url}",
  "cli.update.dryRun.note.schemaManualInstall":
    "Installing manually via npm bypasses this guard; back up first and verify compatibility.",
  "cli.update.dryRun.note.nonRegistry":
    "Non-registry package specs skip npm version lookup and downgrade previews.",
  "cli.update.dryRun.note.gitSchemaCheck":
    "Database schema compatibility of the git target is verified during the real update; this preview does not check it.",
} as const satisfies LocalizationCatalog;

export type CliMessageKey = keyof typeof CLI_ENGLISH_CATALOG;
