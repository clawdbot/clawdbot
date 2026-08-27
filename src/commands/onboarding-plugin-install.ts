/**
 * Onboarding plugin installation flow.
 *
 * It selects local, ClawHub, npm, or override install sources; records durable
 * install metadata; and enables plugins requested by setup workflows.
 */
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { resolveBundledInstallPlanForCatalogEntry } from "../cli/plugin-install-plan.js";
import { assertConfigWriteAllowedInCurrentMode } from "../config/nix-mode-write-guard.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { isOpenClawOrgNpmSpec, parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { isPathInside } from "../infra/path-guards.js";
import { normalizeUpdateChannel, resolveRegistryUpdateChannel } from "../infra/update-channels.js";
import {
  findBundledPluginSourceInMap,
  resolveBundledPluginSources,
} from "../plugins/bundled-sources.js";
import {
  CLAWHUB_INSTALL_ERROR_CODE,
  isUnavailableClawHubTarget,
} from "../plugins/clawhub-error-codes.js";
import { buildClawHubPluginInstallRecordFields } from "../plugins/clawhub-install-records.js";
import {
  enableExplicitlySelectedPluginInConfig,
  type PluginEnableResult,
} from "../plugins/enable.js";
import {
  installWithChannelFallback,
  resolveClawHubInstallSpecsForUpdateChannel,
  resolveNpmInstallSpecsForUpdateChannel,
} from "../plugins/install-channel-specs.js";
import {
  type PluginInstallOverride,
  resolvePluginInstallOverride,
  PLUGIN_INSTALL_OVERRIDES_ENV,
  ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV,
} from "../plugins/install-overrides.js";
import { resolveDefaultPluginExtensionsDir } from "../plugins/install-paths.js";
import { isUnavailableNpmTarget } from "../plugins/install-types.js";
import {
  installPluginFromNpmSpec,
  installPluginFromNpmPackArchive,
  type InstallPluginResult,
} from "../plugins/install.js";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "../plugins/installed-plugin-index-records.js";
import {
  buildNpmResolutionInstallFields,
  recordPluginInstall,
  resolveNpmInstallRecordSpec,
} from "../plugins/installs.js";
import type { PluginPackageInstall } from "../plugins/manifest.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { invalidatePluginRuntimeDiscoveryAfterConfigMutation } from "../plugins/registry-refresh.js";
import type { RuntimeEnv } from "../runtime.js";
import { withTimeout } from "../utils/with-timeout.js";
import { VERSION } from "../version.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";

type InstallChoice = "clawhub" | "npm" | "local" | "skip";
type InstallPluginFromClawHubResult = Awaited<
  ReturnType<(typeof import("../plugins/clawhub.js"))["installPluginFromClawHub"]>
>;
type InstallOutcome<T> = { status: "timed_out" } | { status: "completed"; result: T };
const ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const ONBOARDING_PLUGIN_INSTALL_WATCHDOG_TIMEOUT_MS = ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS + 5_000;

/** Catalog entry used by onboarding to offer or require a plugin install. */
export type OnboardingPluginInstallEntry = {
  pluginId: string;
  label: string;
  install: PluginPackageInstall;
  trustedSourceLinkedOfficialInstall?: boolean;
  /** Keep this official runtime package on the same release cohort as OpenClaw. */
  versionBoundToOpenClaw?: boolean;
  preferRemoteInstall?: boolean;
};

/** Outcome status for a single onboarding plugin install attempt. */
export type OnboardingPluginInstallStatus = "installed" | "skipped" | "failed" | "timed_out";

/** Config and status returned after attempting an onboarding plugin install. */
type OnboardingPluginInstallResult = {
  cfg: OpenClawConfig;
  installed: boolean;
  pluginId: string;
  status: OnboardingPluginInstallStatus;
  /** Sanitized actionable detail for non-interactive callers. */
  error?: string;
};

function incompletePluginInstall(
  cfg: OpenClawConfig,
  pluginId: string,
  status: Exclude<OnboardingPluginInstallStatus, "installed">,
  error?: string,
): OnboardingPluginInstallResult {
  return { cfg, installed: false, pluginId, status, ...(error === undefined ? {} : { error }) };
}

async function markOnboardingPluginInstalled(params: {
  cfg: OpenClawConfig;
  pluginId: string;
  runtime: RuntimeEnv;
}): Promise<OnboardingPluginInstallResult & { installed: true }> {
  // Onboarding has not committed config yet, so invalidate only process-local
  // discovery. The next lookup recovers the new package alongside persisted records.
  clearLoadInstalledPluginIndexInstallRecordsCache();
  clearPluginMetadataLifecycleCaches();
  await invalidatePluginRuntimeDiscoveryAfterConfigMutation({
    logger: { warn: (message) => params.runtime.log(message) },
  });
  return {
    cfg: params.cfg,
    installed: true,
    pluginId: params.pluginId,
    status: "installed",
  };
}

function shouldFallbackClawHubToNpm(params: {
  result: { ok: false; code?: string };
  npmSpec?: string;
}): boolean {
  if (!isOpenClawOrgNpmSpec(params.npmSpec)) {
    return false;
  }
  // Only official OpenClaw npm packages are safe fallback targets for ClawHub
  // availability failures; arbitrary npm fallbacks would change trust source.
  return (
    params.result.code === CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND ||
    params.result.code === CLAWHUB_INSTALL_ERROR_CODE.VERSION_NOT_FOUND ||
    params.result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_DOWNLOAD_UNAVAILABLE ||
    params.result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE
  );
}

