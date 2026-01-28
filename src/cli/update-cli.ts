import { confirm, isCancel, select, spinner } from "@clack/prompts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";

import { readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { resolveMoltbotPackageRoot } from "../infra/moltbot-root.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  fetchNpmTagVersion,
  resolveNpmChannelTag,
} from "../infra/update-check.js";
import { parseSemver } from "../infra/runtime-guard.js";
import {
  runGatewayUpdate,
  type UpdateRunResult,
  type UpdateStepInfo,
  type UpdateStepResult,
  type UpdateStepProgress,
} from "../infra/update-runner.js";
import {
  detectGlobalInstallManagerByPresence,
  detectGlobalInstallManagerForRoot,
  globalInstallArgs,
  resolveGlobalPackageRoot,
  type GlobalInstallManager,
} from "../infra/update-global.js";
import {
  channelToNpmTag,
  DEFAULT_GIT_CHANNEL,
  DEFAULT_PACKAGE_CHANNEL,
  formatUpdateChannelLabel,
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
} from "../infra/update-channels.js";
import { trimLogTail } from "../infra/restart-sentinel.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { formatCliCommand } from "./command-format.js";
import { replaceCliName, resolveCliName } from "./cli-name.js";
import { stylePromptHint, stylePromptMessage } from "../terminal/prompt-style.js";
import { theme } from "../terminal/theme.js";
import { renderTable } from "../terminal/table.js";
import { formatHelpExamples } from "./help-format.js";
import {
  formatUpdateAvailableHint,
  formatUpdateOneLiner,
  resolveUpdateAvailability,
} from "../commands/status.update.js";
import { syncPluginsForUpdateChannel, updateNpmInstalledPlugins } from "../plugins/update.js";
import { runCommandWithTimeout } from "../process/exec.js";

export type UpdateCommandOptions = {
  json?: boolean;
  restart?: boolean;
  channel?: string;
  tag?: string;
  timeout?: string;
  yes?: boolean;
};
export type UpdateStatusOptions = {
  json?: boolean;
  timeout?: string;
};
export type UpdateWizardOptions = {
  timeout?: string;
};

const STEP_LABELS: Record<string, string> = {
  "clean check": "Working directory is clean",
  "upstream check": "Upstream branch exists",
  "git fetch": "Fetching latest changes",
  "git rebase": "Rebasing onto target commit",
  "git rev-parse @{upstream}": "Resolving upstream commit",
  "git rev-list": "Enumerating candidate commits",
  "git clone": "Cloning git checkout",
  "preflight worktree": "Preparing preflight worktree",
  "preflight cleanup": "Cleaning preflight worktree",
  "deps install": "Installing dependencies",
  build: "Building",
  "ui:build": "Building UI",
  "moltbot doctor": "Running doctor checks",
  "git rev-parse HEAD (after)": "Verifying update",
  "global update": "Updating via package manager",
  "global install": "Installing global package",
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

const MAX_LOG_CHARS = 8000;
const DEFAULT_PACKAGE_NAME = "moltbot";
const CORE_PACKAGE_NAMES = new Set([DEFAULT_PACKAGE_NAME, "moltbot"]);
const CLI_NAME = resolveCliName();
const CLAWDBOT_REPO_URL = "https://github.com/moltbot/moltbot.git";
const DEFAULT_GIT_DIR = path.join(os.homedir(), "moltbot");

function normalizeTag(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("moltbot@")) return trimmed.slice("moltbot@".length);
  if (trimmed.startsWith(`${DEFAULT_PACKAGE_NAME}@`)) {
    return trimmed.slice(`${DEFAULT_PACKAGE_NAME}@`.length);
  }
  return trimmed;
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

async function readPackageName(root: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { name?: string };
    const name = parsed?.name?.trim();
    return name ? name : null;
  } catch {
    return null;
  }
}

async function isCorePackage(root: string): Promise<boolean> {
  const name = await readPackageName(root);
  return Boolean(name && CORE_PACKAGE_NAMES.has(name));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isEmptyDir(targetPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(targetPath);
    return entries.length === 0;
  } catch {
    return false;
  }
}

function resolveGitInstallDir(): string {
  const override = process.env.CLAWDBOT_GIT_DIR?.trim();
  if (override) return path.resolve(override);
  return DEFAULT_GIT_DIR;
}

