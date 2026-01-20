import { confirm, isCancel, spinner } from "@clack/prompts";
import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

import { readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { resolveClawdbotPackageRoot } from "../infra/clawdbot-root.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  fetchNpmTagVersion,
} from "../infra/update-check.js";
import { parseSemver } from "../infra/runtime-guard.js";
import {
  runGatewayUpdate,
  type UpdateRunResult,
  type UpdateStepInfo,
  type UpdateStepProgress,
} from "../infra/update-runner.js";
import {
  channelToNpmTag,
  DEFAULT_GIT_CHANNEL,
  DEFAULT_PACKAGE_CHANNEL,
  formatUpdateChannelLabel,
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
  type UpdateChannel,
} from "../infra/update-channels.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { formatCliCommand } from "./command-format.js";
import { stylePromptMessage } from "../terminal/prompt-style.js";
import { theme } from "../terminal/theme.js";
import { renderTable } from "../terminal/table.js";
import {
  formatUpdateAvailableHint,
  formatUpdateOneLiner,
  resolveUpdateAvailability,
} from "../commands/status.update.js";

export type UpdateCommandOptions = {
  json?: boolean;
  restart?: boolean;
  channel?: string;
  tag?: string;
  timeout?: string;
};
export type UpdateStatusOptions = {
  json?: boolean;
  timeout?: string;
};

const STEP_LABELS: Record<string, string> = {
  "clean check": "Working directory is clean",
  "upstream check": "Upstream branch exists",
  "git fetch": "Fetching latest changes",
  "git rebase": "Rebasing onto upstream",
  "deps install": "Installing dependencies",
  build: "Building",
  "ui:build": "Building UI",
  "clawdbot doctor": "Running doctor checks",
  "git rev-parse HEAD (after)": "Verifying update",
  "global update": "Updating via package manager",
};

const UPDATE_QUIPS = [
  "Leveled up! New skills unlocked. You're welcome.",
  "Fresh code, same lobster. Miss me?",
  "Back and better. Did you even notice I was gone?",
  "Update complete. I learned some new tricks while I was out.",
  "Upgraded! Now with 23% more sass.",
  "I've evolved. Try to keep up.",
  "New version, who dis? Oh right, still me but shinier.",
  "Patched, polished, and ready to pinch. Let's go.",
  "The lobster has molted. Harder shell, sharper claws.",
  "Update done! Check the changelog or just trust me, it's good.",
  "Reborn from the boiling waters of npm. Stronger now.",
  "I went away and came back smarter. You should try it sometime.",
  "Update complete. The bugs feared me, so they left.",
  "New version installed. Old version sends its regards.",
  "Firmware fresh. Brain wrinkles: increased.",
  "I've seen things you wouldn't believe. Anyway, I'm updated.",
  "Back online. The changelog is long but our friendship is longer.",
  "Upgraded! Peter fixed stuff. Blame him if it breaks.",
  "Molting complete. Please don't look at my soft shell phase.",
  "Version bump! Same chaos energy, fewer crashes (probably).",
];

function normalizeTag(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("clawdbot@") ? trimmed.slice("clawdbot@".length) : trimmed;
}

function pickUpdateQuip(): string {
  return UPDATE_QUIPS[Math.floor(Math.random() * UPDATE_QUIPS.length)] ?? "Update complete.";
}

function normalizeVersionTag(tag: string): string | null {
  const trimmed = tag.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  return parseSemver(cleaned) ? cleaned : null;
}

