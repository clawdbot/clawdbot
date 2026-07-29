// Plugin install planning helpers for bundled, official external, and npm fallback paths.
import fs from "node:fs";
import path from "node:path";
import { resolveArchiveKind } from "../infra/archive.js";
import { parseClawHubPluginSpec } from "../infra/clawhub.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { findBundledPluginSource, type BundledPluginSource } from "../plugins/bundled-sources.js";
import { parseGitPluginSpec } from "../plugins/git-install.js";
import {
  resolveOpenClawTrustedNpmPackageInstall,
  type NonClawHubInstallSourceClass,
} from "../plugins/install-provenance.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../plugins/install.js";
import type { ManagedPluginSourceInstallRequest } from "../plugins/management-service.js";
import { resolveCatalogOfficialExternalInstallPlan } from "../plugins/official-external-install-trust.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { looksLikeLocalInstallSpec } from "./install-spec.js";
import {
  parseNpmPackPrefixPath,
  parseNpmPrefixSpec,
  resolveFileNpmSpecToLocalPath,
} from "./plugins-command-helpers.js";

type BundledLookup = (params: {
  kind: "pluginId" | "npmSpec";
  value: string;
}) => BundledPluginSource | undefined;

type PluginInstallSourcePlan =
  | { ok: false; error: string }
  | {
      ok: true;
      request: ManagedPluginSourceInstallRequest;
      acknowledgement?: { sourceClass: NonClawHubInstallSourceClass; spec: string };
    };

function sourcePlan(
  request: ManagedPluginSourceInstallRequest,
  raw: string,
  sourceClass?: NonClawHubInstallSourceClass,
): PluginInstallSourcePlan {
  return {
    ok: true,
    request,
    ...(sourceClass ? { acknowledgement: { sourceClass, spec: raw } } : {}),
  };
}

