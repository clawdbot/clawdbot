import fs from "node:fs";
import { collectChannelDoctorStaleConfigMutations } from "../commands/doctor/shared/channel-doctor.js";
import { assertConfigWriteAllowedInCurrentMode, readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { installHooksFromNpmSpec, installHooksFromPath } from "../hooks/install.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { parseClawHubPluginSpec } from "../infra/clawhub.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type BundledPluginSource, findBundledPluginSource } from "../plugins/bundled-sources.js";
import { buildClawHubPluginInstallRecordFields } from "../plugins/clawhub-install-records.js";
import { installPluginFromClawHub } from "../plugins/clawhub.js";
import { installPluginFromGitSpec, parseGitPluginSpec } from "../plugins/git-install.js";
import { resolveDefaultPluginExtensionsDir } from "../plugins/install-paths.js";
import type { InstallSafetyOverrides } from "../plugins/install-security-scan.js";
import {
  PLUGIN_INSTALL_ERROR_CODE,
  installPluginFromNpmPackArchive,
  installPluginFromNpmSpec,
  installPluginFromPath,
} from "../plugins/install.js";
import {
  installPluginFromMarketplace,
  resolveMarketplaceInstallShortcut,
} from "../plugins/marketplace.js";
import {
  getOfficialExternalPluginCatalogEntryForPackage,
  getOfficialExternalPluginCatalogEntry,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "../plugins/official-external-plugin-catalog.js";
import { tracePluginLifecyclePhaseAsync } from "../plugins/plugin-lifecycle-trace.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";
import { looksLikeLocalInstallSpec } from "./install-spec.js";
import { resolvePinnedNpmInstallRecordForCli } from "./npm-resolution.js";
import {
  resolvePluginInstallInvalidConfigPolicy,
  resolvePluginInstallRequestContext,
  type PluginInstallRequestContext,
} from "./plugin-install-config-policy.js";
import {
  resolveBundledInstallPlanBeforeNpm,
  resolveBundledInstallPlanForNpmFailure,
  resolveOfficialExternalInstallPlanBeforeNpm,
  resolveOfficialExternalNpmPackageTrust,
} from "./plugin-install-plan.js";
import {
  createHookPackInstallLogger,
  createPluginInstallLogger,
  formatPluginInstallWithHookFallbackError,
  parseNpmPackPrefixPath,
  parseNpmPrefixSpec,
} from "./plugins-command-helpers.js";
import { persistHookPackInstall, persistPluginInstall } from "./plugins-install-persist.js";
import type { ConfigSnapshotForInstallPersist } from "./plugins-install-persist.js";

function resolveInstallMode(force?: boolean): "install" | "update" {
  return force ? "update" : "install";
}

function resolveInstallSafetyOverrides(overrides: InstallSafetyOverrides): InstallSafetyOverrides {
  return {
    dangerouslyForceUnsafeInstall: overrides.dangerouslyForceUnsafeInstall,
  };
}

function findTrustedCatalogPackageInstall(packageName: string):
  | {
      pluginId: string;
      npmSpec?: string;
      expectedIntegrity?: string;
    }
  | undefined {
  // The catalog is the trust list. Raw npm selectors such as
  // @scope/pkg@latest inherit install-scan trust when their package name is
  // cataloged; integrity remains tied to exact catalog specs in the planner.
  const entry = getOfficialExternalPluginCatalogEntryForPackage(packageName);
  if (!entry) {
    return undefined;
  }
  const pluginId = resolveOfficialExternalPluginId(entry);
  if (!pluginId) {
    return undefined;
  }
  const install = resolveOfficialExternalPluginInstall(entry);
  return {
    pluginId,
    ...(install?.npmSpec ? { npmSpec: install.npmSpec } : {}),
    ...(install?.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isEmptyRecord(value: Record<string, unknown>): boolean {
  return Object.keys(value).length === 0;
}

function hasValidBundledPluginConfig(params: {
  bundledSource: BundledPluginSource;
  existingEntry: unknown;
}): boolean {
  if (!params.bundledSource.requiresConfig) {
    return true;
  }
  if (!isRecord(params.existingEntry)) {
    return false;
  }
  const config = params.existingEntry.config;
  if (!isRecord(config)) {
    return false;
  }
  if (!params.bundledSource.configSchema) {
    return !isEmptyRecord(config);
  }
  return validateJsonSchemaValue({
    schema: params.bundledSource.configSchema,
    cacheKey: `bundled-install:${params.bundledSource.pluginId}`,
    value: config,
    applyDefaults: true,
  }).ok;
}

function prepareConfigForDisabledBundledInstall(
  config: OpenClawConfig,
  pluginId: string,
): OpenClawConfig {
  const entries = config.plugins?.entries ?? {};
  const { [pluginId]: _removedEntry, ...nextEntries } = entries;
  return {
    ...config,
    plugins: {
      ...config.plugins,
      entries: nextEntries,
    },
  };
}

async function installBundledPluginSource(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  rawSpec: string;
  bundledSource: BundledPluginSource;
  warning: string;
  runtime?: RuntimeEnv;
}) {
  const existingEntry = params.snapshot.config.plugins?.entries?.[params.bundledSource.pluginId];
  const shouldEnable = hasValidBundledPluginConfig({
    bundledSource: params.bundledSource,
    existingEntry,
  });
  const configBase = shouldEnable
    ? params.snapshot.config
    : prepareConfigForDisabledBundledInstall(params.snapshot.config, params.bundledSource.pluginId);
  const configWarning = shouldEnable
    ? ""
    : `Installed bundled plugin "${params.bundledSource.pluginId}" without enabling it because it requires configuration first. Configure it, then run \`openclaw plugins enable ${params.bundledSource.pluginId}\`.`;
  await persistPluginInstall({
    snapshot: {
      config: configBase,
      baseHash: params.snapshot.baseHash,
    },
    pluginId: params.bundledSource.pluginId,
    install: {
      source: "path",
      spec: params.rawSpec,
      sourcePath: params.bundledSource.localPath,
      installPath: params.bundledSource.localPath,
    },
    enable: shouldEnable,
    warningMessage: [params.warning, configWarning].filter(Boolean).join("\n"),
    runtime: params.runtime,
  });
}

async function tryInstallHookPackFromLocalPath(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  resolvedPath: string;
  installMode: "install" | "update";
  safetyOverrides?: InstallSafetyOverrides;
  link?: boolean;
  runtime?: RuntimeEnv;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (params.link) {
    const stat = fs.statSync(params.resolvedPath);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        error: "Linked hook pack paths must be directories.",
      };
    }

    const probe = await installHooksFromPath({
      ...resolveInstallSafetyOverrides(params.safetyOverrides ?? {}),
      path: params.resolvedPath,
      dryRun: true,
    });
    if (!probe.ok) {
      return probe;
    }

    const existing = params.snapshot.config.hooks?.internal?.load?.extraDirs ?? [];
    const merged = Array.from(new Set([...existing, params.resolvedPath]));
    await persistHookPackInstall({
      snapshot: {
        config: {
          ...params.snapshot.config,
          hooks: {
            ...params.snapshot.config.hooks,
            internal: {
              ...params.snapshot.config.hooks?.internal,
              enabled: true,
              load: {
                ...params.snapshot.config.hooks?.internal?.load,
                extraDirs: merged,
              },
            },
          },
        },
        baseHash: params.snapshot.baseHash,
      },
      hookPackId: probe.hookPackId,
      hooks: probe.hooks,
      install: {
        source: "path",
        sourcePath: params.resolvedPath,
        installPath: params.resolvedPath,
        version: probe.version,
      },
      successMessage: `Linked hook pack path: ${shortenHomePath(params.resolvedPath)}`,
      runtime: params.runtime,
    });
    return { ok: true };
  }

  const result = await installHooksFromPath({
    ...resolveInstallSafetyOverrides(params.safetyOverrides ?? {}),
    path: params.resolvedPath,
    mode: params.installMode,
    logger: createHookPackInstallLogger(params.runtime),
  });
  if (!result.ok) {
    return result;
  }

  const source: "archive" | "path" = resolveArchiveKind(params.resolvedPath) ? "archive" : "path";
  await persistHookPackInstall({
    snapshot: params.snapshot,
    hookPackId: result.hookPackId,
    hooks: result.hooks,
    install: {
      source,
      sourcePath: params.resolvedPath,
      installPath: result.targetDir,
      version: result.version,
    },
    runtime: params.runtime,
  });
  return { ok: true };
}

async function tryInstallHookPackFromNpmSpec(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  installMode: "install" | "update";
  spec: string;
  pin?: boolean;
  expectedIntegrity?: string;
  runtime?: RuntimeEnv;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await installHooksFromNpmSpec({
    spec: params.spec,
    mode: params.installMode,
    ...(params.expectedIntegrity ? { expectedIntegrity: params.expectedIntegrity } : {}),
    logger: createHookPackInstallLogger(params.runtime),
  });
  if (!result.ok) {
    return result;
  }

  const installRecord = resolvePinnedNpmInstallRecordForCli(
    params.spec,
    Boolean(params.pin),
    result.targetDir,
    result.version,
    result.npmResolution,
    params.runtime?.log ?? defaultRuntime.log,
    theme.warn,
  );
  await persistHookPackInstall({
    snapshot: params.snapshot,
    hookPackId: result.hookPackId,
    hooks: result.hooks,
    install: installRecord,
    runtime: params.runtime,
  });
  return { ok: true };
}

async function tryInstallPluginOrHookPackFromNpmSpec(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  installMode: "install" | "update";
  spec: string;
  pin?: boolean;
  safetyOverrides: InstallSafetyOverrides;
  allowBundledFallback: boolean;
  extensionsDir: string;
  expectedPluginId?: string;
  expectedIntegrity?: string;
  trustedSourceLinkedOfficialInstall?: boolean;
  runtime?: RuntimeEnv;
}): Promise<{ ok: true } | { ok: false }> {
  const result = await installPluginFromNpmSpec({
    ...params.safetyOverrides,
    mode: params.installMode,
    spec: params.spec,
    ...(params.expectedPluginId ? { expectedPluginId: params.expectedPluginId } : {}),
    ...(params.expectedIntegrity ? { expectedIntegrity: params.expectedIntegrity } : {}),
    ...(params.trustedSourceLinkedOfficialInstall
      ? { trustedSourceLinkedOfficialInstall: true }
      : {}),
    extensionsDir: params.extensionsDir,
    logger: createPluginInstallLogger(params.runtime),
  });
  if (!result.ok) {
    if (isTerminalPluginInstallSecurityFailure(result.code)) {
      (params.runtime ?? defaultRuntime).error(result.error);
      return { ok: false };
    }
    if (params.allowBundledFallback) {
      const bundledFallbackPlan = resolveBundledInstallPlanForNpmFailure({
        rawSpec: params.spec,
        code: result.code,
        findBundledSource: (lookup) => findBundledPluginSource({ lookup }),
      });
      if (bundledFallbackPlan) {
        await installBundledPluginSource({
          snapshot: params.snapshot,
          rawSpec: params.spec,
          bundledSource: bundledFallbackPlan.bundledSource,
          warning: bundledFallbackPlan.warning,
          runtime: params.runtime,
        });
        return { ok: true };
      }
    }
    const hookFallback = await tryInstallHookPackFromNpmSpec({
      snapshot: params.snapshot,
      installMode: params.installMode,
      spec: params.spec,
      pin: params.pin,
      expectedIntegrity: params.expectedIntegrity,
      runtime: params.runtime,
    });
    if (hookFallback.ok) {
      return { ok: true };
    }
    (params.runtime ?? defaultRuntime).error(
      formatPluginInstallWithHookFallbackError(result.error, hookFallback.error),
    );
    return { ok: false };
  }

  const installRecord = resolvePinnedNpmInstallRecordForCli(
    params.spec,
    Boolean(params.pin),
    result.targetDir,
    result.version,
    result.npmResolution,
    params.runtime?.log ?? defaultRuntime.log,
    theme.warn,
  );
  await persistPluginInstall({
    snapshot: params.snapshot,
    pluginId: result.pluginId,
    install: installRecord,
    runtime: params.runtime,
  });
  return { ok: true };
}

