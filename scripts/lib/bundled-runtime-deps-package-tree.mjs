import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import semverSatisfies from "semver/functions/satisfies.js";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function dependencyPathSegments(depName) {
  if (typeof depName !== "string" || depName.length === 0) {
    return null;
  }
  const segments = depName.split("/");
  if (depName.startsWith("@")) {
    if (segments.length !== 2) {
      return null;
    }
    const [scope, name] = segments;
    if (
      !/^@[A-Za-z0-9._-]+$/.test(scope) ||
      !/^[A-Za-z0-9._-]+$/.test(name) ||
      scope === "@." ||
      scope === "@.."
    ) {
      return null;
    }
    return [scope, name];
  }
  if (segments.length !== 1 || !/^[A-Za-z0-9._-]+$/.test(segments[0])) {
    return null;
  }
  return segments;
}

export function dependencyNodeModulesPath(nodeModulesDir, depName) {
  const segments = dependencyPathSegments(depName);
  return segments ? path.join(nodeModulesDir, ...segments) : null;
}

function dependencyVersionSatisfied(spec, installedVersion) {
  return semverSatisfies(installedVersion, spec, { includePrerelease: false });
}

export function readInstalledDependencyVersionFromRoot(depRoot) {
  const packageJsonPath = path.join(depRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  const version = readJson(packageJsonPath).version;
  return typeof version === "string" ? version : null;
}

export function resolveInstalledDependencyRoot(params) {
  const candidates = [];
  if (params.parentPackageRoot) {
    const nestedDepRoot = dependencyNodeModulesPath(
      path.join(params.parentPackageRoot, "node_modules"),
      params.depName,
    );
    if (nestedDepRoot !== null) {
      candidates.push(nestedDepRoot);
    }
  }
  const rootDepRoot = dependencyNodeModulesPath(params.rootNodeModulesDir, params.depName);
  if (rootDepRoot !== null) {
    candidates.push(rootDepRoot);
  }

  for (const depRoot of candidates) {
    const installedVersion = readInstalledDependencyVersionFromRoot(depRoot);
    if (installedVersion === null) {
      continue;
    }
    if (params.enforceSpec === false || dependencyVersionSatisfied(params.spec, installedVersion)) {
      return depRoot;
    }
  }

  return null;
}

export function collectInstalledRuntimeDependencyRoots(
  rootNodeModulesDir,
  dependencySpecs,
  directDependencyPackageRoot = null,
  optionalDependencyNames = new Set(),
) {
  const packageCache = new Map();
  const directRoots = [];
  const allRoots = [];
  const queue = Object.entries(dependencySpecs).map(([depName, spec]) => ({
    depName,
    optional: optionalDependencyNames.has(depName),
    spec,
    parentPackageRoot: directDependencyPackageRoot,
    direct: true,
  }));
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    const depRoot = resolveInstalledDependencyRoot({
      depName: current.depName,
      spec: current.spec,
      enforceSpec: current.direct,
      parentPackageRoot: current.parentPackageRoot,
      rootNodeModulesDir,
    });
    if (depRoot === null) {
      if (current.optional) {
        continue;
      }
      return null;
    }
    const canonicalDepRoot = fs.realpathSync(depRoot);

    const seenKey = `${current.depName}\0${canonicalDepRoot}`;
    if (seen.has(seenKey)) {
      continue;
    }
    seen.add(seenKey);

    const record = { name: current.depName, root: depRoot, realRoot: canonicalDepRoot };
    allRoots.push(record);
    if (current.direct) {
      directRoots.push(record);
    }

    const packageJson =
      packageCache.get(canonicalDepRoot) ?? readJson(path.join(depRoot, "package.json"));
    packageCache.set(canonicalDepRoot, packageJson);
    for (const [childName, childSpec] of Object.entries(packageJson.dependencies ?? {})) {
      queue.push({
        depName: childName,
        optional: false,
        spec: childSpec,
        parentPackageRoot: depRoot,
        direct: false,
      });
    }
    for (const [childName, childSpec] of Object.entries(packageJson.optionalDependencies ?? {})) {
      queue.push({
        depName: childName,
        optional: true,
        spec: childSpec,
        parentPackageRoot: depRoot,
        direct: false,
      });
    }
  }

  return { allRoots, directRoots };
}

