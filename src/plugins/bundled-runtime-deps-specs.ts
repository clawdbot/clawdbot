import path from "node:path";
import { validSemver } from "./semver.runtime.js";

export type RuntimeDepEntry = {
  name: string;
  version: string;
  pluginIds: string[];
};

const BUNDLED_RUNTIME_DEP_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function normalizeInstallableRuntimeDepName(rawName: string): string | null {
  const depName = rawName.trim();
  if (depName === "") {
    return null;
  }
  const segments = depName.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  if (segments.length === 1) {
    return BUNDLED_RUNTIME_DEP_SEGMENT_RE.test(segments[0] ?? "") ? depName : null;
  }
  if (segments.length !== 2 || !segments[0]?.startsWith("@")) {
    return null;
  }
  const scope = segments[0].slice(1);
  const packageName = segments[1];
  return BUNDLED_RUNTIME_DEP_SEGMENT_RE.test(scope) &&
    BUNDLED_RUNTIME_DEP_SEGMENT_RE.test(packageName ?? "")
    ? depName
    : null;
}

function normalizeInstallableRuntimeDepVersion(rawVersion: unknown): string | null {
  if (typeof rawVersion !== "string") {
    return null;
  }
  const version = rawVersion.trim();
  if (version === "" || version.toLowerCase().startsWith("workspace:")) {
    return null;
  }
  if (validSemver(version)) {
    return version;
  }
  const rangePrefix = version[0];
  if ((rangePrefix === "^" || rangePrefix === "~") && validSemver(version.slice(1))) {
    return version;
  }
  return null;
}

export function parseInstallableRuntimeDep(
  name: string,
  rawVersion: unknown,
): { name: string; version: string } | null {
  if (typeof rawVersion !== "string") {
    return null;
  }
  const version = rawVersion.trim();
  if (version === "" || version.toLowerCase().startsWith("workspace:")) {
    return null;
  }
  const normalizedName = normalizeInstallableRuntimeDepName(name);
  if (!normalizedName) {
    throw new Error(`Invalid bundled runtime dependency name: ${name}`);
  }
  const normalizedVersion = normalizeInstallableRuntimeDepVersion(version);
  if (!normalizedVersion) {
    throw new Error(
      `Unsupported bundled runtime dependency spec for ${normalizedName}: ${version}`,
    );
  }
  return { name: normalizedName, version: normalizedVersion };
}

export function parseInstallableRuntimeDepSpec(spec: string): { name: string; version: string } {
  const atIndex = spec.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === spec.length - 1) {
    throw new Error(`Invalid bundled runtime dependency install spec: ${spec}`);
  }
  const parsed = parseInstallableRuntimeDep(spec.slice(0, atIndex), spec.slice(atIndex + 1));
  if (!parsed) {
    throw new Error(`Invalid bundled runtime dependency install spec: ${spec}`);
  }
  return parsed;
}

export function normalizeRuntimeDepSpecs(specs: readonly string[]): string[] {
  specs.forEach((spec) => {
    parseInstallableRuntimeDepSpec(spec);
  });
  return [...new Set(specs)].toSorted((left, right) => left.localeCompare(right));
}

export function collectPackageRuntimeDeps(
  packageJson: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(packageJson.dependencies as Record<string, unknown> | undefined),
    ...(packageJson.optionalDependencies as Record<string, unknown> | undefined),
  };
}

function dependencySentinelPath(depName: string): string {
  const normalizedDepName = normalizeInstallableRuntimeDepName(depName);
  if (!normalizedDepName) {
    throw new Error(`Invalid bundled runtime dependency name: ${depName}`);
  }
  return path.join("node_modules", ...normalizedDepName.split("/"), "package.json");
}

export function resolveDependencySentinelAbsolutePath(rootDir: string, depName: string): string {
  const nodeModulesDir = path.resolve(rootDir, "node_modules");
  const sentinelPath = path.resolve(rootDir, dependencySentinelPath(depName));
  if (sentinelPath !== nodeModulesDir && !sentinelPath.startsWith(`${nodeModulesDir}${path.sep}`)) {
    throw new Error(`Blocked runtime dependency path escape for ${depName}`);
  }
  return sentinelPath;
}