async function tryInstallPluginFromNpmPackArchive(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  installMode: "install" | "update";
  archivePath: string;
  safetyOverrides: InstallSafetyOverrides;
  extensionsDir: string;
  runtime?: RuntimeEnv;
}): Promise<{ ok: true } | { ok: false }> {
  const result = await installPluginFromNpmPackArchive({
    ...params.safetyOverrides,
    mode: params.installMode,
    archivePath: params.archivePath,
    extensionsDir: params.extensionsDir,
    logger: createPluginInstallLogger(params.runtime),
  });
  if (!result.ok) {
    (params.runtime ?? defaultRuntime).error(result.error);
    return { ok: false };
  }

  await persistPluginInstall({
    snapshot: params.snapshot,
    pluginId: result.pluginId,
    install: {
      source: "npm",
      spec: result.npmResolution?.resolvedSpec ?? result.manifestName ?? result.pluginId,
      sourcePath: params.archivePath,
      installPath: result.targetDir,
      ...(result.version ? { version: result.version } : {}),
      ...(result.npmResolution?.name ? { resolvedName: result.npmResolution.name } : {}),
      ...(result.npmResolution?.version ? { resolvedVersion: result.npmResolution.version } : {}),
      ...(result.npmResolution?.resolvedSpec
        ? { resolvedSpec: result.npmResolution.resolvedSpec }
        : {}),
      ...(result.npmResolution?.integrity ? { integrity: result.npmResolution.integrity } : {}),
      ...(result.npmResolution?.shasum ? { shasum: result.npmResolution.shasum } : {}),
      ...(result.npmResolution?.resolvedAt ? { resolvedAt: result.npmResolution.resolvedAt } : {}),
      artifactKind: "npm-pack",
      artifactFormat: "tgz",
      ...(result.npmResolution?.integrity ? { npmIntegrity: result.npmResolution.integrity } : {}),
      ...(result.npmResolution?.shasum ? { npmShasum: result.npmResolution.shasum } : {}),
      ...(result.npmTarballName ? { npmTarballName: result.npmTarballName } : {}),
    },
    runtime: params.runtime,
  });
  return { ok: true };
}

