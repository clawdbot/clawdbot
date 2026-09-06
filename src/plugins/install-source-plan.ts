import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PluginsInstallParams } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { looksLikeLocalInstallSpec } from "../infra/install-spec.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { findBundledPluginSource, type BundledPluginSource } from "./bundled-sources.js";
import { parseGitPluginSpec } from "./git-install.js";
import { resolveDefaultNpmSpec } from "./install-channel-specs.js";
import {
  resolveOpenClawTrustedNpmPackageInstall,
  type NonClawHubInstallSourceClass,
} from "./install-provenance.js";
import {
  parseNpmPackPrefixPath,
  parseNpmPrefixSpec,
  resolveFileNpmSpecToLocalPath,
} from "./install-source-spec.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "./install.js";
import { resolveOfficialEntryById } from "./management-catalog.js";
import type { ManagedPluginSourceInstallRequest } from "./management-install.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import {
  resolveCatalogOfficialExternalInstallPlan,
  resolveOfficialInstallSources,
} from "./official-external-install-trust.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginInstallSources,
  type OfficialExternalPluginCatalogEntry,
} from "./official-external-plugin-catalog.js";

type BundledLookup = (params: {
  kind: "pluginId" | "npmSpec";
  value: string;
}) => BundledPluginSource | undefined;

type PluginInstallSourcePlan =
  | { ok: false; error: string }
  | {
      ok: true;
      request: PluginsInstallParams;
      warning?: string;
      allowBundledFallback?: boolean;
      acknowledgement?: { sourceClass: NonClawHubInstallSourceClass; spec: string };
    };