export function resolvePluginInstallSourcePlan(params: {
  raw: string;
  mode: "install" | "update";
  link?: boolean;
  pin?: boolean;
}): PluginInstallSourcePlan {
  const fileSpec = resolveFileNpmSpecToLocalPath(params.raw);
  if (fileSpec && !fileSpec.ok) {
    return fileSpec;
  }
  const normalized = fileSpec?.ok ? fileSpec.path : params.raw;
  const resolved = resolveUserPath(normalized);
  if (fs.existsSync(resolved)) {
    const recordSource = resolveArchiveKind(resolved) ? "archive" : "path";
    const bundled =
      recordSource === "path"
        ? findBundledPluginSource({ lookup: { kind: "localPath", value: resolved } })
        : undefined;
    return sourcePlan(
      {
        source: "local",
        path: resolved,
        recordSource,
        mode: params.mode,
        ...(params.link ? { link: true } : {}),
      },
      params.raw,
      bundled ? undefined : recordSource === "archive" ? "local-archive" : "local-path",
    );
  }

  const npmPackPath = parseNpmPackPrefixPath(params.raw);
  if (npmPackPath !== null) {
    return npmPackPath
      ? sourcePlan(
          { source: "npm-pack", archivePath: npmPackPath, mode: params.mode },
          params.raw,
          "npm-pack",
        )
      : { ok: false, error: "Unsupported npm-pack plugin spec: missing archive path." };
  }
  const gitPrefix = params.raw.trim().toLowerCase().startsWith("git:");
  const git = parseGitPluginSpec(params.raw);
  if (gitPrefix) {
    return git
      ? sourcePlan({ source: "git", spec: params.raw, mode: params.mode }, params.raw, "git")
      : { ok: false, error: `unsupported git: plugin spec: ${params.raw}` };
  }
  const clawhubPrefix = params.raw.trim().toLowerCase().startsWith("clawhub:");
  const clawhub = parseClawHubPluginSpec(params.raw);
  if (clawhubPrefix) {
    return clawhub
      ? sourcePlan({ source: "clawhub", spec: params.raw, mode: params.mode }, params.raw)
      : { ok: false, error: `Unsupported ClawHub plugin spec: ${params.raw}` };
  }
  const explicitNpm = parseNpmPrefixSpec(params.raw);
  if (explicitNpm !== null && !explicitNpm) {
    return { ok: false, error: "Unsupported npm plugin spec: missing package." };
  }
  if (
    explicitNpm === null &&
    looksLikeLocalInstallSpec(params.raw, [
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
    return { ok: false, error: `Plugin path not found: ${resolved}` };
  }

  const npmSpec = explicitNpm ?? params.raw;
  const bundledPlan =
    explicitNpm === null
      ? resolveBundledInstallPlanBeforeNpm({
          rawSpec: params.raw,
          findBundledSource: (lookup) => findBundledPluginSource({ lookup }),
        })
      : null;
  if (bundledPlan) {
    return sourcePlan(
      {
        source: "bundled",
        rawSpec: params.raw,
        bundledSource: bundledPlan.bundledSource,
        warning: bundledPlan.warning,
      },
      params.raw,
    );
  }
  const official =
    explicitNpm === null ? resolveCatalogOfficialExternalInstallPlan(params.raw) : null;
  if (official) {
    return sourcePlan(
      {
        source: "official",
        spec: official.npmSpec,
        pluginId: official.pluginId,
        mode: params.mode,
        ...(official.expectedIntegrity ? { expectedIntegrity: official.expectedIntegrity } : {}),
        ...(params.pin ? { pin: true } : {}),
      },
      params.raw,
    );
  }
  const trusted = resolveOpenClawTrustedNpmPackageInstall(npmSpec);
  return sourcePlan(
    {
      source: "npm",
      spec: npmSpec,
      mode: params.mode,
      ...(params.pin ? { pin: true } : {}),
      ...(explicitNpm === null ? { allowBundledFallback: true } : {}),
      ...(trusted
        ? {
            expectedPluginId: trusted.pluginId,
            ...(trusted.expectedIntegrity ? { expectedIntegrity: trusted.expectedIntegrity } : {}),
            trustedSourceLinkedOfficialInstall: true,
          }
        : {}),
    },
    params.raw,
    trusted ? undefined : "npm",
  );
}

function isBareNpmPackageName(spec: string): boolean {
  const trimmed = spec.trim();
  return /^[a-z0-9][a-z0-9-._~]*$/.test(trimmed);
}

function isSourceCheckoutBundledPath(localPath: string): boolean {
  const extensionsDir = path.dirname(path.resolve(localPath));
  if (path.basename(extensionsDir) !== "extensions") {
    return false;
  }
  const extensionsParent = path.dirname(extensionsDir);
  const packageRoot = ["dist", "dist-runtime"].includes(path.basename(extensionsParent))
    ? path.dirname(extensionsParent)
    : extensionsParent;
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as { name?: unknown };
    return (
      packageJson.name === "openclaw" &&
      fs.existsSync(path.join(packageRoot, ".git")) &&
      fs.existsSync(path.join(packageRoot, "pnpm-workspace.yaml")) &&
      fs.existsSync(path.join(packageRoot, "src")) &&
      fs.existsSync(path.join(packageRoot, "extensions"))
    );
  } catch {
    return false;
  }
}

export function resolveBundledInstallPlanForCatalogEntry(params: {
  pluginId: string;
  npmSpec: string;
  findBundledSource: BundledLookup;
}): { bundledSource: BundledPluginSource } | null {
  const pluginId = params.pluginId.trim();
  const npmSpec = params.npmSpec.trim();
  if (!pluginId || !npmSpec) {
    return null;
  }

  const bundledBySpec = params.findBundledSource({
    kind: "npmSpec",
    value: npmSpec,
  });
  if (bundledBySpec?.pluginId === pluginId) {
    return { bundledSource: bundledBySpec };
  }

  const bundledById = params.findBundledSource({
    kind: "pluginId",
    value: pluginId,
  });
  if (bundledById?.pluginId !== pluginId) {
    return null;
  }
  if (bundledById.npmSpec && bundledById.npmSpec !== npmSpec) {
    return null;
  }

  return { bundledSource: bundledById };
}

function resolveBundledInstallPlanBeforeNpm(params: {
  rawSpec: string;
  findBundledSource: BundledLookup;
}): { bundledSource: BundledPluginSource; warning: string } | null {
  // Bundled plugin ids win before npm lookup so local official plugins do not hit the registry.
  const rawSpec = params.rawSpec.trim();
  if (!rawSpec) {
    return null;
  }
  if (isBareNpmPackageName(rawSpec)) {
    const bundledSource = params.findBundledSource({
      kind: "pluginId",
      value: rawSpec,
    });
    if (!bundledSource) {
      return null;
    }
    return {
      bundledSource,
      warning: `Using bundled plugin "${bundledSource.pluginId}" from ${shortenHomePath(bundledSource.localPath)} for bare install spec "${rawSpec}". To install an npm package with the same name, use a scoped package name (for example @scope/${rawSpec}).`,
    };
  }

  const parsedNpmSpec = parseRegistryNpmSpec(rawSpec);
  if (!parsedNpmSpec) {
    return null;
  }
  const bundledSource =
    params.findBundledSource({
      kind: "npmSpec",
      value: rawSpec,
    }) ??
    params.findBundledSource({
      kind: "npmSpec",
      value: parsedNpmSpec.name,
    });
  if (!bundledSource) {
    return null;
  }
  // An explicit npm request from a Git source checkout is package intent, not a
  // request to persist disposable build output from that checkout. Packaged
  // bundles remain image-owned, and bare plugin ids still select local source.
  if (
    !isBareNpmPackageName(params.rawSpec) &&
    isSourceCheckoutBundledPath(bundledSource.localPath)
  ) {
    return null;
  }
  return {
    bundledSource,
    warning: `Using bundled plugin "${bundledSource.pluginId}" from ${shortenHomePath(bundledSource.localPath)} for npm install spec "${rawSpec}" because this plugin ships with the current OpenClaw build. To force an external npm override, use npm:${rawSpec}.`,
  };
}

export function resolveBundledInstallPlanForNpmFailure(params: {
  rawSpec: string;
  code?: string;
  findBundledSource: BundledLookup;
}): { bundledSource: BundledPluginSource; warning: string } | null {
  if (params.code !== PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND) {
    return null;
  }
  const bundledSource = params.findBundledSource({
    kind: "npmSpec",
    value: params.rawSpec,
  });
  if (!bundledSource) {
    return null;
  }
  if (
    !isBareNpmPackageName(params.rawSpec) &&
    isSourceCheckoutBundledPath(bundledSource.localPath)
  ) {
    return null;
  }
  return {
    bundledSource,
    warning: `npm package unavailable for ${params.rawSpec}; using bundled plugin at ${shortenHomePath(bundledSource.localPath)}.`,
  };
}
