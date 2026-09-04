/** Doctor checks and repairs for Control UI assets after gateway protocol changes. */
import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import {
  ensureControlUiAssetsBuilt,
  formatControlUiSourceCommand,
  resolveControlUiAssetHealth,
  resolveControlUiDistIndexPathForRoot,
} from "../infra/control-ui-assets.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type UiProtocolFreshnessIssue =
  | {
      readonly kind: "missing-assets";
      readonly root: string;
      readonly uiIndexPath: string;
      readonly canBuild: boolean;
    }
  | {
      readonly kind: "stale-assets";
      readonly root: string;
      readonly uiIndexPath: string;
      readonly changesSinceBuild: readonly string[];
      readonly canBuild: boolean;
    };

/** Detects missing or stale Control UI build artifacts relative to protocol schema changes. */
export async function detectUiProtocolFreshnessIssues(
  opts: {
    readonly root?: string;
    readonly argv1?: string;
    readonly cwd?: string;
    readonly collectChangesSinceBuild?: (
      root: string,
      uiMtime: Date,
    ) => Promise<readonly string[] | null>;
  } = {},
): Promise<readonly UiProtocolFreshnessIssue[]> {
  const root =
    opts.root ??
    (await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: opts.argv1 ?? process.argv[1],
      cwd: opts.cwd ?? process.cwd(),
    }));
  if (!root) {
    return [];
  }

  const uiHealth = await resolveControlUiAssetHealth({ root });
  const uiIndexPath = uiHealth.indexPath ?? resolveControlUiDistIndexPathForRoot(root);
  const uiSourcesPath = path.join(root, "ui/package.json");

  try {
    const [uiStats, uiSourcesStats] = await Promise.all([
      fs.stat(uiIndexPath).catch(() => null),
      fs.stat(uiSourcesPath).catch(() => null),
    ]);
    const canBuild = uiSourcesStats !== null;
    if (!uiStats || uiHealth.kind !== "ready") {
      return [{ kind: "missing-assets", root, uiIndexPath, canBuild }];
    }
    if (!canBuild) {
      return [];
    }
    const changesSinceBuild = await (
      opts.collectChangesSinceBuild ?? collectProtocolSchemaChangesSince
    )(root, uiStats.mtime);
    if (changesSinceBuild === null || changesSinceBuild.length === 0) {
      return [];
    }
    return [
      {
        kind: "stale-assets",
        root,
        uiIndexPath,
        changesSinceBuild,
        canBuild,
      },
    ];
  } catch {
    return [];
  }
}

async function collectProtocolSchemaChangesSince(
  root: string,
  uiMtime: Date,
): Promise<readonly string[] | null> {
  const gitLog = await runCommandWithTimeout(
    [
      "git",
      "-C",
      root,
      "log",
      `--since=${uiMtime.toISOString()}`,
      "--format=%h %s",
      "packages/gateway-protocol/src",
    ],
    { timeoutMs: 5000 },
  ).catch(() => null);
  if (!gitLog || gitLog.code !== 0) {
    return null;
  }
  if (!gitLog.stdout.trim()) {
    return [];
  }
  return gitLog.stdout.trim().split("\n");
}

/** Converts a UI protocol freshness issue into a doctor lint health finding. */
export function uiProtocolFreshnessIssueToHealthFinding(
  issue: UiProtocolFreshnessIssue,
): HealthFinding {
  return {
    checkId: "core/doctor/ui-protocol-freshness",
    severity: "warning",
    message: formatUiProtocolFreshnessIssue(issue),
    path: issue.uiIndexPath,
    fixHint: issue.canBuild
      ? issue.kind === "missing-assets"
        ? "Run `openclaw doctor --fix` to build Control UI assets."
        : `Run \`openclaw doctor --fix --force\` to rebuild Control UI assets, or run \`${formatControlUiSourceCommand(issue.root, "build")}\`.`
      : "Reinstall OpenClaw to restore bundled Control UI assets.",
  };
}

/** Converts a UI freshness issue into the process repair effect used by lint dry runs. */
export function uiProtocolFreshnessIssueToRepairEffects(
  issue: UiProtocolFreshnessIssue,
): readonly HealthRepairEffect[] {
  if (!issue.canBuild) {
    return [];
  }
  return [
    {
      kind: "process",
      action:
        issue.kind === "missing-assets" ? "would-build-control-ui" : "would-rebuild-control-ui",
      target: issue.root,
      dryRunSafe: false,
    },
  ];
}

function formatUiProtocolFreshnessIssue(issue: UiProtocolFreshnessIssue): string {
  if (issue.kind === "missing-assets") {
    return [
      "- Control UI assets are missing.",
      issue.canBuild
        ? `- Run: ${formatControlUiSourceCommand(issue.root, "build")}`
        : "- Reinstall OpenClaw to restore bundled Control UI assets.",
    ].join("\n");
  }
  if (issue.changesSinceBuild.length === 0) {
    return "UI assets are older than the protocol schema.";
  }
  return `UI assets are older than the protocol schema.\nFunctional changes since last build:\n${issue.changesSinceBuild
    .map((line) => `- ${line}`)
    .join("\n")}`;
}

/** Prompts to build or rebuild Control UI assets when doctor detects missing or stale output. */
export async function maybeRepairUiProtocolFreshness(
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  for (const issue of await detectUiProtocolFreshnessIssues()) {
    const stale = issue.kind === "stale-assets";
    note(formatUiProtocolFreshnessIssue(issue), stale ? "UI Freshness" : "UI");
    if (!issue.canBuild) {
      note(`Skipping UI ${stale ? "rebuild" : "build"}: ui/ sources not present.`, "UI");
      continue;
    }
    const shouldRepair = stale
      ? await prompter.confirmAggressiveAutoFix({
          message: "Rebuild UI now? (Detected protocol mismatch requiring update)",
          initialValue: true,
        })
      : await prompter.confirmAutoFix({
          message: "Build Control UI assets now?",
          initialValue: true,
        });
    if (!shouldRepair) {
      continue;
    }
    const result = await ensureControlUiAssetsBuilt(runtime, {
      root: issue.root,
      force: stale,
      onBuildStart: () =>
        note(
          stale
            ? "Rebuilding stale UI assets... (this may take a moment)"
            : "Building Control UI assets... (this may take a moment)",
          "UI",
        ),
    });
    note(
      result.ok
        ? stale
          ? "UI rebuild complete."
          : "UI build complete."
        : (result.message ?? `UI ${stale ? "rebuild" : "build"} failed.`),
      "UI",
    );
  }
}