function sourcePlan(
  request: PluginsInstallParams,
  raw: string,
  sourceClass?: NonClawHubInstallSourceClass,
  metadata: { warning?: string; allowBundledFallback?: boolean } = {},
): PluginInstallSourcePlan {
  return {
    ok: true,
    request,
    ...metadata,
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
      ? sourcePlan(
          {
            source: "clawhub",
            packageName: clawhub.name,
            version: clawhub.version,
            mode: params.mode,
          },
          params.raw,
        )
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
        pluginId: bundledPlan.bundledSource.pluginId,
      },
      params.raw,
      undefined,
      { warning: bundledPlan.warning },
    );
  }
  const official =
    explicitNpm === null ? resolveCatalogOfficialExternalInstallPlan(params.raw) : null;
  if (official) {
    return sourcePlan(
      {
        source: "official",
        pluginId: official.pluginId,
        ...(resolveDefaultNpmSpec(params.raw)?.selector ? { version: "latest" as const } : {}),
        mode: params.mode,
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
      ...(trusted
        ? {
            expectedPluginId: trusted.pluginId,
            ...(trusted.expectedIntegrity ? { expectedIntegrity: trusted.expectedIntegrity } : {}),
          }
        : {}),
    },
    params.raw,
    trusted ? undefined : "npm",
    { allowBundledFallback: explicitNpm === null },
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
    const packageJson: unknown = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    );
    return (
      isRecord(packageJson) &&
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

/** Explicitly declared runtime id, ignoring the entry-id fallback used for display. */
function resolveDeclaredOfficialPluginId(
  entry: OfficialExternalPluginCatalogEntry,
): string | undefined {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return (
    normalizeOptionalString(manifest?.plugin?.id) ??
    normalizeOptionalString(manifest?.channel?.id) ??
    normalizeOptionalString(manifest?.providers?.[0]?.id)
  );
}

function resolveOfficialEntryByClawHubPackage(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  packageName: string,
): OfficialExternalPluginCatalogEntry | undefined {
  return entries.find((entry) =>
    resolveOfficialExternalPluginInstallSources(entry).some(
      (source) =>
        source.source === "clawhub" && parseClawHubPluginSpec(source.spec)?.name === packageName,
    ),
  );
}

function resolveManagedClawHubInstallRequest(params: {
  request: Extract<PluginsInstallParams, { source: "clawhub" }>;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
}): Extract<ManagedPluginSourceInstallRequest, { source: "clawhub" }> {
  const packageName = params.request.packageName.trim();
  // Bundled identities remain the local trust anchor when a hosted feed omits
  // its ClawHub candidate; hosted install/version metadata is never copied back.
  const official = resolveOfficialEntryByClawHubPackage(
    [...listOfficialExternalPluginCatalogEntries(), ...params.officialEntries],
    packageName,
  );
  // Pin the runtime id only when the catalog entry declares one; the entry-id
  // fallback is just the package name and would reject legitimate installs.
  const expectedPluginId = official ? resolveDeclaredOfficialPluginId(official) : undefined;
  const hostedOfficial = resolveOfficialEntryByClawHubPackage(params.officialEntries, packageName);
  const hostedSource = hostedOfficial
    ? resolveOfficialExternalPluginInstallSources(hostedOfficial).find(
        (source) => source.source === "clawhub",
      )
    : undefined;
  const hostedClawHub = parseClawHubPluginSpec(hostedSource?.spec ?? "");
  const requestMatchesHostedCandidate =
    !params.request.version || params.request.version === hostedClawHub?.version;
  const version = params.request.version ?? hostedClawHub?.version;
  const expectedIntegrity =
    params.request.expectedIntegrity ??
    (requestMatchesHostedCandidate ? hostedSource?.expectedIntegrity : undefined);
  const parsed = parseClawHubPluginSpec(`clawhub:${packageName}`);
  if (!parsed || parsed.version) {
    throw new ManagedPluginLifecycleError(`invalid ClawHub package name: ${packageName}`);
  }
  return {
    source: "clawhub",
    spec: `clawhub:${packageName}${version ? `@${version}` : ""}`,
    ...(official ? { trustedSourceLinkedOfficialInstall: true } : {}),
    ...(expectedPluginId ? { expectedPluginId } : {}),
    ...(expectedIntegrity ? { expectedIntegrity } : {}),
  };
}

function resolveManagedOfficialInstallRequest(params: {
  request: Extract<PluginsInstallParams, { source: "official" }>;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
}): Extract<ManagedPluginSourceInstallRequest, { source: "official" }> {
  // CLI-known official ids retain the local catalog authority when omitted by a
  // hosted feed. A present hosted row owns its refusal and is never replaced.
  const entry =
    resolveOfficialEntryById(params.officialEntries, params.request.pluginId) ??
    resolveOfficialEntryById(listOfficialExternalPluginCatalogEntries(), params.request.pluginId);
  if (!entry) {
    throw new ManagedPluginLifecycleError(
      `unknown official plugin catalog entry: ${params.request.pluginId}`,
    );
  }
  const pluginId = resolveOfficialExternalPluginId(entry);
  const install = resolveOfficialExternalPluginInstall(entry);
  if (!pluginId || !install) {
    throw new ManagedPluginLifecycleError(
      `official plugin catalog entry is not installable: ${params.request.pluginId}`,
    );
  }
  const installSources = resolveOfficialInstallSources(entry, params.request.version).filter(
    (source) => !params.request.pin || source.source === "npm",
  );
  const primary = installSources[0];
  if (!primary) {
    throw new ManagedPluginLifecycleError(
      `official plugin catalog entry has no supported install source: ${params.request.pluginId}`,
    );
  }
  return {
    source: "official",
    spec: primary.spec,
    installSources,
    pluginId,
    expectedPluginId: resolveDeclaredOfficialPluginId(entry),
    mode: "install",
    ...(params.request.pin ? { pin: true } : {}),
  };
}

/** Resolve public source requests without accepting caller-asserted official trust. */
export function resolveManagedPluginInstallRequest(
  request: PluginsInstallParams,
  officialEntries: readonly OfficialExternalPluginCatalogEntry[],
): ManagedPluginSourceInstallRequest {
  const mode = request.mode ?? "install";
  switch (request.source) {
    case "clawhub":
      return {
        ...resolveManagedClawHubInstallRequest({ request, officialEntries }),
        mode,
        ...(request.expectedPluginId ? { expectedPluginId: request.expectedPluginId } : {}),
      };
    case "official":
      return { ...resolveManagedOfficialInstallRequest({ request, officialEntries }), mode };
    case "bundled": {
      const bundledSource = findBundledPluginSource({
        lookup: { kind: "pluginId", value: request.pluginId },
      });
      if (!bundledSource) {
        throw new ManagedPluginLifecycleError(`unknown bundled plugin: ${request.pluginId}`);
      }
      return { source: "bundled", bundledSource };
    }
    case "local": {
      const bundledSource = findBundledPluginSource({
        lookup: { kind: "localPath", value: request.path },
      });
      return {
        ...request,
        mode,
        ...(bundledSource ? { bundledOrigin: true } : {}),
        recordSource: resolveArchiveKind(request.path) ? "archive" : "path",
      };
    }
    case "npm": {
      const trusted = resolveOpenClawTrustedNpmPackageInstall(request.spec);
      return {
        ...request,
        mode,
        ...(trusted ? { trustedSourceLinkedOfficialInstall: true } : {}),
        expectedPluginId: request.expectedPluginId ?? trusted?.pluginId,
        expectedIntegrity: request.expectedIntegrity ?? trusted?.expectedIntegrity,
      };
    }
    case "git":
    case "npm-pack":
    case "marketplace":
      return { ...request, mode };
  }
  request satisfies never;
  return assert.fail("Unreachable plugin install source");
}