function readInstallFailureWarning(result: InstallPluginFromClawHubResult): string | undefined {
  if (result.ok || !("warning" in result) || typeof result.warning !== "string") {
    return undefined;
  }
  return result.warning;
}

function resolveRealDirectory(dir: string): string | null {
  try {
    const resolved = fs.realpathSync(dir);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function resolveGitDirectoryMarker(dir: string): string | null {
  const marker = path.join(dir, ".git");
  try {
    const stat = fs.statSync(marker);
    if (stat.isDirectory()) {
      return resolveRealDirectory(marker);
    }
    if (!stat.isFile()) {
      return null;
    }
    const content = fs.readFileSync(marker, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/i.exec(content);
    if (!match) {
      return null;
    }
    const gitDir = match[1]?.trim();
    if (!gitDir) {
      return null;
    }
    return resolveRealDirectory(path.isAbsolute(gitDir) ? gitDir : path.resolve(dir, gitDir));
  } catch {
    return null;
  }
}

function hasTrustedGitWorkspace(root: string): boolean {
  const realRoot = resolveRealDirectory(root);
  if (!realRoot) {
    return false;
  }
  for (let dir = realRoot; ; dir = path.dirname(dir)) {
    if (resolveGitDirectoryMarker(dir)) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return false;
    }
  }
}

function hasGitWorkspace(workspaceDir?: string): boolean {
  const roots = [process.cwd()];
  if (workspaceDir && workspaceDir !== process.cwd()) {
    roots.push(workspaceDir);
  }
  return roots.some((root) => hasTrustedGitWorkspace(root));
}

function addPluginLoadPath(cfg: OpenClawConfig, pluginPath: string): OpenClawConfig {
  const existing = cfg.plugins?.load?.paths ?? [];
  const merged = uniqueStrings([...existing, pluginPath]);
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      load: {
        ...cfg.plugins?.load,
        paths: merged,
      },
    },
  };
}

function pathsReferToSameDirectory(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  const realLeft = resolveRealDirectory(left);
  const realRight = resolveRealDirectory(right);
  return Boolean(realLeft && realRight && realLeft === realRight);
}

function formatPortableLocalPath(localPath: string, workspaceDir?: string): string | undefined {
  const bases = [workspaceDir, process.cwd()].filter((entry): entry is string => Boolean(entry));
  for (const base of bases) {
    const realBase = resolveRealDirectory(base);
    if (!realBase) {
      continue;
    }
    if (isPathInside(realBase, localPath)) {
      const relative = path.relative(realBase, localPath);
      const portable = relative.split(path.sep).join("/");
      return portable ? `./${portable}` : ".";
    }
  }
  return undefined;
}

function recordLocalPluginInstall(params: {
  cfg: OpenClawConfig;
  entry: OnboardingPluginInstallEntry;
  localPath: string;
  npmSpec?: string | null;
  workspaceDir?: string;
}): OpenClawConfig {
  const sourcePath = formatPortableLocalPath(params.localPath, params.workspaceDir);
  const install = {
    pluginId: params.entry.pluginId,
    source: "path",
    ...(sourcePath ? { sourcePath } : {}),
    ...(params.npmSpec ? { spec: params.npmSpec } : {}),
  } as const;
  return recordPluginInstall(params.cfg, install);
}