async function readPackageVersion(root: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

async function resolveTargetVersion(tag: string, timeoutMs?: number): Promise<string | null> {
  const direct = normalizeVersionTag(tag);
  if (direct) return direct;
  const res = await fetchNpmTagVersion({ tag, timeoutMs });
  return res.version ?? null;
}

async function isGitCheckout(root: string): Promise<boolean> {
  try {
    await fs.stat(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

function formatGitStatusLine(params: {
  branch: string | null;
  tag: string | null;
  sha: string | null;
}): string {
  const shortSha = params.sha ? params.sha.slice(0, 8) : null;
  const branch = params.branch && params.branch !== "HEAD" ? params.branch : null;
  const tag = params.tag;
  const parts = [
    branch ?? (tag ? "detached" : "git"),
    tag ? `tag ${tag}` : null,
    shortSha ? `@ ${shortSha}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export async function updateStatusCommand(opts: UpdateStatusOptions): Promise<void> {
  const timeoutMs = opts.timeout ? Number.parseInt(opts.timeout, 10) * 1000 : undefined;
  if (timeoutMs !== undefined && (Number.isNaN(timeoutMs) || timeoutMs <= 0)) {
    defaultRuntime.error("--timeout must be a positive integer (seconds)");
    defaultRuntime.exit(1);
    return;
  }

  const root =
    (await resolveClawdbotPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })) ?? process.cwd();
  const configSnapshot = await readConfigFileSnapshot();
  const configChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;

  const update = await checkUpdateStatus({
    root,
    timeoutMs: timeoutMs ?? 3500,
    fetchGit: true,
    includeRegistry: true,
  });
  const channelInfo = resolveEffectiveUpdateChannel({
    configChannel,
    installKind: update.installKind,
    git: update.git ? { tag: update.git.tag, branch: update.git.branch } : undefined,
  });
  const channelLabel = formatUpdateChannelLabel({
    channel: channelInfo.channel,
    source: channelInfo.source,
    gitTag: update.git?.tag ?? null,
    gitBranch: update.git?.branch ?? null,
  });
  const gitLabel =
    update.installKind === "git"
      ? formatGitStatusLine({
          branch: update.git?.branch ?? null,
          tag: update.git?.tag ?? null,
          sha: update.git?.sha ?? null,
        })
      : null;
  const updateAvailability = resolveUpdateAvailability(update);
  const updateLine = formatUpdateOneLiner(update).replace(/^Update:\s*/i, "");

  if (opts.json) {
    defaultRuntime.log(
      JSON.stringify(
        {
          update,
          channel: {
            value: channelInfo.channel,
            source: channelInfo.source,
            label: channelLabel,
            config: configChannel,
          },
          availability: updateAvailability,
        },
        null,
        2,
      ),
    );
    return;
  }

  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
  const installLabel =
    update.installKind === "git"
      ? `git (${update.root ?? "unknown"})`
      : update.installKind === "package"
        ? update.packageManager
        : "unknown";
  const rows = [
    { Item: "Install", Value: installLabel },
    { Item: "Channel", Value: channelLabel },
    ...(gitLabel ? [{ Item: "Git", Value: gitLabel }] : []),
    {
      Item: "Update",
      Value: updateAvailability.available ? theme.warn(`available · ${updateLine}`) : updateLine,
    },
  ];

  defaultRuntime.log(theme.heading("Clawdbot update status"));
  defaultRuntime.log("");
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Item", header: "Item", minWidth: 10 },
        { key: "Value", header: "Value", flex: true, minWidth: 24 },
      ],
      rows,
    }).trimEnd(),
  );
  defaultRuntime.log("");
  const updateHint = formatUpdateAvailableHint(update);
  if (updateHint) {
    defaultRuntime.log(theme.warn(updateHint));
  }
}

function getStepLabel(step: UpdateStepInfo): string {
  return STEP_LABELS[step.name] ?? step.name;
}

type ProgressController = {
  progress: UpdateStepProgress;
  stop: () => void;
};

function createUpdateProgress(enabled: boolean): ProgressController {
  if (!enabled) {
    return {
      progress: {},
      stop: () => {},
    };
  }

  let currentSpinner: ReturnType<typeof spinner> | null = null;

  const progress: UpdateStepProgress = {
    onStepStart: (step) => {
      currentSpinner = spinner();
      currentSpinner.start(theme.accent(getStepLabel(step)));
    },
    onStepComplete: (step) => {
      if (!currentSpinner) return;

      const label = getStepLabel(step);
      const duration = theme.muted(`(${formatDuration(step.durationMs)})`);
      const icon = step.exitCode === 0 ? theme.success("\u2713") : theme.error("\u2717");

      currentSpinner.stop(`${icon} ${label} ${duration}`);
      currentSpinner = null;

      if (step.exitCode !== 0 && step.stderrTail) {
        const lines = step.stderrTail.split("\n").slice(-10);
        for (const line of lines) {
          if (line.trim()) {
            defaultRuntime.log(`    ${theme.error(line)}`);
          }
        }
      }
    },
  };

  return {
    progress,
    stop: () => {
      if (currentSpinner) {
        currentSpinner.stop();
        currentSpinner = null;
      }
    },
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = (ms / 1000).toFixed(1);
  return `${seconds}s`;
}

function formatStepStatus(exitCode: number | null): string {
  if (exitCode === 0) return theme.success("\u2713");
  if (exitCode === null) return theme.warn("?");
  return theme.error("\u2717");
}

type PrintResultOptions = UpdateCommandOptions & {
  hideSteps?: boolean;
};

function printResult(result: UpdateRunResult, opts: PrintResultOptions) {
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(result, null, 2));
    return;
  }

  const statusColor =
    result.status === "ok" ? theme.success : result.status === "skipped" ? theme.warn : theme.error;

  defaultRuntime.log("");
  defaultRuntime.log(
    `${theme.heading("Update Result:")} ${statusColor(result.status.toUpperCase())}`,
  );
  if (result.root) {
    defaultRuntime.log(`  Root: ${theme.muted(result.root)}`);
  }
  if (result.reason) {
    defaultRuntime.log(`  Reason: ${theme.muted(result.reason)}`);
  }

  if (result.before?.version || result.before?.sha) {
    const before = result.before.version ?? result.before.sha?.slice(0, 8) ?? "";
    defaultRuntime.log(`  Before: ${theme.muted(before)}`);
  }
  if (result.after?.version || result.after?.sha) {
    const after = result.after.version ?? result.after.sha?.slice(0, 8) ?? "";
    defaultRuntime.log(`  After: ${theme.muted(after)}`);
  }

  if (!opts.hideSteps && result.steps.length > 0) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Steps:"));
    for (const step of result.steps) {
      const status = formatStepStatus(step.exitCode);
      const duration = theme.muted(`(${formatDuration(step.durationMs)})`);
      defaultRuntime.log(`  ${status} ${step.name} ${duration}`);

      if (step.exitCode !== 0 && step.stderrTail) {
        const lines = step.stderrTail.split("\n").slice(0, 5);
        for (const line of lines) {
          if (line.trim()) {
            defaultRuntime.log(`      ${theme.error(line)}`);
          }
        }
      }
    }
  }

  defaultRuntime.log("");
  defaultRuntime.log(`Total time: ${theme.muted(formatDuration(result.durationMs))}`);
}

export async function updateCommand(opts: UpdateCommandOptions): Promise<void> {
  const timeoutMs = opts.timeout ? Number.parseInt(opts.timeout, 10) * 1000 : undefined;

  if (timeoutMs !== undefined && (Number.isNaN(timeoutMs) || timeoutMs <= 0)) {
    defaultRuntime.error("--timeout must be a positive integer (seconds)");
    defaultRuntime.exit(1);
    return;
  }

  const root =
    (await resolveClawdbotPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })) ?? process.cwd();

  const configSnapshot = await readConfigFileSnapshot();
  const storedChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;

  const requestedChannel = normalizeUpdateChannel(opts.channel);
  if (opts.channel && !requestedChannel) {
    defaultRuntime.error(`--channel must be "stable", "beta", or "dev" (got "${opts.channel}")`);
    defaultRuntime.exit(1);
    return;
  }
  if (opts.channel && !configSnapshot.valid) {
    const issues = configSnapshot.issues.map((issue) => `- ${issue.path}: ${issue.message}`);
    defaultRuntime.error(["Config is invalid; cannot set update channel.", ...issues].join("\n"));
    defaultRuntime.exit(1);
    return;
  }

  const gitCheckout = await isGitCheckout(root);
  const defaultChannel = gitCheckout ? DEFAULT_GIT_CHANNEL : DEFAULT_PACKAGE_CHANNEL;
  const channel = requestedChannel ?? storedChannel ?? defaultChannel;
  const tag = normalizeTag(opts.tag) ?? channelToNpmTag(channel);
  if (!gitCheckout) {
    const currentVersion = await readPackageVersion(root);
    const targetVersion = await resolveTargetVersion(tag, timeoutMs);
    const cmp =
      currentVersion && targetVersion ? compareSemverStrings(currentVersion, targetVersion) : null;
    const needsConfirm =
      currentVersion != null && (targetVersion == null || (cmp != null && cmp > 0));

    if (needsConfirm) {
      if (!process.stdin.isTTY || opts.json) {
        defaultRuntime.error(
          [
            "Downgrade confirmation required.",
            "Downgrading can break configuration. Re-run in a TTY to confirm.",
          ].join("\n"),
        );
        defaultRuntime.exit(1);
        return;
      }

      const targetLabel = targetVersion ?? `${tag} (unknown)`;
      const message = `Downgrading from ${currentVersion} to ${targetLabel} can break configuration. Continue?`;
      const ok = await confirm({
        message: stylePromptMessage(message),
        initialValue: false,
      });
      if (isCancel(ok) || ok === false) {
        if (!opts.json) {
          defaultRuntime.log(theme.muted("Update cancelled."));
        }
        defaultRuntime.exit(0);
        return;
      }
    }
  } else if (opts.tag && !opts.json) {
    defaultRuntime.log(
      theme.muted("Note: --tag applies to npm installs only; git updates ignore it."),
    );
  }

  if (requestedChannel && configSnapshot.valid) {
    const next = {
      ...configSnapshot.config,
      update: {
        ...configSnapshot.config.update,
        channel: requestedChannel,
      },
    };
    await writeConfigFile(next);
    if (!opts.json) {
      defaultRuntime.log(theme.muted(`Update channel set to ${requestedChannel}.`));
    }
  }

  const showProgress = !opts.json && process.stdout.isTTY;

  if (!opts.json) {
    defaultRuntime.log(theme.heading("Updating Clawdbot..."));
    defaultRuntime.log("");
  }

  const { progress, stop } = createUpdateProgress(showProgress);

  const result = await runGatewayUpdate({
    cwd: root,
    argv1: process.argv[1],
    timeoutMs,
    progress,
    channel,
    tag,
  });

  stop();

  printResult(result, { ...opts, hideSteps: showProgress });

  if (result.status === "error") {
    defaultRuntime.exit(1);
    return;
  }

  if (result.status === "skipped") {
    if (result.reason === "dirty") {
      defaultRuntime.log(
        theme.warn(
          "Skipped: working directory has uncommitted changes. Commit or stash them first.",
        ),
      );
    }
    if (result.reason === "not-git-install") {
      defaultRuntime.log(
        theme.warn(
          `Skipped: this Clawdbot install isn't a git checkout, and the package manager couldn't be detected. Update via your package manager, then run \`${formatCliCommand("clawdbot doctor")}\` and \`${formatCliCommand("clawdbot daemon restart")}\`.`,
        ),
      );
      defaultRuntime.log(
        theme.muted("Examples: `npm i -g clawdbot@latest` or `pnpm add -g clawdbot@latest`"),
      );
    }
    defaultRuntime.exit(0);
    return;
  }

  // Restart daemon if requested
  if (opts.restart) {
    if (!opts.json) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Restarting daemon..."));
    }
    try {
      const { runDaemonRestart } = await import("./daemon-cli.js");
      const restarted = await runDaemonRestart();
      if (!opts.json && restarted) {
        defaultRuntime.log(theme.success("Daemon restarted successfully."));
        defaultRuntime.log("");
        process.env.CLAWDBOT_UPDATE_IN_PROGRESS = "1";
        try {
          const { doctorCommand } = await import("../commands/doctor.js");
          await doctorCommand(defaultRuntime, { nonInteractive: true });
        } catch (err) {
          defaultRuntime.log(theme.warn(`Doctor failed: ${String(err)}`));
        } finally {
          delete process.env.CLAWDBOT_UPDATE_IN_PROGRESS;
        }
      }
    } catch (err) {
      if (!opts.json) {
        defaultRuntime.log(theme.warn(`Daemon restart failed: ${String(err)}`));
        defaultRuntime.log(
          theme.muted(
            `You may need to restart the daemon manually: ${formatCliCommand("clawdbot daemon restart")}`,
          ),
        );
      }
    }
  } else if (!opts.json) {
    defaultRuntime.log("");
    if (result.mode === "npm" || result.mode === "pnpm") {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${formatCliCommand("clawdbot doctor")}\`, then \`${formatCliCommand("clawdbot daemon restart")}\` to apply updates to a running gateway.`,
        ),
      );
    } else {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${formatCliCommand("clawdbot daemon restart")}\` to apply updates to a running gateway.`,
        ),
      );
    }
  }

  if (!opts.json) {
    defaultRuntime.log(theme.muted(pickUpdateQuip()));
  }
}

