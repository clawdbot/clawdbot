import fs from "node:fs";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { buildNpmInstallRecordFields } from "../../cli/npm-resolution.js";
import { resolveBundledInstallPlanBeforeNpm } from "../../cli/plugin-install-plan.js";
import {
  createPluginInstallLogger,
  parseNpmPackPrefixPath,
  resolveFileNpmSpecToLocalPath,
} from "../../cli/plugins-command-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { resolveArchiveKind } from "../../infra/archive.js";
import { parseClawHubPluginSpec } from "../../infra/clawhub.js";
import { installBundledPluginSource } from "../../plugins/bundled-install.js";
import { findBundledPluginSource } from "../../plugins/bundled-sources.js";
import { buildClawHubPluginInstallRecordFields } from "../../plugins/clawhub-install-records.js";
import { CLAWHUB_INSTALL_ERROR_CODE, installPluginFromClawHub } from "../../plugins/clawhub.js";
import { installPluginFromGitSpec, parseGitPluginSpec } from "../../plugins/git-install.js";
import {
  persistPluginInstall,
  type ConfigSnapshotForInstallPersist,
} from "../../plugins/install-persistence.js";
import {
  formatNonClawHubInstallWarning,
  NON_CLAWHUB_INSTALL_FORCE_FLAG,
  resolveOpenClawTrustedNpmPackageInstall,
  type NonClawHubInstallSourceClass,
} from "../../plugins/install-provenance.js";
import {
  installPluginFromNpmPackArchive,
  installPluginFromNpmSpec,
  installPluginFromPath,
} from "../../plugins/install.js";
import { resolveCatalogOfficialExternalInstallPlan } from "../../plugins/official-external-install-trust.js";
import { resolveUserPath } from "../../utils.js";

function looksLikeLocalPluginInstallSpec(raw: string): boolean {
  return (
    raw.startsWith(".") ||
    raw.startsWith("~") ||
    raw.startsWith("/") ||
    raw.endsWith(".ts") ||
    raw.endsWith(".js") ||
    raw.endsWith(".mjs") ||
    raw.endsWith(".cjs") ||
    raw.endsWith(".tgz") ||
    raw.endsWith(".tar.gz") ||
    raw.endsWith(".tar") ||
    raw.endsWith(".zip")
  );
}

function resolveNonClawHubChatInstallAcknowledgement(params: {
  force: boolean;
  sourceClass: NonClawHubInstallSourceClass;
  spec: string;
}): { ok: true; warning: string } | { ok: false; error: string } {
  const warning = formatNonClawHubInstallWarning(params);
  if (params.force) {
    return { ok: true, warning };
  }
  return {
    ok: false,
    error: `${warning}\nReview the source, then rerun this chat command with ${NON_CLAWHUB_INSTALL_FORCE_FLAG} to continue.`,
  };
}

export async function installPluginFromPluginsCommand(params: {
  raw: string;
  force: boolean;
  config: OpenClawConfig;
  snapshot: ConfigSnapshotForInstallPersist;
}): Promise<
  { ok: true; pluginId: string; warnings?: readonly string[] } | { ok: false; error: string }