function resolveLocalPath(params: {
  entry: OnboardingPluginInstallEntry;
  workspaceDir?: string;
  allowLocal: boolean;
}): string | null {
  if (!params.allowLocal) {
    return null;
  }
  const raw = params.entry.install.localPath?.trim();
  if (!raw) {
    return null;
  }
  const candidates = new Set<string>();
  const bases = [process.cwd()];
  if (params.workspaceDir && params.workspaceDir !== process.cwd()) {
    bases.push(params.workspaceDir);
  }
  for (const base of bases) {
    const realBase = resolveRealDirectory(base);
    if (!realBase) {
      continue;
    }
    candidates.add(path.resolve(realBase, raw));
  }
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      // Local plugin paths must stay inside the current repo/workspace roots so
      // catalog metadata cannot point setup at arbitrary filesystem locations.
      if (
        !bases.some((base) => {
          const realBase = resolveRealDirectory(base);
          return realBase ? isPathInside(realBase, resolved) : false;
        })
      ) {
        continue;
      }
      if (fs.statSync(resolved).isDirectory()) {
        return resolved;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function resolveBundledLocalPath(params: {
  entry: OnboardingPluginInstallEntry;
  workspaceDir?: string;
}): string | null {
  const bundledSources = resolveBundledPluginSources({ workspaceDir: params.workspaceDir });
  const npmSpec = params.entry.install.npmSpec?.trim();
  if (npmSpec) {
    return (
      resolveBundledInstallPlanForCatalogEntry({
        pluginId: params.entry.pluginId,
        npmSpec,
        findBundledSource: (lookup) =>
          findBundledPluginSourceInMap({
            bundled: bundledSources,
            lookup,
          }),
      })?.bundledSource.localPath ?? null
    );
  }
  return (
    findBundledPluginSourceInMap({
      bundled: bundledSources,
      lookup: {
        kind: "pluginId",
        value: params.entry.pluginId,
      },
    })?.localPath ?? null
  );
}

function resolveNpmSpecForOnboarding(install: PluginPackageInstall): string | null {
  const npmSpec = install.npmSpec?.trim();
  if (!npmSpec) {
    return null;
  }
  const parsed = parseRegistryNpmSpec(npmSpec);
  return parsed ? npmSpec : null;
}

function resolveClawHubSpecForOnboarding(install: PluginPackageInstall): string | null {
  const clawhubSpec = install.clawhubSpec?.trim();
  if (!clawhubSpec) {
    return null;
  }
  const parsed = parseClawHubPluginSpec(clawhubSpec);
  return parsed ? clawhubSpec : null;
}

function resolveInstallDefaultChoice(params: {
  cfg: OpenClawConfig;
  entry: OnboardingPluginInstallEntry;
  localPath?: string | null;
  bundledLocalPath?: string | null;
  hasClawHubSpec: boolean;
  hasNpmSpec: boolean;
}): InstallChoice {
  const { cfg, entry, localPath, bundledLocalPath, hasClawHubSpec, hasNpmSpec } = params;
  const hasRemoteSpec = hasClawHubSpec || hasNpmSpec;
  const entryDefault = entry.install.defaultChoice;
  const remoteDefault = (): InstallChoice => {
    if (entryDefault === "clawhub" && hasClawHubSpec) {
      return "clawhub";
    }
    if (entryDefault === "npm" && hasNpmSpec) {
      return "npm";
    }
    return hasNpmSpec ? "npm" : "clawhub";
  };
  if (!hasRemoteSpec) {
    return localPath ? "local" : "skip";
  }
  if (!localPath) {
    return remoteDefault();
  }
  if (bundledLocalPath) {
    return "local";
  }
  const updateChannel = cfg.update?.channel;
  // Dev builds prefer checked-out local plugins; stable/beta prefer published
  // artifacts so installed records match the user's release channel.
  if (updateChannel === "dev") {
    return "local";
  }
  if (
    updateChannel === "stable" ||
    updateChannel === "extended-stable" ||
    updateChannel === "beta"
  ) {
    return remoteDefault();
  }
  if (entryDefault === "local") {
    return "local";
  }
  return remoteDefault();
}

async function promptInstallChoice(params: {
  entry: OnboardingPluginInstallEntry;
  localPath?: string | null;
  bundledLocalPath?: string | null;
  defaultChoice: InstallChoice;
  prompter: WizardPrompter;
  /** Skip the redundant prompt when the caller already chose the only viable source. */
  autoConfirmSingleSource?: boolean;
  effectiveNpmSpec?: string | null;
  effectiveClawHubSpec?: string | null;
}): Promise<InstallChoice> {
  const rawClawHubSpec = resolveClawHubSpecForOnboarding(params.entry.install);
  const rawNpmSpec = resolveNpmSpecForOnboarding(params.entry.install);
  // Bundled plugins are version-locked to the host; remote specs are fallback metadata only.
  const clawhubSpec = params.bundledLocalPath
    ? null
    : (params.effectiveClawHubSpec ?? rawClawHubSpec);
  const npmSpec = params.bundledLocalPath ? null : (params.effectiveNpmSpec ?? rawNpmSpec);
  const safeLabel = sanitizeTerminalText(params.entry.label);
  const safeClawHubSpec = clawhubSpec ? sanitizeTerminalText(clawhubSpec) : null;
  const safeNpmSpec = npmSpec ? sanitizeTerminalText(npmSpec) : null;
  const safeLocalPath = params.localPath ? sanitizeTerminalText(params.localPath) : null;
  const options: Array<{ value: InstallChoice; label: string; hint?: string }> = [];
  if (safeClawHubSpec) {
    options.push({
      value: "clawhub",
      label: t("wizard.plugins.downloadFromClawHub", { spec: safeClawHubSpec }),
    });
  }
  if (safeNpmSpec) {
    options.push({
      value: "npm",
      label: t("wizard.plugins.downloadFromNpm", { spec: safeNpmSpec }),
    });
  }
  if (params.localPath) {
    options.push({
      value: "local",
      label: t("wizard.plugins.useLocalPluginPath"),
      ...(safeLocalPath ? { hint: safeLocalPath } : {}),
    });
  }

  if (params.autoConfirmSingleSource) {
    const realSources: InstallChoice[] = [];
    if (safeClawHubSpec) {
      realSources.push("clawhub");
    }
    if (safeNpmSpec) {
      realSources.push("npm");
    }
    if (params.localPath) {
      realSources.push("local");
    }
    if (realSources.length === 1) {
      return expectDefined(realSources[0], "real sources entry at 0");
    }
  }

  options.push({ value: "skip", label: t("common.skipForNow") });

  const initialValue =
    params.defaultChoice === "local" && !params.localPath
      ? clawhubSpec
        ? "clawhub"
        : npmSpec
          ? "npm"
          : "skip"
      : params.defaultChoice === "clawhub" && !clawhubSpec
        ? npmSpec
          ? "npm"
          : params.localPath
            ? "local"
            : "skip"
        : params.defaultChoice === "npm" && !npmSpec
          ? clawhubSpec
            ? "clawhub"
            : params.localPath
              ? "local"
              : "skip"
          : params.defaultChoice;

  return await params.prompter.select<InstallChoice>({
    message: t("wizard.plugins.installPluginPrompt", { plugin: safeLabel }),
    options,
    initialValue,
  });
}

function formatDurationLabel(timeoutMs: number): string {
  if (timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return t(minutes === 1 ? "common.minute" : "common.minutes", { count: minutes });
  }
  const seconds = Math.round(timeoutMs / 1000);
  return t(seconds === 1 ? "common.second" : "common.seconds", { count: seconds });
}

function formatPluginInstallProgress(label: string): string {
  return t("wizard.plugins.installingPlugin", { plugin: label });
}

function formatPluginInstalled(label: string): string {
  return t("wizard.plugins.installedPlugin", { plugin: label });
}

function formatPluginInstallFailed(label: string): string {
  return t("wizard.plugins.installFailedShort", { plugin: label });
}

function formatPluginInstallTimedOut(label: string): string {
  return t("wizard.plugins.installTimedOutShort", { plugin: label });
}

function formatPluginInstallTimedOutNote(spec: string): string {
  return [
    t("wizard.plugins.installTimedOut", {
      spec,
      duration: formatDurationLabel(ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS),
    }),
    t("wizard.plugins.returningToSelection"),
  ].join("\n");
}

function summarizeInstallError(message: string): string {
  const cleaned = sanitizeTerminalText(message)
    .replace(/^Install failed(?:\s*\([^)]*\))?\s*:?\s*/i, "")
    .trim();
  if (!cleaned) {
    return "Unknown install failure";
  }
  return cleaned.length > 180 ? `${truncateUtf16Safe(cleaned, 179)}…` : cleaned;
}

const ONBOARDING_PLUGIN_INSTALL_ERROR_MAX_CHARS = 12_000;

function formatInstallErrorDetail(message: string): string {
  const cleaned = message
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => sanitizeTerminalText(line))
    .join("\n")
    .trim();
  if (cleaned.length <= ONBOARDING_PLUGIN_INSTALL_ERROR_MAX_CHARS) {
    return cleaned;
  }
  const marker = "\n… (installer output truncated)";
  return `${truncateUtf16Safe(cleaned, ONBOARDING_PLUGIN_INSTALL_ERROR_MAX_CHARS - marker.length).trimEnd()}${marker}`;
}

