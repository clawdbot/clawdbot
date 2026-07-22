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
  "cli.update.dryRun.note.managedRoot":
    "Package update targets managed service root {root} instead of invoking root {previousRoot}.",
  "cli.update.dryRun.note.nonRegistry":
    "Non-registry package specs skip npm version lookup and downgrade previews.",
  "cli.update.dryRun.note.gitSchemaCheck":
    "Database schema compatibility of the git target is verified during the real update; this preview does not check it.",
} as const satisfies LocalizationCatalog;

export type CliMessageKey = keyof typeof CLI_ENGLISH_CATALOG;