> {
  const fileSpec = resolveFileNpmSpecToLocalPath(params.raw);
  if (fileSpec && !fileSpec.ok) {
    return { ok: false, error: fileSpec.error };
  }
  const normalized = fileSpec && fileSpec.ok ? fileSpec.path : params.raw;
  const resolved = resolveUserPath(normalized);
  const installMode = params.force ? "update" : "install";

  if (fs.existsSync(resolved)) {
    const source: "archive" | "path" = resolveArchiveKind(resolved) ? "archive" : "path";
    const bundledLocalSource =
      source === "path"
        ? findBundledPluginSource({ lookup: { kind: "localPath", value: resolved } })
        : undefined;
    const acknowledgement = bundledLocalSource
      ? null
      : resolveNonClawHubChatInstallAcknowledgement({
          force: params.force,
          sourceClass: source === "archive" ? "local-archive" : "local-path",
          spec: params.raw,
        });
    if (acknowledgement && !acknowledgement.ok) {
      return acknowledgement;
    }
    const result = await installPluginFromPath({
      path: resolved,
      config: params.config,
      mode: installMode,
      logger: createPluginInstallLogger(),
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    await persistPluginInstall({
      snapshot: params.snapshot,
      pluginId: result.pluginId,
      install: {
        source,
        sourcePath: resolved,
        installPath: result.targetDir,
        version: result.version,
      },
    });
    return {
      ok: true,
      pluginId: result.pluginId,
      ...(acknowledgement?.ok ? { warnings: [acknowledgement.warning] } : {}),
    };
  }

  const npmPackPath = parseNpmPackPrefixPath(params.raw);
  if (npmPackPath !== null) {
    if (!npmPackPath) {
      return { ok: false, error: "Unsupported npm-pack plugin spec: missing archive path." };
    }
    const acknowledgement = resolveNonClawHubChatInstallAcknowledgement({
      force: params.force,
      sourceClass: "npm-pack",
      spec: params.raw,
    });
    if (!acknowledgement.ok) {
      return acknowledgement;
    }
    const result = await installPluginFromNpmPackArchive({
      archivePath: npmPackPath,
      config: params.config,
      mode: installMode,
      logger: createPluginInstallLogger(),
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    const installRecord = {
      ...buildNpmInstallRecordFields({
        spec: result.npmResolution?.resolvedSpec ?? result.manifestName ?? result.pluginId,
        installPath: result.targetDir,
        version: result.version,
        resolution: result.npmResolution,
      }),
      sourcePath: npmPackPath,
      artifactKind: "npm-pack",
      artifactFormat: "tgz",
      ...(result.npmResolution?.integrity ? { npmIntegrity: result.npmResolution.integrity } : {}),
      ...(result.npmResolution?.shasum ? { npmShasum: result.npmResolution.shasum } : {}),
      ...(result.npmTarballName ? { npmTarballName: result.npmTarballName } : {}),
    } satisfies PluginInstallRecord;
    await persistPluginInstall({
      snapshot: params.snapshot,
      pluginId: result.pluginId,
      install: installRecord,
    });
    return { ok: true, pluginId: result.pluginId, warnings: [acknowledgement.warning] };
  }

  if (looksLikeLocalPluginInstallSpec(params.raw)) {
    return { ok: false, error: `Path not found: ${resolved}` };
  }

  const gitPrefix = params.raw.trim().toLowerCase().startsWith("git:");
  const gitSpec = parseGitPluginSpec(params.raw);
  if (gitPrefix && !gitSpec) {
    return { ok: false, error: `unsupported git: plugin spec: ${params.raw}` };
  }
  if (gitSpec) {
    const acknowledgement = resolveNonClawHubChatInstallAcknowledgement({
      force: params.force,
      sourceClass: "git",
      spec: params.raw,
    });
    if (!acknowledgement.ok) {
      return acknowledgement;
    }
    const result = await installPluginFromGitSpec({
      spec: params.raw,
      config: params.config,
      mode: installMode,
      logger: createPluginInstallLogger(),
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    await persistPluginInstall({
      snapshot: params.snapshot,
      pluginId: result.pluginId,
      install: {
        source: "git",
        spec: params.raw,
        installPath: result.targetDir,
        version: result.version,
        resolvedAt: result.git.resolvedAt,
        gitUrl: result.git.url,
        gitRef: result.git.ref,
        gitCommit: result.git.commit,
      },
    });
    return { ok: true, pluginId: result.pluginId, warnings: [acknowledgement.warning] };
  }

  const clawhubSpec = parseClawHubPluginSpec(params.raw);
  if (clawhubSpec) {
    const warnings: string[] = [];
    const logger = createPluginInstallLogger();
    const result = await installPluginFromClawHub({
      spec: params.raw,
      config: params.config,
      mode: installMode,
      logger: {
        info: logger.info,
        warn: (message) => {
          warnings.push(stripAnsi(message));
          logger.warn(message);
        },
        terminalLinks: false,
      },
    });
    if (!result.ok) {
      const warning = "warning" in result ? result.warning : warnings.join("\n");
      const warningPrefix = warning ? `${warning} ` : "";
      if (result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED) {
        return {
          ok: false,
          error: `${warningPrefix}${result.error} The /plugins chat command cannot acknowledge ClawHub risk; run the local openclaw plugins install command with --acknowledge-clawhub-risk from a trusted shell after reviewing the warning.`,
        };
      }
      return { ok: false, error: `${warningPrefix}${result.error}` };
    }
    await persistPluginInstall({
      snapshot: params.snapshot,
      pluginId: result.pluginId,
      install: {
        ...buildClawHubPluginInstallRecordFields(result.clawhub),
        spec: params.raw,
        installPath: result.targetDir,
        version: result.version,
      },
    });
    return { ok: true, pluginId: result.pluginId, warnings };
  }

  const npmSpec = params.raw.trim().toLowerCase().startsWith("npm:")
    ? params.raw.trim().slice("npm:".length)
    : params.raw;
  const explicitNpm = params.raw.trim().toLowerCase().startsWith("npm:");
  const bundledPlan = explicitNpm
    ? null
    : resolveBundledInstallPlanBeforeNpm({
        rawSpec: params.raw,
        findBundledSource: (lookup) => findBundledPluginSource({ lookup }),
      });
  if (bundledPlan) {
    const bundledInstall = await installBundledPluginSource({
      snapshot: params.snapshot,
      rawSpec: params.raw,
      bundledSource: bundledPlan.bundledSource,
      warning: bundledPlan.warning,
    });
    return {
      ok: true,
      pluginId: bundledInstall.pluginId,
      warnings: bundledInstall.warnings,
    };
  }
  const trustedNpmInstall = resolveOpenClawTrustedNpmPackageInstall(npmSpec);
  const officialIdPlan = resolveCatalogOfficialExternalInstallPlan(params.raw);
  const arbitraryNpmAcknowledgement =
    !trustedNpmInstall && !officialIdPlan
      ? resolveNonClawHubChatInstallAcknowledgement({
          force: params.force,
          sourceClass: "npm",
          spec: params.raw,
        })
      : null;
  if (arbitraryNpmAcknowledgement && !arbitraryNpmAcknowledgement.ok) {
    return arbitraryNpmAcknowledgement;
  }
  const trustedPluginId = trustedNpmInstall?.pluginId ?? officialIdPlan?.pluginId;
  const trustedNpmSpec = officialIdPlan?.npmSpec ?? npmSpec;
  const expectedIntegrity =
    trustedNpmInstall?.expectedIntegrity ?? officialIdPlan?.expectedIntegrity;
  const result = await installPluginFromNpmSpec({
    spec: trustedNpmSpec,
    config: params.config,
    mode: installMode,
    ...(trustedPluginId ? { expectedPluginId: trustedPluginId } : {}),
    ...(expectedIntegrity ? { expectedIntegrity } : {}),
    ...(trustedNpmInstall || officialIdPlan ? { trustedSourceLinkedOfficialInstall: true } : {}),
    logger: createPluginInstallLogger(),
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  const installRecord = buildNpmInstallRecordFields({
    spec: trustedNpmSpec,
    installPath: result.targetDir,
    version: result.version,
    resolution: result.npmResolution,
  });
  await persistPluginInstall({
    snapshot: params.snapshot,
    pluginId: result.pluginId,
    install: installRecord,
  });
  return {
    ok: true,
    pluginId: result.pluginId,
    ...(arbitraryNpmAcknowledgement?.ok ? { warnings: [arbitraryNpmAcknowledgement.warning] } : {}),
  };
}