async function notePluginInstallFailure(
  prompter: WizardPrompter,
  spec: string,
  error: string,
): Promise<void> {
  await prompter.note(
    [
      t("wizard.plugins.installFailed", {
        spec: sanitizeTerminalText(spec),
        error: summarizeInstallError(error),
      }),
      t("wizard.plugins.returningToSelection"),
    ].join("\n"),
    t("wizard.plugins.installTitle"),
  );
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === "timeout";
}

async function applyPluginEnablement(params: {
  cfg: OpenClawConfig;
  pluginId: string;
  label: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}): Promise<PluginEnableResult> {
  const enableResult = enableExplicitlySelectedPluginInConfig(params.cfg, params.pluginId);
  if (enableResult.enabled) {
    return enableResult;
  }
  const safeLabel = sanitizeTerminalText(params.label);
  const reason = enableResult.reason ?? "plugin disabled";
  await params.prompter.note(
    t("wizard.plugins.enableFailed", { plugin: safeLabel, reason }),
    t("wizard.plugins.installTitle"),
  );
  params.runtime.error?.(
    `Plugin install failed: ${sanitizeTerminalText(params.pluginId)} is disabled (${reason}).`,
  );
  return enableResult;
}

async function finishOnboardingPluginInstall(params: {
  cfg: OpenClawConfig;
  pluginId: string;
  label: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  install?: Parameters<typeof recordPluginInstall>[1];
  prepareConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
}): Promise<OnboardingPluginInstallResult> {
  const enableResult = await applyPluginEnablement(params);
  if (!enableResult.enabled) {
    return incompletePluginInstall(enableResult.config, params.pluginId, "failed");
  }
  return await markOnboardingPluginInstalled({
    cfg: params.install
      ? recordPluginInstall(enableResult.config, params.install)
      : (params.prepareConfig?.(enableResult.config) ?? enableResult.config),
    pluginId: params.pluginId,
    runtime: params.runtime,
  });
}

async function installLocalOnboardingPlugin(params: {
  cfg: OpenClawConfig;
  entry: OnboardingPluginInstallEntry;
  localPath: string;
  bundledLocalPath: string | null;
  npmSpec: string | null;
  workspaceDir?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}): Promise<OnboardingPluginInstallResult> {
  return await finishOnboardingPluginInstall({
    cfg: params.cfg,
    pluginId: params.entry.pluginId,
    label: params.entry.label,
    prompter: params.prompter,
    runtime: params.runtime,
    // Bundled sources already belong to the host and need no record or load path.
    prepareConfig: (cfg) =>
      pathsReferToSameDirectory(params.localPath, params.bundledLocalPath)
        ? cfg
        : recordLocalPluginInstall({
            cfg: addPluginLoadPath(cfg, params.localPath),
            entry: params.entry,
            localPath: params.localPath,
            npmSpec: params.npmSpec,
            workspaceDir: params.workspaceDir,
          }),
  });
}

type AnimatedProgress = {
  setLabel: (label: string) => void;
  stop: () => void;
};

const PROGRESS_BAR_WIDTH = 16;
const PROGRESS_BAR_TICK_MS = 200;
const PROGRESS_BAR_DURATION_MS = 10_000;
const PROGRESS_BAR_MAX_PERCENT = 99;

/** Shortens known install steps while preserving unfamiliar output verbatim. */
function shortenInstallLabel(message: string): string {
  const trimmed = message.trim();
  const patterns: Array<[RegExp, string]> = [
    [/^Downloading\b/i, "Downloading"],
    [/^Extracting\b/i, "Extracting"],
    [/^Installing\s+to\b/i, "Installing"],
    [/^Installing\b/i, "Installing"],
    [/^Resolving\b/i, "Resolving"],
    [/^Cloning\b/i, "Cloning"],
    [/^Verifying\b/i, "Verifying"],
    [/^Preparing\b/i, "Preparing"],
    [/^Linking\b/i, "Linking"],
    [/^Linked\b/i, "Linking"],
    [/^npm rejected managed npm alias overrides\b/i, "Retrying"],
    [/^Compatibility\b/i, "Resolving"],
    [/^ClawHub\b/i, "Resolving"],
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(trimmed)) {
      return label;
    }
  }
  return trimmed;
}