function resolveNodeRunner(): string {
  const base = path.basename(process.execPath).toLowerCase();
  if (base === "node" || base === "node.exe") return process.execPath;
  return "node";
}

async function runUpdateStep(params: {
  name: string;
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  progress?: UpdateStepProgress;
}): Promise<UpdateStepResult> {
  const command = params.argv.join(" ");
  params.progress?.onStepStart?.({
    name: params.name,
    command,
    index: 0,
    total: 0,
  });
  const started = Date.now();
  const res = await runCommandWithTimeout(params.argv, {
    cwd: params.cwd,
    timeoutMs: params.timeoutMs,
  });
  const durationMs = Date.now() - started;
  const stderrTail = trimLogTail(res.stderr, MAX_LOG_CHARS);
  params.progress?.onStepComplete?.({
    name: params.name,
    command,
    index: 0,
    total: 0,
    durationMs,
    exitCode: res.code,
    stderrTail,
  });
  return {
    name: params.name,
    command,
    cwd: params.cwd ?? process.cwd(),
    durationMs,
    exitCode: res.code,
    stdoutTail: trimLogTail(res.stdout, MAX_LOG_CHARS),
    stderrTail,
  };
}

async function ensureGitCheckout(params: {
  dir: string;
  timeoutMs: number;
  progress?: UpdateStepProgress;
}): Promise<UpdateStepResult | null> {
  const dirExists = await pathExists(params.dir);
  if (!dirExists) {
    return await runUpdateStep({
      name: "git clone",
      argv: ["git", "clone", CLAWDBOT_REPO_URL, params.dir],
      timeoutMs: params.timeoutMs,
      progress: params.progress,
    });
  }

  if (!(await isGitCheckout(params.dir))) {
    const empty = await isEmptyDir(params.dir);
    if (!empty) {
      throw new Error(
        `CLAWDBOT_GIT_DIR points at a non-git directory: ${params.dir}. Set CLAWDBOT_GIT_DIR to an empty folder or a moltbot checkout.`,
      );
    }
    return await runUpdateStep({
      name: "git clone",
      argv: ["git", "clone", CLAWDBOT_REPO_URL, params.dir],
      cwd: params.dir,
      timeoutMs: params.timeoutMs,
      progress: params.progress,
    });
  }

  if (!(await isCorePackage(params.dir))) {
    throw new Error(`CLAWDBOT_GIT_DIR does not look like a core checkout: ${params.dir}.`);
  }

  return null;
}