async function tryInstallPluginFromGitSpec(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  installMode: "install" | "update";
  spec: string;
  safetyOverrides: InstallSafetyOverrides;
  extensionsDir: string;
  runtime?: RuntimeEnv;
}): Promise<{ ok: true } | { ok: false }> {
  const result = await installPluginFromGitSpec({
    ...params.safetyOverrides,
    mode: params.installMode,
    spec: params.spec,
    extensionsDir: params.extensionsDir,
    logger: createPluginInstallLogger(params.runtime),
  });
  if (!result.ok) {
    (params.runtime ?? defaultRuntime).error(result.error);
    return { ok: false };
  }

  await persistPluginInstall({
    snapshot: params.snapshot,
    pluginId: result.pluginId,
    install: {
      source: "git",
      spec: params.spec,
      installPath: result.targetDir,
      version: result.version,
      resolvedAt: result.git.resolvedAt,
      gitUrl: result.git.url,
      gitRef: result.git.ref,
      gitCommit: result.git.commit,
    },
    runtime: params.runtime,
  });
  return { ok: true };
}

function isTerminalPluginInstallSecurityFailure(code?: string): boolean {
  return (
    code === PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED ||
    code === PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_FAILED
  );
}

function isAllowedPluginRecoveryIssue(
  issue: { path?: string; message?: string },
  request: PluginInstallRequestContext,
): boolean {
  const pluginId = request.bundledPluginId?.trim();
  if (!pluginId) {
    return false;
  }
  return (
    (issue.path === `channels.${pluginId}` &&
      issue.message === `unknown channel id: ${pluginId}`) ||
    (issue.path === "plugins.load.paths" &&
      typeof issue.message === "string" &&
      issue.message.includes("plugin path not found")) ||
    (issue.path === "plugins" &&
      typeof issue.message === "string" &&
      issue.message.includes("requires compiled runtime output")) ||
    (issue.path === `plugins.entries.${pluginId}` &&
      typeof issue.message === "string" &&
      issue.message.includes("requires compiled runtime output")) ||
    (issue.path === "tools.web.search.provider" &&
      typeof issue.message === "string" &&
      issue.message.includes(`plugin "${pluginId}"`))
  );
}