export function registerUpdateCli(program: Command) {
  const update = program
    .command("update")
    .description("Update Clawdbot to the latest version")
    .option("--json", "Output result as JSON", false)
    .option("--restart", "Restart the gateway daemon after a successful update", false)
    .option("--channel <stable|beta|dev>", "Persist update channel (git + npm)")
    .option("--tag <dist-tag|version>", "Override npm dist-tag or version for this update")
    .option("--timeout <seconds>", "Timeout for each update step in seconds (default: 1200)")
    .addHelpText(
      "after",
      () =>
        `
Examples:
  clawdbot update                   # Update a source checkout (git)
  clawdbot update --channel beta    # Switch to beta channel (git + npm)
  clawdbot update --channel dev     # Switch to dev channel (git + npm)
  clawdbot update --tag beta        # One-off update to a dist-tag or version
  clawdbot update --restart         # Update and restart the daemon
  clawdbot update --json            # Output result as JSON
  clawdbot --update                 # Shorthand for clawdbot update

Notes:
  - For git installs: fetches, rebases, installs deps, builds, and runs doctor
  - For global installs: auto-updates via detected package manager when possible (see docs/install/updating.md)
  - Downgrades require confirmation (can break configuration)
  - Skips update if the working directory has uncommitted changes

${theme.muted("Docs:")} ${formatDocsLink("/cli/update", "docs.clawd.bot/cli/update")}`,
    )
    .action(async (opts) => {
      try {
        await updateCommand({
          json: Boolean(opts.json),
          restart: Boolean(opts.restart),
          channel: opts.channel as string | undefined,
          tag: opts.tag as string | undefined,
          timeout: opts.timeout as string | undefined,
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  update
    .command("status")
    .description("Show update channel and version status")
    .option("--json", "Output result as JSON", false)
    .option("--timeout <seconds>", "Timeout for update checks in seconds (default: 3)")
    .addHelpText(
      "after",
      () =>
        `
Examples:
  clawdbot update status
  clawdbot update status --json
  clawdbot update status --timeout 10

Notes:
  - Shows current update channel (stable/beta/dev) and source
  - Includes git tag/branch/SHA for source checkouts

${theme.muted("Docs:")} ${formatDocsLink("/cli/update", "docs.clawd.bot/cli/update")}`,
    )
    .action(async (opts) => {
      try {
        await updateStatusCommand({
          json: Boolean(opts.json),
          timeout: opts.timeout as string | undefined,
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
