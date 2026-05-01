import fs from "node:fs";
import { collectChannelDoctorStaleConfigMutations } from "../commands/doctor/shared/channel-doctor.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { installHooksFromNpmSpec, installHooksFromPath } from "../hooks/install.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { parseClawHubPluginSpec } from "../infra/clawhub.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type BundledPluginSource, findBundledPluginSource } from "../plugins/bundled-sources.js";
import { installPluginFromClawHub } from "../plugins/clawhub.js";
import { installPluginFromGitSpec, parseGitPluginSpec } from "../plugins/git-install.js";
import { resolveDefaultPluginExtensionsDir } from "../plugins/install-paths.js";
import type { InstallSafetyOverrides } from "../plugins/install-security-scan.js";
import {
  PLUGIN_INSTALL_ERROR_CODE,
  installPluginFromNpmSpec,
  installPluginFromPath,
} from "../plugins/install.js";
import {
  installPluginFromMarketplace,
  resolveMarketplaceInstallShortcut,
} from "../plugins/marketplace.js";
import { tracePluginLifecyclePhaseAsync } from "../plugins/plugin-lifecycle-trace.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
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
} from "./plugin-install-plan.js";
import {
  buildPreferredClawHubSpec,
  createHookPackInstallLogger,
  createPluginInstallLogger,
  decidePreferredClawHubFallback,
  formatPluginInstallWithHookFallbackError,
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
  });
}

async function tryInstallHookPackFromLocalPath(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  resolvedPath: string;
  installMode: "install" | "update";
  safetyOverrides?: InstallSafetyOverrides;
  link?: boolean;
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
    });
    return { ok: true };
  }

  const result = await installHooksFromPath({
    ...resolveInstallSafetyOverrides(params.safetyOverrides ?? {}),
    path: params.resolvedPath,
    mode: params.installMode,
    logger: createHookPackInstallLogger(),
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
  });
  return { ok: true };
}

async function tryInstallHookPackFromNpmSpec(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  installMode: "install" | "update";
  spec: string;
  pin?: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await installHooksFromNpmSpec({
    spec: params.spec,
    mode: params.installMode,
    logger: createHookPackInstallLogger(),
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
    defaultRuntime.log,
    theme.warn,
  );
  await persistHookPackInstall({
    snapshot: params.snapshot,
    hookPackId: result.hookPackId,
    hooks: result.hooks,
    install: installRecord,
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
}): Promise<{ ok: true } | { ok: false }> {
  const result = await installPluginFromNpmSpec({
    ...params.safetyOverrides,
    mode: params.installMode,
    spec: params.spec,
    extensionsDir: params.extensionsDir,
    logger: createPluginInstallLogger(),
  });
  if (!result.ok) {
    if (isTerminalPluginInstallSecurityFailure(result.code)) {
      defaultRuntime.error(result.error);
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
        });
        return { ok: true };
      }
    }
    const hookFallback = await tryInstallHookPackFromNpmSpec({
      snapshot: params.snapshot,
      installMode: params.installMode,
      spec: params.spec,
      pin: params.pin,
    });
    if (hookFallback.ok) {
      return { ok: true };
    }
    defaultRuntime.error(
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
    defaultRuntime.log,
    theme.warn,
  );
  await persistPluginInstall({
    snapshot: params.snapshot,
    pluginId: result.pluginId,
    install: installRecord,
  });
  return { ok: true };
}

async function tryInstallPluginFromGitSpec(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  installMode: "install" | "update";
  spec: string;
  safetyOverrides: InstallSafetyOverrides;
  extensionsDir: string;
}): Promise<{ ok: true } | { ok: false }> {
  const result = await installPluginFromGitSpec({
    ...params.safetyOverrides,
    mode: params.installMode,
    spec: params.spec,
    extensionsDir: params.extensionsDir,
    logger: createPluginInstallLogger(),
  });
  if (!result.ok) {
    defaultRuntime.error(result.error);
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
  });
  return { ok: true };
}

function isTerminalPluginInstallSecurityFailure(code?: string): boolean {
  return (
    code === PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED ||
    code === PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_FAILED
  );
}