function buildInvalidPluginInstallConfigError(message: string): Error {
  const error = new Error(message);
  (error as { code?: string }).code = "INVALID_CONFIG";
  return error;
}

async function loadConfigFromSnapshotForInstall(
  request: PluginInstallRequestContext,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): Promise<ConfigSnapshotForInstallPersist> {
  if (resolvePluginInstallInvalidConfigPolicy(request) !== "allow-plugin-recovery") {
    throw buildInvalidPluginInstallConfigError(
      "Config invalid; run `openclaw doctor --fix` before installing plugins.",
    );
  }
  const parsed = (snapshot.parsed ?? {}) as Record<string, unknown>;
  if (!snapshot.exists || Object.keys(parsed).length === 0) {
    throw buildInvalidPluginInstallConfigError(
      "Config file could not be parsed; run `openclaw doctor` to repair it.",
    );
  }
  if (
    snapshot.legacyIssues.length > 0 ||
    snapshot.issues.length === 0 ||
    snapshot.issues.some((issue) => !isAllowedPluginRecoveryIssue(issue, request))
  ) {
    const pluginLabel = request.bundledPluginId ?? "the requested plugin";
    throw buildInvalidPluginInstallConfigError(
      `Config invalid outside the plugin recovery path for ${pluginLabel}; run \`openclaw doctor --fix\` before reinstalling it.`,
    );
  }
  let nextConfig = snapshot.config;
  for (const mutation of await collectChannelDoctorStaleConfigMutations(snapshot.config, {
    env: process.env,
  })) {
    nextConfig = mutation.config;
  }
  return {
    config: nextConfig,
    baseHash: snapshot.hash,
  };
}

