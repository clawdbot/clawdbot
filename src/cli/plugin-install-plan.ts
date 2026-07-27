// Plugin install planning helpers for bundled, official external, and npm fallback paths.
import fs from "node:fs";
import path from "node:path";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import type { BundledPluginSource } from "../plugins/bundled-sources.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../plugins/install.js";
import { shortenHomePath } from "../utils.js";

type BundledLookup = (params: {
  kind: "pluginId" | "npmSpec";
  value: string;
}) => BundledPluginSource | undefined;

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

export function resolveBundledInstallPlanBeforeNpm(params: {
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