function isAllowedBundledRecoveryIssue(
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
      issue.message.includes("plugin path not found"))
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
  if (resolvePluginInstallInvalidConfigPolicy(request) !== "allow-bundled-recovery") {
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
    snapshot.issues.some((issue) => !isAllowedBundledRecoveryIssue(issue, request))
  ) {
    const pluginLabel = request.bundledPluginId ?? "the requested plugin";
    throw buildInvalidPluginInstallConfigError(
      `Config invalid outside the bundled recovery path for ${pluginLabel}; run \`openclaw doctor --fix\` before reinstalling it.`,
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
}) {
  const shorthand = !params.opts.marketplace
    ? await tracePluginLifecyclePhaseAsync(
        "marketplace shortcut resolution",
        () => resolveMarketplaceInstallShortcut(params.raw),
        { command: "install" },
      )
    : null;
  if (shorthand?.ok === false) {
    defaultRuntime.error(shorthand.error);
    return defaultRuntime.exit(1);
  }

  const raw = shorthand?.ok ? shorthand.plugin : params.raw;
  const opts = {
    ...params.opts,
    marketplace:
      params.opts.marketplace ?? (shorthand?.ok ? shorthand.marketplaceSource : undefined),
  };
  if (opts.marketplace) {
    if (opts.link) {
      defaultRuntime.error("`--link` is not supported with `--marketplace`.");
      return defaultRuntime.exit(1);
    }
    if (opts.pin) {
      defaultRuntime.error("`--pin` is not supported with `--marketplace`.");
      return defaultRuntime.exit(1);
    }
  }
  const gitPrefix = raw.trim().toLowerCase().startsWith("git:");
  const gitSpec = parseGitPluginSpec(raw);
  if (gitPrefix && !gitSpec) {
    defaultRuntime.error(`unsupported git: plugin spec: ${raw}`);
    return defaultRuntime.exit(1);
  }
  if (gitSpec && opts.link) {
    defaultRuntime.error("`--link` is not supported with `git:` installs.");
    return defaultRuntime.exit(1);
  }
  if (gitSpec && opts.pin) {
    defaultRuntime.error("`--pin` is not supported with `git:` installs; use `git:<repo>@<ref>`.");
    return defaultRuntime.exit(1);
  }
  if (opts.link && opts.force) {
    defaultRuntime.error("`--force` is not supported with `--link`.");
    return defaultRuntime.exit(1);
  }
  const requestResolution = resolvePluginInstallRequestContext({
    rawSpec: raw,
    marketplace: opts.marketplace,
  });
  if (!requestResolution.ok) {
    defaultRuntime.error(requestResolution.error);
    return defaultRuntime.exit(1);
  }
  const request = requestResolution.request;
  const snapshot = await loadConfigForInstall(request).catch((error: unknown) => {
    defaultRuntime.error(formatErrorMessage(error));
    return null;
  });
  if (!snapshot) {
    return defaultRuntime.exit(1);
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
      logger: createPluginInstallLogger(),
    });
    if (!result.ok) {
      defaultRuntime.error(result.error);
      return defaultRuntime.exit(1);
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
        logger: createPluginInstallLogger(),
      });
      if (!probe.ok) {
        if (isTerminalPluginInstallSecurityFailure(probe.code)) {
          defaultRuntime.error(probe.error);
          return defaultRuntime.exit(1);
        }
        const hookFallback = await tryInstallHookPackFromLocalPath({
          snapshot,
          installMode,
          resolvedPath: resolved,
          safetyOverrides,
          link: true,
        });
        if (hookFallback.ok) {
          return;
        }
        defaultRuntime.error(
          formatPluginInstallWithHookFallbackError(probe.error, hookFallback.error),
        );
        return defaultRuntime.exit(1);
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
      });
      return;
    }

    const result = await installPluginFromPath({
      ...safetyOverrides,
      mode: installMode,
      path: resolved,
      extensionsDir,
      logger: createPluginInstallLogger(),
    });
    if (!result.ok) {
      if (isTerminalPluginInstallSecurityFailure(result.code)) {
        defaultRuntime.error(result.error);
        return defaultRuntime.exit(1);
      }
      const hookFallback = await tryInstallHookPackFromLocalPath({
        snapshot,
        installMode,
        resolvedPath: resolved,
        safetyOverrides,
      });
      if (hookFallback.ok) {
        return;
      }
      defaultRuntime.error(
        formatPluginInstallWithHookFallbackError(result.error, hookFallback.error),
      );
      return defaultRuntime.exit(1);
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
    });
    return;
  }

  if (opts.link) {
    defaultRuntime.error("`--link` requires a local path.");
    return defaultRuntime.exit(1);
  }

  const npmPrefixSpec = parseNpmPrefixSpec(raw);
  if (npmPrefixSpec !== null) {
    if (!npmPrefixSpec) {
      defaultRuntime.error("unsupported npm: spec: missing package");
      return defaultRuntime.exit(1);
    }
    const npmPrefixResult = await tryInstallPluginOrHookPackFromNpmSpec({
      snapshot,
      installMode,
      spec: npmPrefixSpec,
      pin: opts.pin,
      safetyOverrides,
      allowBundledFallback: false,
      extensionsDir,
    });
    if (!npmPrefixResult.ok) {
      return defaultRuntime.exit(1);
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
    });
    if (!gitResult.ok) {
      return defaultRuntime.exit(1);
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
    defaultRuntime.error(`Path not found: ${resolved}`);
    return defaultRuntime.exit(1);
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
        }),
      {
        command: "install",
        source: "bundled",
        pluginId: bundledPreNpmPlan.bundledSource.pluginId,
      },
    );
    return;
  }

  const clawhubSpec = parseClawHubPluginSpec(raw);
  if (clawhubSpec) {
    const result = await installPluginFromClawHub({
      ...safetyOverrides,
      mode: installMode,
      spec: raw,
      extensionsDir,
      logger: createPluginInstallLogger(),
    });
    if (!result.ok) {
      defaultRuntime.error(result.error);
      return defaultRuntime.exit(1);
    }

    await persistPluginInstall({
      snapshot,
      pluginId: result.pluginId,
      install: {
        source: "clawhub",
        spec: raw,
        installPath: result.targetDir,
        version: result.version,
        integrity: result.clawhub.integrity,
        resolvedAt: result.clawhub.resolvedAt,
        clawhubUrl: result.clawhub.clawhubUrl,
        clawhubPackage: result.clawhub.clawhubPackage,
        clawhubFamily: result.clawhub.clawhubFamily,
        clawhubChannel: result.clawhub.clawhubChannel,
      },
    });
    return;
  }

  const preferredClawHubSpec = buildPreferredClawHubSpec(raw);
  if (preferredClawHubSpec) {
    const clawhubResult = await installPluginFromClawHub({
      ...safetyOverrides,
      mode: installMode,
      spec: preferredClawHubSpec,
      extensionsDir,
      logger: createPluginInstallLogger(),
    });
    if (clawhubResult.ok) {
      await persistPluginInstall({
        snapshot,
        pluginId: clawhubResult.pluginId,
        install: {
          source: "clawhub",
          spec: preferredClawHubSpec,
          installPath: clawhubResult.targetDir,
          version: clawhubResult.version,
          integrity: clawhubResult.clawhub.integrity,
          resolvedAt: clawhubResult.clawhub.resolvedAt,
          clawhubUrl: clawhubResult.clawhub.clawhubUrl,
          clawhubPackage: clawhubResult.clawhub.clawhubPackage,
          clawhubFamily: clawhubResult.clawhub.clawhubFamily,
          clawhubChannel: clawhubResult.clawhub.clawhubChannel,
        },
      });
      return;
    }
    if (decidePreferredClawHubFallback(clawhubResult) !== "fallback_to_npm") {
      defaultRuntime.error(clawhubResult.error);
      return defaultRuntime.exit(1);
    }
  }

  const npmResult = await tryInstallPluginOrHookPackFromNpmSpec({
    snapshot,
    installMode,
    spec: raw,
    pin: opts.pin,
    safetyOverrides,
    allowBundledFallback: true,
    extensionsDir,
  });
  if (!npmResult.ok) {
    return defaultRuntime.exit(1);
  }
}