function pathIsInsideCopiedRoot(candidateRoot, copiedRoot) {
  return candidateRoot === copiedRoot || candidateRoot.startsWith(`${copiedRoot}${path.sep}`);
}

export function findContainingRealRoot(candidatePath, allowedRealRoots) {
  return (
    allowedRealRoots.find((rootPath) => pathIsInsideCopiedRoot(candidatePath, rootPath)) ?? null
  );
}

export function selectRuntimeDependencyRootsToCopy(resolution) {
  const rootsToCopy = [];

  for (const record of resolution.directRoots) {
    rootsToCopy.push(record);
  }

  for (const record of resolution.allRoots) {
    if (rootsToCopy.some((entry) => pathIsInsideCopiedRoot(record.realRoot, entry.realRoot))) {
      continue;
    }
    rootsToCopy.push(record);
  }

  return rootsToCopy;
}

export function resolveInstalledDirectDependencyNames(
  rootNodeModulesDir,
  dependencySpecs,
  directDependencyPackageRoot = null,
  optionalDependencyNames = new Set(),
) {
  const directDependencyNames = [];
  for (const [depName, spec] of Object.entries(dependencySpecs)) {
    const depRoot = resolveInstalledDependencyRoot({
      depName,
      spec,
      parentPackageRoot: directDependencyPackageRoot,
      rootNodeModulesDir,
    });
    if (depRoot === null) {
      if (optionalDependencyNames.has(depName)) {
        continue;
      }
      return null;
    }
    const installedVersion = readInstalledDependencyVersionFromRoot(depRoot);
    if (installedVersion === null || !dependencyVersionSatisfied(spec, installedVersion)) {
      return null;
    }
    directDependencyNames.push(depName);
  }
  return directDependencyNames;
}

function appendDirectoryFingerprint(hash, rootDir, currentDir = rootDir) {
  const entries = fs
    .readdirSync(currentDir, { withFileTypes: true })
    .toSorted((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
    const stats = fs.lstatSync(fullPath);
    if (stats.isSymbolicLink()) {
      hash.update(`symlink:${relativePath}->${fs.readlinkSync(fullPath).replace(/\\/g, "/")}\n`);
      continue;
    }
    if (stats.isDirectory()) {
      hash.update(`dir:${relativePath}\n`);
      appendDirectoryFingerprint(hash, rootDir, fullPath);
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }
    const stat = fs.statSync(fullPath);
    hash.update(`file:${relativePath}:${stat.size}\n`);
    hash.update(fs.readFileSync(fullPath));
  }
}

function createInstalledRuntimeClosureFingerprint(records) {
  const hash = createHash("sha256");
  for (const record of [...records].toSorted(
    (left, right) =>
      left.name.localeCompare(right.name) || left.realRoot.localeCompare(right.realRoot),
  )) {
    if (!fs.existsSync(record.realRoot)) {
      return null;
    }
    hash.update(`package:${record.name}:${record.realRoot}\n`);
    appendDirectoryFingerprint(hash, record.realRoot);
  }
  return hash.digest("hex");
}

export function resolveInstalledRuntimeClosureFingerprint(params) {
  const dependencySpecs = {
    ...params.packageJson.dependencies,
    ...params.packageJson.optionalDependencies,
  };
  if (Object.keys(dependencySpecs).length === 0 || !fs.existsSync(params.rootNodeModulesDir)) {
    return null;
  }
  const resolution = collectInstalledRuntimeDependencyRoots(
    params.rootNodeModulesDir,
    dependencySpecs,
    params.directDependencyPackageRoot,
    new Set(Object.keys(params.packageJson.optionalDependencies ?? {})),
  );
  if (resolution === null) {
    return null;
  }
  return createInstalledRuntimeClosureFingerprint(selectRuntimeDependencyRootsToCopy(resolution));
}