async function resolveGlobalManager(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  timeoutMs: number;
}): Promise<GlobalInstallManager> {
  const runCommand = async (argv: string[], options: { timeoutMs: number }) => {
    const res = await runCommandWithTimeout(argv, options);
    return { stdout: res.stdout, stderr: res.stderr, code: res.code };
  };
  if (params.installKind === "package") {
    const detected = await detectGlobalInstallManagerForRoot(
      runCommand,
      params.root,
      params.timeoutMs,
    );
    if (detected) return detected;
  }
  const byPresence = await detectGlobalInstallManagerByPresence(runCommand, params.timeoutMs);
  return byPresence ?? "npm";
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
    (await resolveMoltbotPackageRoot({
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

  defaultRuntime.log(theme.heading("Moltbot update status"));
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

const selectStyled = <T>(params: Parameters<typeof select<T>>[0]) =>
  select({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });

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
  process.noDeprecation = true;
  process.env.NODE_NO_WARNINGS = "1";
  const timeoutMs = opts.timeout ? Number.parseInt(opts.timeout, 10) * 1000 : undefined;
  const shouldRestart = opts.restart !== false;

  if (timeoutMs !== undefined && (Number.isNaN(timeoutMs) || timeoutMs <= 0)) {
    defaultRuntime.error("--timeout must be a positive integer (seconds)");
    defaultRuntime.exit(1);
    return;
  }

  const root =
    (await resolveMoltbotPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })) ?? process.cwd();

  const updateStatus = await checkUpdateStatus({
    root,
    timeoutMs: timeoutMs ?? 3500,
    fetchGit: false,
    includeRegistry: false,
  });

  const configSnapshot = await readConfigFileSnapshot();
  let activeConfig = configSnapshot.valid ? configSnapshot.config : null;
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

  const installKind = updateStatus.installKind;
  const switchToGit = requestedChannel === "dev" && installKind !== "git";
  const switchToPackage =
    requestedChannel !== null && requestedChannel !== "dev" && installKind === "git";
  const updateInstallKind = switchToGit ? "git" : switchToPackage ? "package" : installKind;
  const defaultChannel =
    updateInstallKind === "git" ? DEFAULT_GIT_CHANNEL : DEFAULT_PACKAGE_CHANNEL;
  const channel = requestedChannel ?? storedChannel ?? defaultChannel;
  const explicitTag = normalizeTag(opts.tag);
  let tag = explicitTag ?? channelToNpmTag(channel);
  if (updateInstallKind !== "git") {
    const currentVersion = switchToPackage ? null : await readPackageVersion(root);
    let fallbackToLatest = false;
    const targetVersion = explicitTag
      ? await resolveTargetVersion(tag, timeoutMs)
      : await resolveNpmChannelTag({ channel, timeoutMs }).then((resolved) => {
          tag = resolved.tag;
          fallbackToLatest = channel === "beta" && resolved.tag === "latest";
          return resolved.version;
        });
    const cmp =
      currentVersion && targetVersion ? compareSemverStrings(currentVersion, targetVersion) : null;
    const needsConfirm =
      !fallbackToLatest &&
      currentVersion != null &&
      (targetVersion == null || (cmp != null && cmp > 0));

    if (needsConfirm && !opts.yes) {
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
    activeConfig = next;
    if (!opts.json) {
      defaultRuntime.log(theme.muted(`Update channel set to ${requestedChannel}.`));
    }
  }

  const showProgress = !opts.json && process.stdout.isTTY;

  if (!opts.json) {
    defaultRuntime.log(theme.heading("Updating Moltbot..."));
    defaultRuntime.log("");
  }

  const { progress, stop } = createUpdateProgress(showProgress);

  const startedAt = Date.now();
  let result: UpdateRunResult;

  if (switchToPackage) {
    const manager = await resolveGlobalManager({
      root,
      installKind,
      timeoutMs: timeoutMs ?? 20 * 60_000,
    });
    const runCommand = async (argv: string[], options: { timeoutMs: number }) => {
      const res = await runCommandWithTimeout(argv, options);
      return { stdout: res.stdout, stderr: res.stderr, code: res.code };
    };
    const pkgRoot = await resolveGlobalPackageRoot(manager, runCommand, timeoutMs ?? 20 * 60_000);
    const packageName =
      (pkgRoot ? await readPackageName(pkgRoot) : await readPackageName(root)) ??
      DEFAULT_PACKAGE_NAME;
    const beforeVersion = pkgRoot ? await readPackageVersion(pkgRoot) : null;
    const updateStep = await runUpdateStep({
      name: "global update",
      argv: globalInstallArgs(manager, `${packageName}@${tag}`),
      timeoutMs: timeoutMs ?? 20 * 60_000,
      progress,
    });
    const steps = [updateStep];
    let afterVersion = beforeVersion;
    if (pkgRoot) {
      afterVersion = await readPackageVersion(pkgRoot);
      const entryPath = path.join(pkgRoot, "dist", "entry.js");
      if (await pathExists(entryPath)) {
        const doctorStep = await runUpdateStep({
          name: `${CLI_NAME} doctor`,
          argv: [resolveNodeRunner(), entryPath, "doctor", "--non-interactive"],
          timeoutMs: timeoutMs ?? 20 * 60_000,
          progress,
        });
        steps.push(doctorStep);
      }
    }
    const failedStep = steps.find((step) => step.exitCode !== 0);
    result = {
      status: failedStep ? "error" : "ok",
      mode: manager,
      root: pkgRoot ?? root,
      reason: failedStep ? failedStep.name : undefined,
      before: { version: beforeVersion },
      after: { version: afterVersion },
      steps,
      durationMs: Date.now() - startedAt,
    };
  } else {
    const updateRoot = switchToGit ? resolveGitInstallDir() : root;
    const cloneStep = switchToGit
      ? await ensureGitCheckout({
          dir: updateRoot,
          timeoutMs: timeoutMs ?? 20 * 60_000,
          progress,
        })
      : null;
    if (cloneStep && cloneStep.exitCode !== 0) {
      result = {
        status: "error",
        mode: "git",
        root: updateRoot,
        reason: cloneStep.name,
        steps: [cloneStep],
        durationMs: Date.now() - startedAt,
      };
      stop();
      printResult(result, { ...opts, hideSteps: showProgress });
      defaultRuntime.exit(1);
      return;
    }
    const updateResult = await runGatewayUpdate({
      cwd: updateRoot,
      argv1: switchToGit ? undefined : process.argv[1],
      timeoutMs,
      progress,
      channel,
      tag,
    });
    const steps = [...(cloneStep ? [cloneStep] : []), ...updateResult.steps];
    if (switchToGit && updateResult.status === "ok") {
      const manager = await resolveGlobalManager({
        root,
        installKind,
        timeoutMs: timeoutMs ?? 20 * 60_000,
      });
      const installStep = await runUpdateStep({
        name: "global install",
        argv: globalInstallArgs(manager, updateRoot),
        cwd: updateRoot,
        timeoutMs: timeoutMs ?? 20 * 60_000,
        progress,
      });
      steps.push(installStep);
      const failedStep = [installStep].find((step) => step.exitCode !== 0);
      result = {
        ...updateResult,
        status: updateResult.status === "ok" && !failedStep ? "ok" : "error",
        steps,
        durationMs: Date.now() - startedAt,
      };
    } else {
      result = {
        ...updateResult,
        steps,
        durationMs: Date.now() - startedAt,
      };
    }
  }

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
          `Skipped: this Moltbot install isn't a git checkout, and the package manager couldn't be detected. Update via your package manager, then run \`${replaceCliName(formatCliCommand("moltbot doctor"), CLI_NAME)}\` and \`${replaceCliName(formatCliCommand("moltbot gateway restart"), CLI_NAME)}\`.`,
        ),
      );
      defaultRuntime.log(
        theme.muted(
          `Examples: \`${replaceCliName("npm i -g moltbot@latest", CLI_NAME)}\` or \`${replaceCliName("pnpm add -g moltbot@latest", CLI_NAME)}\``,
        ),
      );
    }
    defaultRuntime.exit(0);
    return;
  }

  if (activeConfig) {
    const pluginLogger = opts.json
      ? {}
      : {
          info: (msg: string) => defaultRuntime.log(msg),
          warn: (msg: string) => defaultRuntime.log(theme.warn(msg)),
          error: (msg: string) => defaultRuntime.log(theme.error(msg)),
        };

    if (!opts.json) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Updating plugins..."));
    }

    const syncResult = await syncPluginsForUpdateChannel({
      config: activeConfig,
      channel,
      workspaceDir: root,
      logger: pluginLogger,
    });
    let pluginConfig = syncResult.config;

    const npmResult = await updateNpmInstalledPlugins({
      config: pluginConfig,
      skipIds: new Set(syncResult.summary.switchedToNpm),
      logger: pluginLogger,
    });
    pluginConfig = npmResult.config;

    if (syncResult.changed || npmResult.changed) {
      await writeConfigFile(pluginConfig);
    }

    if (!opts.json) {
      const summarizeList = (list: string[]) => {
        if (list.length <= 6) return list.join(", ");
        return `${list.slice(0, 6).join(", ")} +${list.length - 6} more`;
      };

      if (syncResult.summary.switchedToBundled.length > 0) {
        defaultRuntime.log(
          theme.muted(
            `Switched to bundled plugins: ${summarizeList(syncResult.summary.switchedToBundled)}.`,
          ),
        );
      }
      if (syncResult.summary.switchedToNpm.length > 0) {
        defaultRuntime.log(
          theme.muted(`Restored npm plugins: ${summarizeList(syncResult.summary.switchedToNpm)}.`),
        );
      }
      for (const warning of syncResult.summary.warnings) {
        defaultRuntime.log(theme.warn(warning));
      }
      for (const error of syncResult.summary.errors) {
        defaultRuntime.log(theme.error(error));
      }

      const updated = npmResult.outcomes.filter((entry) => entry.status === "updated").length;
      const unchanged = npmResult.outcomes.filter((entry) => entry.status === "unchanged").length;
      const failed = npmResult.outcomes.filter((entry) => entry.status === "error").length;
      const skipped = npmResult.outcomes.filter((entry) => entry.status === "skipped").length;

      if (npmResult.outcomes.length === 0) {
        defaultRuntime.log(theme.muted("No plugin updates needed."));
      } else {
        const parts = [`${updated} updated`, `${unchanged} unchanged`];
        if (failed > 0) parts.push(`${failed} failed`);
        if (skipped > 0) parts.push(`${skipped} skipped`);
        defaultRuntime.log(theme.muted(`npm plugins: ${parts.join(", ")}.`));
      }

      for (const outcome of npmResult.outcomes) {
        if (outcome.status !== "error") continue;
        defaultRuntime.log(theme.error(outcome.message));
      }
    }
  } else if (!opts.json) {
    defaultRuntime.log(theme.warn("Skipping plugin updates: config is invalid."));
  }

  // Restart service if requested
  if (shouldRestart) {
    if (!opts.json) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Restarting service..."));
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
          const interactiveDoctor = Boolean(process.stdin.isTTY) && !opts.json && opts.yes !== true;
          await doctorCommand(defaultRuntime, { nonInteractive: !interactiveDoctor });
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
            `You may need to restart the service manually: ${replaceCliName(formatCliCommand("moltbot gateway restart"), CLI_NAME)}`,
          ),
        );
      }
    }
  } else if (!opts.json) {
    defaultRuntime.log("");
    if (result.mode === "npm" || result.mode === "pnpm") {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${replaceCliName(formatCliCommand("moltbot doctor"), CLI_NAME)}\`, then \`${replaceCliName(formatCliCommand("moltbot gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
        ),
      );
    } else {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${replaceCliName(formatCliCommand("moltbot gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
        ),
      );
    }
  }

  if (!opts.json) {
    defaultRuntime.log(theme.muted(pickUpdateQuip()));
  }
}

export async function updateWizardCommand(opts: UpdateWizardOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) {
    defaultRuntime.error(
      "Update wizard requires a TTY. Use `moltbot update --channel <stable|beta|dev>` instead.",
    );
    defaultRuntime.exit(1);
    return;
  }

  const timeoutMs = opts.timeout ? Number.parseInt(opts.timeout, 10) * 1000 : undefined;
  if (timeoutMs !== undefined && (Number.isNaN(timeoutMs) || timeoutMs <= 0)) {
    defaultRuntime.error("--timeout must be a positive integer (seconds)");
    defaultRuntime.exit(1);
    return;
  }

  const root =
    (await resolveMoltbotPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })) ?? process.cwd();

  const [updateStatus, configSnapshot] = await Promise.all([
    checkUpdateStatus({
      root,
      timeoutMs: timeoutMs ?? 3500,
      fetchGit: false,
      includeRegistry: false,
    }),
    readConfigFileSnapshot(),
  ]);

  const configChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;
  const channelInfo = resolveEffectiveUpdateChannel({
    configChannel,
    installKind: updateStatus.installKind,
    git: updateStatus.git
      ? { tag: updateStatus.git.tag, branch: updateStatus.git.branch }
      : undefined,
  });
  const channelLabel = formatUpdateChannelLabel({
    channel: channelInfo.channel,
    source: channelInfo.source,
    gitTag: updateStatus.git?.tag ?? null,
    gitBranch: updateStatus.git?.branch ?? null,
  });

  const pickedChannel = await selectStyled({
    message: "Update channel",
    options: [
      {
        value: "keep",
        label: `Keep current (${channelInfo.channel})`,
        hint: channelLabel,
      },
      {
        value: "stable",
        label: "Stable",
        hint: "Tagged releases (npm latest)",
      },
      {
        value: "beta",
        label: "Beta",
        hint: "Prereleases (npm beta)",
      },
      {
        value: "dev",
        label: "Dev",
        hint: "Git main",
      },
    ],
    initialValue: "keep",
  });

  if (isCancel(pickedChannel)) {
    defaultRuntime.log(theme.muted("Update cancelled."));
    defaultRuntime.exit(0);
    return;
  }

  const requestedChannel = pickedChannel === "keep" ? null : pickedChannel;

  if (requestedChannel === "dev" && updateStatus.installKind !== "git") {
    const gitDir = resolveGitInstallDir();
    const hasGit = await isGitCheckout(gitDir);
    if (!hasGit) {
      const dirExists = await pathExists(gitDir);
      if (dirExists) {
        const empty = await isEmptyDir(gitDir);
        if (!empty) {
          defaultRuntime.error(
            `CLAWDBOT_GIT_DIR points at a non-git directory: ${gitDir}. Set CLAWDBOT_GIT_DIR to an empty folder or a moltbot checkout.`,
          );
          defaultRuntime.exit(1);
          return;
        }
      }
      const ok = await confirm({
        message: stylePromptMessage(
          `Create a git checkout at ${gitDir}? (override via CLAWDBOT_GIT_DIR)`,
        ),
        initialValue: true,
      });
      if (isCancel(ok) || ok === false) {
        defaultRuntime.log(theme.muted("Update cancelled."));
        defaultRuntime.exit(0);
        return;
      }
    }
  }

  const restart = await confirm({
    message: stylePromptMessage("Restart the gateway service after update?"),
    initialValue: true,
  });
  if (isCancel(restart)) {
    defaultRuntime.log(theme.muted("Update cancelled."));
    defaultRuntime.exit(0);
    return;
  }

  try {
    await updateCommand({
      channel: requestedChannel ?? undefined,
      restart: Boolean(restart),
      timeout: opts.timeout,
    });
  } catch (err) {
    defaultRuntime.error(String(err));
    defaultRuntime.exit(1);
  }
}

export function registerUpdateCli(program: Command) {
  const update = program
    .command("update")
    .description("Update Moltbot to the latest version")
    .option("--json", "Output result as JSON", false)
    .option("--no-restart", "Skip restarting the gateway service after a successful update")
    .option("--channel <stable|beta|dev>", "Persist update channel (git + npm)")
    .option("--tag <dist-tag|version>", "Override npm dist-tag or version for this update")
    .option("--timeout <seconds>", "Timeout for each update step in seconds (default: 1200)")
    .option("--yes", "Skip confirmation prompts (non-interactive)", false)
    .addHelpText("after", () => {
      const examples = [
        ["moltbot update", "Update a source checkout (git)"],
        ["moltbot update --channel beta", "Switch to beta channel (git + npm)"],
        ["moltbot update --channel dev", "Switch to dev channel (git + npm)"],
        ["moltbot update --tag beta", "One-off update to a dist-tag or version"],
        ["moltbot update --no-restart", "Update without restarting the service"],
        ["moltbot update --json", "Output result as JSON"],
        ["moltbot update --yes", "Non-interactive (accept downgrade prompts)"],
        ["moltbot update wizard", "Interactive update wizard"],
        ["moltbot --update", "Shorthand for moltbot update"],
      ] as const;
      const fmtExamples = examples
        .map(([cmd, desc]) => `  ${theme.command(cmd)} ${theme.muted(`# ${desc}`)}`)
        .join("\n");
      return `
${theme.heading("What this does:")}
  - Git checkouts: fetches, rebases, installs deps, builds, and runs doctor
  - npm installs: updates via detected package manager

${theme.heading("Switch channels:")}
  - Use --channel stable|beta|dev to persist the update channel in config
  - Run moltbot update status to see the active channel and source
  - Use --tag <dist-tag|version> for a one-off npm update without persisting

${theme.heading("Non-interactive:")}
  - Use --yes to accept downgrade prompts
  - Combine with --channel/--tag/--restart/--json/--timeout as needed

${theme.heading("Examples:")}
${fmtExamples}

${theme.heading("Notes:")}
  - Switch channels with --channel stable|beta|dev
  - For global installs: auto-updates via detected package manager when possible (see docs/install/updating.md)
  - Downgrades require confirmation (can break configuration)
  - Skips update if the working directory has uncommitted changes

${theme.muted("Docs:")} ${formatDocsLink("/cli/update", "docs.molt.bot/cli/update")}`;
    })
    .action(async (opts) => {
      try {
        await updateCommand({
          json: Boolean(opts.json),
          restart: Boolean(opts.restart),
          channel: opts.channel as string | undefined,
          tag: opts.tag as string | undefined,
          timeout: opts.timeout as string | undefined,
          yes: Boolean(opts.yes),
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  update
    .command("wizard")
    .description("Interactive update wizard")
    .option("--timeout <seconds>", "Timeout for each update step in seconds (default: 1200)")
    .addHelpText(
      "after",
      `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/update", "docs.molt.bot/cli/update")}\n`,
    )
    .action(async (opts) => {
      try {
        await updateWizardCommand({ timeout: opts.timeout as string | undefined });
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
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["moltbot update status", "Show channel + version status."],
          ["moltbot update status --json", "JSON output."],
          ["moltbot update status --timeout 10", "Custom timeout."],
        ])}\n\n${theme.heading("Notes:")}\n${theme.muted(
          "- Shows current update channel (stable/beta/dev) and source",
        )}\n${theme.muted("- Includes git tag/branch/SHA for source checkouts")}\n\n${theme.muted(
          "Docs:",
        )} ${formatDocsLink("/cli/update", "docs.molt.bot/cli/update")}`,
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