/** Adds a steadily growing, 99%-capped bar between coarse installer updates. */
function createAnimatedInstallProgress(
  progress: { update: (message: string) => void },
  options: { totalMs?: number } = {},
): AnimatedProgress {
  const totalMs = options.totalMs ?? PROGRESS_BAR_DURATION_MS;
  let currentLabel = "";
  const startedAt = Date.now();

  const computePercent = (): number => {
    const elapsed = Date.now() - startedAt;
    const raw = Math.floor((elapsed / totalMs) * 100);
    return Math.max(0, Math.min(PROGRESS_BAR_MAX_PERCENT, raw));
  };

  const renderBar = (): string => {
    const percent = computePercent();
    const filled = Math.round((percent / 100) * PROGRESS_BAR_WIDTH);
    const bar = "█".repeat(filled) + "░".repeat(Math.max(0, PROGRESS_BAR_WIDTH - filled));
    return `[${bar}] ${percent}%`;
  };

  const decorate = (label: string): string => {
    if (!label) {
      return renderBar();
    }
    return `${label}  ${renderBar()}`;
  };

  const timer = setInterval(() => {
    if (currentLabel) {
      progress.update(decorate(currentLabel));
    }
  }, PROGRESS_BAR_TICK_MS);
  // Decorative progress must never keep the process alive.
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    setLabel: (label: string) => {
      currentLabel = label;
      // Emit the bare label before decorated animation frames.
      progress.update(label);
    },
    stop: () => {
      clearInterval(timer);
    },
  };
}

function logInstallWarningWithSpacing(runtime: RuntimeEnv, message: string): void {
  const sanitized = sanitizeTerminalText(message).trim();
  if (!sanitized) {
    return;
  }
  runtime.log?.(`${sanitized}\n`);
}

function logInstallWarningWithLineBreaks(runtime: RuntimeEnv, message: string): void {
  const sanitized = message
    .split("\n")
    .map((line) => sanitizeTerminalText(line))
    .join("\n")
    .trim();
  if (!sanitized) {
    return;
  }
  runtime.log?.(`${sanitized}\n`);
}

function isReviewRequiredClawHubTrustWarning(message: string): boolean {
  return message.includes("WARNING - ClawHub found security risks");
}

function isClawHubTrustWarning(message: string): boolean {
  return (
    isReviewRequiredClawHubTrustWarning(message) ||
    message.includes("BLOCKED - ClawHub") ||
    message.includes("REVIEW RECOMMENDED - ClawHub")
  );
}

async function runInstallWatchdog<T>(install: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const ownedInstallPromise = install(controller.signal);
  try {
    return await withTimeout(ownedInstallPromise, ONBOARDING_PLUGIN_INSTALL_WATCHDOG_TIMEOUT_MS);
  } catch (error) {
    if (isTimeoutError(error)) {
      // Cancel owned child processes, then retain the lifecycle lease through rollback.
      controller.abort();
      await ownedInstallPromise.catch(() => undefined);
    }
    throw error;
  }
}