export async function loadConfigForInstall(
  request: PluginInstallRequestContext,
): Promise<ConfigSnapshotForInstallPersist> {
  const snapshot = await tracePluginLifecyclePhaseAsync(
    "config read",
    () => readConfigFileSnapshot(),
    { command: "install" },
  );
  if (snapshot.valid) {
    return {
      config: snapshot.sourceConfig,
      baseHash: snapshot.hash,
    };
  }
  return loadConfigFromSnapshotForInstall(request, snapshot);
}

export async function runPluginInstallCommand(params: {
  raw: string;
  opts: InstallSafetyOverrides & {
    force?: boolean;
    link?: boolean;
    pin?: boolean;
    marketplace?: string;
  };
  runtime?: RuntimeEnv;
}) {
  assertConfigWriteAllowedInCurrentMode();

  const runtime = params.runtime ?? defaultRuntime;
  const shorthand = !params.opts.marketplace
    ? await tracePluginLifecyclePhaseAsync(
        "marketplace shortcut resolution",
        () => resolveMarketplaceInstallShortcut(params.raw),
        { command: "install" },
      )
    : null;
  if (shorthand?.ok === false) {
    runtime.error(shorthand.error);
    return runtime.exit(1);
  }

  const raw = shorthand?.ok ? shorthand.plugin : params.raw;
  const opts = {
    ...params.opts,
    marketplace:
      params.opts.marketplace ?? (shorthand?.ok ? shorthand.marketplaceSource : undefined),
  };
  if (opts.marketplace) {
    if (opts.link) {
      runtime.error(
        `--link is not supported with --marketplace. Remove --link, or install a local path with ${formatCliCommand("openclaw plugins install --link <path>")}.`,
      );
      return runtime.exit(1);
    }
    if (opts.pin) {
      runtime.error(
        `--pin is not supported with --marketplace. Use ${formatCliCommand("openclaw plugins install <plugin> --marketplace <name>")} without --pin.`,
      );
      return runtime.exit(1);
    }
  }
  const gitPrefix = raw.trim().toLowerCase().startsWith("git:");
  const gitSpec = parseGitPluginSpec(raw);
  if (gitPrefix && !gitSpec) {
    runtime.error(
      `Unsupported git plugin spec: ${raw}. Use ${formatCliCommand("openclaw plugins install git:<repo>@<ref>")}.`,
    );
    return runtime.exit(1);
  }
  if (gitSpec && opts.link) {
    runtime.error(
      `--link is not supported with git: installs. Use ${formatCliCommand("openclaw plugins install git:<repo>@<ref>")} for Git installs or ${formatCliCommand("openclaw plugins install --link <path>")} for local paths.`,
    );
    return runtime.exit(1);
  }
  if (gitSpec && opts.pin) {
    runtime.error(
      `--pin is not supported with git: installs. Pin the ref in the spec instead, for example ${formatCliCommand("openclaw plugins install git:<repo>@<ref>")}.`,
    );
    return runtime.exit(1);
  }
  if (opts.link && opts.force) {
    runtime.error(
      `--force is not supported with --link. Linked plugins point at the source path directly; remove --force and re-run ${formatCliCommand("openclaw plugins install --link <path>")}.`,
    );
    return runtime.exit(1);
  }
  const requestResolution = resolvePluginInstallRequestContext({
    rawSpec: raw,
    marketplace: opts.marketplace,
  });
  if (!requestResolution.ok) {
    runtime.error(requestResolution.error);
    return runtime.exit(1);
  }
  const request = requestResolution.request;
  const snapshot = await loadConfigForInstall(request).catch((error: unknown) => {
    runtime.error(formatErrorMessage(error));
    return null;
  });
  if (!snapshot) {
    return runtime.exit(1);
  }
  const cfg = snapshot.config;
  const installMode = resolveInstallMode(opts.force);
  const safetyOverrides = resolveInstallSafetyOverrides(opts);
  const extensionsDir = resolveDefaultPluginExtensionsDir();

  if (opts.marketplace) {
    const result = await installPluginFromMarketplace({
      ...safetyOverrides,
      marketplace: opts.marketplace,
      mode: installMode,
      plugin: raw,
      extensionsDir,
      logger: createPluginInstallLogger(runtime),
    });
    if (!result.ok) {
      runtime.error(result.error);
      return runtime.exit(1);
    }

    await persistPluginInstall({
      snapshot,
      pluginId: result.pluginId,
      install: {
        source: "marketplace",
        installPath: result.targetDir,
        version: result.version,
        marketplaceName: result.marketplaceName,
        marketplaceSource: result.marketplaceSource,
        marketplacePlugin: result.marketplacePlugin,
      },
      runtime,
    });
    return;
  }

  const resolved = request.resolvedPath ?? request.normalizedSpec;
  if (fs.existsSync(resolved)) {
    if (opts.link) {
      const existing = cfg.plugins?.load?.paths ?? [];
      const merged = Array.from(new Set([...existing, resolved]));
      const probe = await installPluginFromPath({
        ...safetyOverrides,
        mode: installMode,
        path: resolved,
        dryRun: true,
        extensionsDir,
        logger: createPluginInstallLogger(runtime),
      });
      if (!probe.ok) {
        if (isTerminalPluginInstallSecurityFailure(probe.code)) {
          runtime.error(probe.error);
          return runtime.exit(1);
        }
        const hookFallback = await tryInstallHookPackFromLocalPath({
          snapshot,
          installMode,
          resolvedPath: resolved,
          safetyOverrides,
          link: true,
          runtime,
        });
        if (hookFallback.ok) {
          return;
        }
        runtime.error(formatPluginInstallWithHookFallbackError(probe.error, hookFallback.error));
        return runtime.exit(1);
      }

      await persistPluginInstall({
        snapshot: {
          config: {
            ...cfg,
            plugins: {
              ...cfg.plugins,
              load: {
                ...cfg.plugins?.load,
                paths: merged,
              },
            },
          },
          baseHash: snapshot.baseHash,
        },
        pluginId: probe.pluginId,
        install: {
          source: "path",
          sourcePath: resolved,
          installPath: resolved,
          version: probe.version,
        },
        successMessage: `Linked plugin path: ${shortenHomePath(resolved)}`,
        runtime,
      });
      return;
    }

    const result = await installPluginFromPath({
      ...safetyOverrides,
      mode: installMode,
      path: resolved,
      extensionsDir,
      logger: createPluginInstallLogger(runtime),
    });
    if (!result.ok) {
      if (isTerminalPluginInstallSecurityFailure(result.code)) {
        runtime.error(result.error);
        return runtime.exit(1);
      }
      const hookFallback = await tryInstallHookPackFromLocalPath({
        snapshot,
        installMode,
        resolvedPath: resolved,
        safetyOverrides,
        runtime,
      });
      if (hookFallback.ok) {
        return;
      }
      runtime.error(formatPluginInstallWithHookFallbackError(result.error, hookFallback.error));
      return runtime.exit(1);
    }

    const source: "archive" | "path" = resolveArchiveKind(resolved) ? "archive" : "path";
    await persistPluginInstall({
      snapshot,
      pluginId: result.pluginId,
      install: {
        source,
        sourcePath: resolved,
        installPath: result.targetDir,
        version: result.version,
      },
      runtime,
    });
    return;
  }

  if (opts.link) {
    runtime.error(
      `--link requires a local path. Run ${formatCliCommand("openclaw plugins install --link <path>")}.`,
    );
    return runtime.exit(1);
  }

  const npmPrefixSpec = parseNpmPrefixSpec(raw);
  if (npmPrefixSpec !== null) {
    if (!npmPrefixSpec) {
      runtime.error(
        `Unsupported npm plugin spec: missing package. Use ${formatCliCommand("openclaw plugins install npm:<package>")}.`,
      );
      return runtime.exit(1);
    }
    const officialNpmTrust = resolveOfficialExternalNpmPackageTrust({
      npmSpec: npmPrefixSpec,
      findOfficialExternalPackage: findTrustedCatalogPackageInstall,
    });
    const npmPrefixResult = await tryInstallPluginOrHookPackFromNpmSpec({
      snapshot,
      installMode,
      spec: npmPrefixSpec,
      pin: opts.pin,
      safetyOverrides,
      allowBundledFallback: false,
      extensionsDir,
      ...(officialNpmTrust
        ? {
            expectedPluginId: officialNpmTrust.pluginId,
            ...(officialNpmTrust.expectedIntegrity
              ? { expectedIntegrity: officialNpmTrust.expectedIntegrity }
              : {}),
            trustedSourceLinkedOfficialInstall: true,
          }
        : {}),
      runtime,
    });
    if (!npmPrefixResult.ok) {
      return runtime.exit(1);
    }
    return;
  }

  const npmPackPath = parseNpmPackPrefixPath(raw);
  if (npmPackPath !== null) {
    if (!npmPackPath) {
      runtime.error(
        `Unsupported npm-pack plugin spec: missing archive path. Use ${formatCliCommand("openclaw plugins install npm-pack:<path-to.tgz>")}.`,
      );
      return runtime.exit(1);
    }
    const npmPackResult = await tryInstallPluginFromNpmPackArchive({
      snapshot,
      installMode,
      archivePath: npmPackPath,
      safetyOverrides,
      extensionsDir,
      runtime,
    });
    if (!npmPackResult.ok) {
      return runtime.exit(1);
    }
    return;
  }

  if (gitSpec) {
    const gitResult = await tryInstallPluginFromGitSpec({
      snapshot,
      installMode,
      spec: raw,
      safetyOverrides,
      extensionsDir,
      runtime,
    });
    if (!gitResult.ok) {
      return runtime.exit(1);
    }
    return;
  }

  if (
    looksLikeLocalInstallSpec(raw, [
      ".ts",
      ".js",
      ".mjs",
      ".cjs",
      ".tgz",
      ".tar.gz",
      ".tar",
      ".zip",
    ])
  ) {
    runtime.error(
      `Plugin path not found: ${resolved}. Check the path, or install from npm with ${formatCliCommand("openclaw plugins install npm:<package>")}.`,
    );
    return runtime.exit(1);
  }

  const bundledPreNpmPlan = resolveBundledInstallPlanBeforeNpm({
    rawSpec: raw,
    findBundledSource: (lookup) => findBundledPluginSource({ lookup }),
  });
  if (bundledPreNpmPlan) {
    await tracePluginLifecyclePhaseAsync(
      "install execution",
      () =>
        installBundledPluginSource({
          snapshot,
          rawSpec: raw,
          bundledSource: bundledPreNpmPlan.bundledSource,
          warning: bundledPreNpmPlan.warning,
          runtime,
        }),
      {
        command: "install",
        source: "bundled",
        pluginId: bundledPreNpmPlan.bundledSource.pluginId,
      },
    );
    return;
  }

  const officialExternalPlan = resolveOfficialExternalInstallPlanBeforeNpm({
    rawSpec: raw,
    findOfficialExternalPlugin: (pluginId) => {
      const entry = getOfficialExternalPluginCatalogEntry(pluginId);
      const resolvedPluginId = entry ? resolveOfficialExternalPluginId(entry) : undefined;
      const install = entry ? resolveOfficialExternalPluginInstall(entry) : null;
      const npmSpec = install?.npmSpec;
      return resolvedPluginId && npmSpec
        ? {
            pluginId: resolvedPluginId,
            npmSpec,
            ...(install.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}),
          }
        : undefined;
    },
  });
  if (officialExternalPlan) {
    const npmResult = await tryInstallPluginOrHookPackFromNpmSpec({
      snapshot,
      installMode,
      spec: officialExternalPlan.npmSpec,
      pin: opts.pin,
      safetyOverrides,
      allowBundledFallback: false,
      extensionsDir,
      expectedPluginId: officialExternalPlan.pluginId,
      expectedIntegrity: officialExternalPlan.expectedIntegrity,
      trustedSourceLinkedOfficialInstall: true,
      runtime,
    });
    if (!npmResult.ok) {
      return runtime.exit(1);
    }
    return;
  }

  const clawhubSpec = parseClawHubPluginSpec(raw);
  if (clawhubSpec) {
    const result = await installPluginFromClawHub({
      ...safetyOverrides,
      mode: installMode,
      spec: raw,
      extensionsDir,
      logger: createPluginInstallLogger(runtime),
    });
    if (!result.ok) {
      runtime.error(result.error);
      return runtime.exit(1);
    }

    await persistPluginInstall({
      snapshot,
      pluginId: result.pluginId,
      install: {
        ...buildClawHubPluginInstallRecordFields(result.clawhub),
        spec: raw,
        installPath: result.targetDir,
      },
      runtime,
    });
    return;
  }

  const officialNpmTrust = resolveOfficialExternalNpmPackageTrust({
    npmSpec: raw,
    findOfficialExternalPackage: findTrustedCatalogPackageInstall,
  });
  const npmResult = await tryInstallPluginOrHookPackFromNpmSpec({
    snapshot,
    installMode,
    spec: raw,
    pin: opts.pin,
    safetyOverrides,
    allowBundledFallback: true,
    extensionsDir,
    ...(officialNpmTrust
      ? {
          expectedPluginId: officialNpmTrust.pluginId,
          ...(officialNpmTrust.expectedIntegrity
            ? { expectedIntegrity: officialNpmTrust.expectedIntegrity }
            : {}),
          trustedSourceLinkedOfficialInstall: true,
        }
      : {}),
    runtime,
  });
  if (!npmResult.ok) {
    return runtime.exit(1);
  }
}