async function runOnboardingPluginInstallWithProgress(params: {
  cfg: OpenClawConfig;
  entry: OnboardingPluginInstallEntry;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  install: (
    logger: {
      info: (message: string) => void;
      warn: (message: string) => void;
    },
    signal: AbortSignal,
  ) => Promise<InstallPluginResult>;
  rethrowUnexpectedErrors?: boolean;
}): Promise<InstallOutcome<InstallPluginResult>> {
  const safeLabel = sanitizeTerminalText(params.entry.label);
  const progress = params.prompter.progress(formatPluginInstallProgress(safeLabel));
  const animated = createAnimatedInstallProgress(progress);
  animated.setLabel(t("wizard.plugins.preparingInstall"));
  const updateProgress = (message: string) => {
    const sanitized = sanitizeTerminalText(message).trim();
    if (!sanitized) {
      return;
    }
    animated.setLabel(shortenInstallLabel(sanitized));
  };

  try {
    const result = await runInstallWatchdog((signal) =>
      params.install(
        {
          info: updateProgress,
          warn: (message) => {
            updateProgress(message);
            logInstallWarningWithSpacing(params.runtime, message);
          },
        },
        signal,
      ),
    );
    progress.stop(
      result.ok ? formatPluginInstalled(safeLabel) : formatPluginInstallFailed(safeLabel),
    );
    return { status: "completed", result };
  } catch (error) {
    if (isTimeoutError(error)) {
      progress.stop(formatPluginInstallTimedOut(safeLabel));
      return { status: "timed_out" };
    }
    progress.stop(formatPluginInstallFailed(safeLabel));
    if (params.rethrowUnexpectedErrors) {
      throw error;
    }
    return {
      status: "completed",
      result: {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    animated.stop();
  }
}

async function installPluginFromNpmSpecWithProgress(params: {
  cfg: OpenClawConfig;
  entry: OnboardingPluginInstallEntry;
  npmSpec: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  trustedSourceLinkedOfficialInstall?: boolean;
}): Promise<InstallOutcome<InstallPluginResult>> {
  return await runOnboardingPluginInstallWithProgress({
    ...params,
    install: (logger, signal) =>
      installPluginFromNpmSpec({
        spec: params.npmSpec,
        mode: "update",
        config: params.cfg,
        timeoutMs: ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS,
        expectedPluginId: params.entry.pluginId,
        expectedIntegrity: params.entry.install.expectedIntegrity,
        ...((params.trustedSourceLinkedOfficialInstall ??
        params.entry.trustedSourceLinkedOfficialInstall)
          ? { trustedSourceLinkedOfficialInstall: true }
          : {}),
        extensionsDir: resolveDefaultPluginExtensionsDir(),
        logger,
        signal,
      }),
  });
}

async function installPluginFromNpmPackArchiveWithProgress(params: {
  cfg: OpenClawConfig;
  entry: OnboardingPluginInstallEntry;
  archivePath: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}): Promise<InstallOutcome<InstallPluginResult & { npmTarballName?: string }>> {
  return await runOnboardingPluginInstallWithProgress({
    ...params,
    install: (logger, signal) =>
      installPluginFromNpmPackArchive({
        archivePath: params.archivePath,
        timeoutMs: ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS,
        config: params.cfg,
        expectedPluginId: params.entry.pluginId,
        expectedIntegrity: params.entry.install.expectedIntegrity,
        extensionsDir: resolveDefaultPluginExtensionsDir(),
        logger,
        signal,
      }),
    // Archive overrides retain their existing unexpected-error contract.
    rethrowUnexpectedErrors: true,
  });
}

async function installPluginFromOverride(params: {
  cfg: OpenClawConfig;
  entry: OnboardingPluginInstallEntry;
  override: PluginInstallOverride;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}): Promise<OnboardingPluginInstallResult> {
  const { entry, prompter, runtime } = params;
  runtime.log?.(
    `Using plugin install override for ${sanitizeTerminalText(entry.pluginId)} from ${PLUGIN_INSTALL_OVERRIDES_ENV} (${ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV}=1).`,
  );
  // Overrides are explicit operator/developer input and intentionally bypass
  // catalog trust defaults while still recording the resulting install source.
  const installOutcome =
    params.override.kind === "npm"
      ? await installPluginFromNpmSpecWithProgress({
          cfg: params.cfg,
          entry,
          npmSpec: params.override.spec,
          prompter,
          runtime,
          trustedSourceLinkedOfficialInstall: false,
        })
      : await installPluginFromNpmPackArchiveWithProgress({
          cfg: params.cfg,
          entry,
          archivePath: params.override.archivePath,
          prompter,
          runtime,
        });

  const displaySpec =
    params.override.kind === "npm"
      ? params.override.spec
      : `npm-pack:${params.override.archivePath}`;
  if (installOutcome.status === "timed_out") {
    await prompter.note(
      formatPluginInstallTimedOutNote(sanitizeTerminalText(displaySpec)),
      t("wizard.plugins.installTitle"),
    );
    runtime.error?.(
      `Plugin install timed out after ${ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS}ms: ${sanitizeTerminalText(displaySpec)}`,
    );
    return incompletePluginInstall(params.cfg, entry.pluginId, "timed_out");
  }

  const { result } = installOutcome;
  if (!result.ok) {
    const errorDetail = formatInstallErrorDetail(result.error);
    await notePluginInstallFailure(prompter, displaySpec, result.error);
    runtime.error?.(`Plugin install failed: ${summarizeInstallError(result.error)}`);
    return incompletePluginInstall(params.cfg, entry.pluginId, "failed", errorDetail);
  }

  const npmTarballName =
    params.override.kind === "npm-pack"
      ? (result as InstallPluginResult & { npmTarballName?: string }).npmTarballName
      : undefined;
  const install =
    params.override.kind === "npm-pack"
      ? ({
          pluginId: result.pluginId,
          source: "npm",
          spec: result.npmResolution?.resolvedSpec ?? result.manifestName ?? result.pluginId,
          sourcePath: params.override.archivePath,
          installPath: result.targetDir,
          ...(result.version ? { version: result.version } : {}),
          ...buildNpmResolutionInstallFields(result.npmResolution),
          artifactKind: "npm-pack",
          artifactFormat: "tgz",
          ...(result.npmResolution?.integrity
            ? { npmIntegrity: result.npmResolution.integrity }
            : {}),
          ...(result.npmResolution?.shasum ? { npmShasum: result.npmResolution.shasum } : {}),
          ...(npmTarballName ? { npmTarballName } : {}),
        } as const)
      : ({
          pluginId: result.pluginId,
          source: "npm",
          spec: params.override.spec,
          installPath: result.targetDir,
          ...(result.version ? { version: result.version } : {}),
          ...buildNpmResolutionInstallFields(result.npmResolution),
        } as const);
  return await finishOnboardingPluginInstall({
    cfg: params.cfg,
    pluginId: result.pluginId,
    label: entry.label,
    prompter,
    runtime,
    install,
  });
}

async function installPluginFromClawHubSpecWithProgress(params: {
  cfg: OpenClawConfig;
  entry: OnboardingPluginInstallEntry;
  clawhubSpec: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}): Promise<InstallPluginFromClawHubResult> {
  const safeLabel = sanitizeTerminalText(params.entry.label);
  const progress = params.prompter.progress(formatPluginInstallProgress(safeLabel));
  const animated = createAnimatedInstallProgress(progress);
  animated.setLabel(t("wizard.plugins.preparingInstall"));
  const updateProgress = (message: string) => {
    const sanitized = sanitizeTerminalText(message).trim();
    if (!sanitized) {
      return;
    }
    animated.setLabel(shortenInstallLabel(sanitized));
  };
  let renderedTrustWarning = false;
  const renderTrustWarning = (message: string) => {
    logInstallWarningWithLineBreaks(params.runtime, message);
    renderedTrustWarning = true;
  };

  try {
    const { installPluginFromClawHub } = await import("../plugins/clawhub.js");
    const result = await installPluginFromClawHub({
      spec: params.clawhubSpec,
      timeoutMs: ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS,
      config: params.cfg,
      extensionsDir: resolveDefaultPluginExtensionsDir(),
      expectedPluginId: params.entry.pluginId,
      mode: "install",
      logger: {
        info: updateProgress,
        warn: (message) => {
          updateProgress(message);
          if (isReviewRequiredClawHubTrustWarning(message)) {
            return;
          }
          if (isClawHubTrustWarning(message)) {
            renderTrustWarning(message);
            return;
          }
          logInstallWarningWithSpacing(params.runtime, message);
        },
      },
      onClawHubRisk: async (request) => {
        animated.stop();
        progress.stop("Review ClawHub warning");
        renderTrustWarning(request.warning);
        const packageName = sanitizeTerminalText(request.packageName);
        const releaseLabel = `${packageName}@${sanitizeTerminalText(request.version)}`;
        if (request.acknowledgementKind === "type-package") {
          const answer = await params.prompter.text({
            message: `To install anyway, type the package name for "${releaseLabel}"`,
            placeholder: packageName,
          });
          return answer.trim() === packageName;
        }
        return await params.prompter.confirm({
          message: `Install ClawHub package "${releaseLabel}" after reviewing the warning above?`,
          initialValue: false,
        });
      },
    });
    animated.stop();
    const failureWarning = readInstallFailureWarning(result);
    if (failureWarning && !renderedTrustWarning) {
      progress.stop("Review ClawHub warning");
      renderTrustWarning(failureWarning);
    }
    if (result.ok) {
      progress.stop(formatPluginInstalled(safeLabel));
    } else {
      progress.stop(formatPluginInstallFailed(safeLabel));
    }
    return result;
  } catch (error) {
    animated.stop();
    progress.stop(formatPluginInstallFailed(safeLabel));
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Ensures an onboarding plugin is installed, enabled, and recorded in config. */
export async function ensureOnboardingPluginInstalled(params: {
  cfg: OpenClawConfig;
  entry: OnboardingPluginInstallEntry;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
  promptInstall?: boolean;
  autoConfirmSingleSource?: boolean;
  beforePersistentEffect?: () => Promise<void>;
}): Promise<OnboardingPluginInstallResult> {
  const { entry, prompter, runtime, workspaceDir } = params;
  const next = params.cfg;
  const installOverride = resolvePluginInstallOverride({ pluginId: entry.pluginId });
  if (installOverride) {
    // Any install override mutates config/install records, so guard it with the
    // same write-mode check as normal installs.
    assertConfigWriteAllowedInCurrentMode();
    await params.beforePersistentEffect?.();
    return await withPluginLifecycleLease({}, async () =>
      installPluginFromOverride({
        cfg: next,
        entry,
        override: installOverride,
        prompter,
        runtime,
      }),
    );
  }
  const allowLocal = hasGitWorkspace(workspaceDir);
  const bundledLocalPath = entry.preferRemoteInstall
    ? null
    : resolveBundledLocalPath({ entry, workspaceDir });
  const localPath =
    bundledLocalPath ??
    (entry.preferRemoteInstall
      ? null
      : resolveLocalPath({
          entry,
          workspaceDir,
          allowLocal,
        }));
  const clawhubSpec = resolveClawHubSpecForOnboarding(entry.install);
  const npmSpec = resolveNpmSpecForOnboarding(entry.install);
  const updateChannel = resolveRegistryUpdateChannel({
    configChannel: normalizeUpdateChannel(next.update?.channel),
    currentVersion: VERSION,
  });
  const clawhubSpecs = clawhubSpec
    ? resolveClawHubInstallSpecsForUpdateChannel({
        spec: clawhubSpec,
        updateChannel,
      })
    : null;
  const npmSpecs = npmSpec
    ? resolveNpmInstallSpecsForUpdateChannel({
        spec: npmSpec,
        updateChannel,
        officialPackageName: entry.trustedSourceLinkedOfficialInstall
          ? parseRegistryNpmSpec(npmSpec)?.name
          : undefined,
        coreVersion: VERSION,
        versionBoundToCore: entry.versionBoundToOpenClaw,
      })
    : null;
  const clawhubInstallSpec = clawhubSpecs?.installSpec ?? clawhubSpec;
  const npmInstallSpec = npmSpecs?.installSpec ?? npmSpec;
  const defaultChoice = resolveInstallDefaultChoice({
    cfg: next,
    entry,
    localPath,
    bundledLocalPath,
    hasClawHubSpec: Boolean(clawhubSpec),
    hasNpmSpec: Boolean(npmSpec),
  });
  const choice =
    params.promptInstall === false
      ? defaultChoice
      : await promptInstallChoice({
          entry,
          localPath,
          bundledLocalPath,
          defaultChoice,
          prompter,
          autoConfirmSingleSource: params.autoConfirmSingleSource,
          effectiveClawHubSpec: clawhubInstallSpec,
          effectiveNpmSpec: npmInstallSpec,
        });

  if (choice === "skip") {
    return incompletePluginInstall(next, entry.pluginId, "skipped");
  }
  assertConfigWriteAllowedInCurrentMode();

  return await withPluginLifecycleLease({}, async () => {
    if (choice === "local" && localPath) {
      return await installLocalOnboardingPlugin({
        cfg: next,
        entry,
        localPath,
        bundledLocalPath,
        npmSpec,
        workspaceDir,
        prompter,
        runtime,
      });
    }

    let shouldTryNpm = choice === "npm";
    if (choice === "clawhub" && clawhubInstallSpec) {
      await params.beforePersistentEffect?.();
      let usedClawHubSpec = clawhubInstallSpec;
      const result = await installWithChannelFallback({
        installSpec: clawhubInstallSpec,
        // An integrity pin identifies one exact artifact, so it outranks the channel.
        ...(entry.install.expectedIntegrity ? {} : { fallbackSpec: clawhubSpecs?.fallbackSpec }),
        install: async (spec) => {
          usedClawHubSpec = spec;
          return await installPluginFromClawHubSpecWithProgress({
            cfg: next,
            entry,
            clawhubSpec: spec,
            prompter,
            runtime,
          });
        },
        isRetryable: (attempt) => !attempt.ok && isUnavailableClawHubTarget(attempt),
        onFallback: async (message) => {
          await prompter.note(message, t("wizard.plugins.installTitle"));
        },
      });
      if (result.ok) {
        return await finishOnboardingPluginInstall({
          cfg: next,
          pluginId: result.pluginId,
          label: entry.label,
          prompter,
          runtime,
          install: {
            pluginId: result.pluginId,
            ...buildClawHubPluginInstallRecordFields(result.clawhub),
            spec: clawhubSpecs?.recordSpec ?? clawhubInstallSpec,
            installPath: result.targetDir,
          },
        });
      }

      await notePluginInstallFailure(prompter, usedClawHubSpec, result.error);
      const errorDetail = formatInstallErrorDetail(result.error);

      if (!npmInstallSpec || !shouldFallbackClawHubToNpm({ result, npmSpec: npmInstallSpec })) {
        runtime.error?.(`Plugin install failed: ${summarizeInstallError(result.error)}`);
        return incompletePluginInstall(next, entry.pluginId, "failed", errorDetail);
      }

      // ClawHub package/version misses for official packages can recover through
      // npm, but keep the operator in control before changing install source.
      shouldTryNpm = await prompter.confirm({
        message: t("wizard.plugins.useNpmPackageInstead", {
          spec: sanitizeTerminalText(npmInstallSpec),
        }),
        initialValue: true,
      });
      if (!shouldTryNpm) {
        runtime.error?.(`Plugin install failed: ${summarizeInstallError(result.error)}`);
        return incompletePluginInstall(next, entry.pluginId, "failed", errorDetail);
      }
    }

    if (!shouldTryNpm || !npmInstallSpec) {
      await prompter.note(
        t("wizard.plugins.noRemoteInstallSource", {
          plugin: sanitizeTerminalText(entry.label),
        }),
        t("wizard.plugins.installTitle"),
      );
      runtime.error?.(
        `Plugin install failed: no remote spec available for ${sanitizeTerminalText(entry.pluginId)}.`,
      );
      return incompletePluginInstall(next, entry.pluginId, "failed");
    }

    await params.beforePersistentEffect?.();
    const installOutcome = await installWithChannelFallback({
      installSpec: npmInstallSpec,
      // An integrity pin identifies one exact artifact, so it outranks the channel.
      ...(entry.install.expectedIntegrity ? {} : { fallbackSpec: npmSpecs?.fallbackSpec }),
      install: async (spec) =>
        await installPluginFromNpmSpecWithProgress({
          cfg: next,
          entry,
          npmSpec: spec,
          prompter,
          runtime,
        }),
      isRetryable: (outcome) =>
        outcome.status === "completed" &&
        !outcome.result.ok &&
        isUnavailableNpmTarget(outcome.result),
      onFallback: async (message) => {
        await prompter.note(message, t("wizard.plugins.installTitle"));
      },
    });

    if (installOutcome.status === "timed_out") {
      await prompter.note(
        formatPluginInstallTimedOutNote(sanitizeTerminalText(npmInstallSpec)),
        t("wizard.plugins.installTitle"),
      );
      runtime.error?.(
        `Plugin install timed out after ${ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS}ms: ${sanitizeTerminalText(npmInstallSpec)}`,
      );
      return incompletePluginInstall(next, entry.pluginId, "timed_out");
    }

    const { result } = installOutcome;

    if (result.ok) {
      return await finishOnboardingPluginInstall({
        cfg: next,
        pluginId: result.pluginId,
        label: entry.label,
        prompter,
        runtime,
        install: {
          pluginId: result.pluginId,
          source: "npm",
          spec: resolveNpmInstallRecordSpec({
            requestedSpec: npmSpecs?.recordSpec ?? npmInstallSpec,
            resolution: result.npmResolution,
            pinResolvedRegistrySpec: false,
          }),
          installPath: result.targetDir,
          version: result.version,
          ...buildNpmResolutionInstallFields(result.npmResolution),
        },
      });
    }

    await notePluginInstallFailure(prompter, npmInstallSpec, result.error);

    if (localPath) {
      // If npm fails and a trusted local checkout exists, offer it as a recovery
      // path instead of leaving setup stuck on the remote artifact.
      const fallback = await prompter.confirm({
        message: t("wizard.plugins.useLocalPluginPathInstead", {
          path: sanitizeTerminalText(localPath),
        }),
        initialValue: true,
      });
      if (fallback) {
        return await installLocalOnboardingPlugin({
          cfg: next,
          entry,
          localPath,
          bundledLocalPath,
          npmSpec,
          workspaceDir,
          prompter,
          runtime,
        });
      }
    }

    const errorDetail = formatInstallErrorDetail(result.error);
    runtime.error?.(`Plugin install failed: ${summarizeInstallError(result.error)}`);
    return incompletePluginInstall(next, entry.pluginId, "failed", errorDetail);
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
