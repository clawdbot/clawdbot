// Lists current-target production packages for Docker's offline prune store seed.
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { pnpmLockfileDocuments } from "./lib/pnpm-lockfile-documents.mjs";
const specs = new Set();
const target = {
  cpu: process.arch,
  libc: detectLibc(),
  os: process.platform,
};
function packageSpec(name, version) {
  if (typeof name !== "string" || !name || typeof version !== "string" || !version) {
    return undefined;
  }
  const normalizedVersion = version.replace(/\(.+\)$/, "");
  if (
    normalizedVersion.startsWith("file:") ||
    normalizedVersion.startsWith("link:") ||
    normalizedVersion.startsWith("workspace:")
  ) {
    return undefined;
  }
  if (normalizedVersion.startsWith("npm:")) {
    return normalizedVersion.slice("npm:".length);
  }
  if (normalizedVersion.startsWith("@")) {
    return normalizedVersion;
  }
  return `${name}@${normalizedVersion}`;
}
function detectLibc() {
  if (process.platform !== "linux") {
    return undefined;
  }
  const report = process.report?.getReport?.();
  return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}
function matchesTargetSelector(selector, value) {
  if (!Array.isArray(selector) || !value) {
    return true;
  }
  const blocked = selector.some((entry) => entry === `!${value}`);
  if (blocked) {
    return false;
  }
  const allowed = selector.filter((entry) => typeof entry === "string" && !entry.startsWith("!"));
  return allowed.length === 0 || allowed.includes(value);
}
function packageEntryForSpec(lockfile, spec) {
  return lockfile?.packages?.[spec] ?? lockfile?.packages?.[`/${spec}`];
}
function normalizeLockfilePackageKey(key) {
  if (typeof key !== "string") {
    return undefined;
  }
  return (key.startsWith("/") ? key.slice(1) : key).replace(/\(.+\)$/, "");
}
function snapshotForSpec(lockfile, spec) {
  const snapshots = lockfile?.snapshots;
  if (!snapshots) {
    return undefined;
  }
  return (
    snapshots[spec] ??
    snapshots[`/${spec}`] ??
    Object.entries(snapshots).find(([key]) => normalizeLockfilePackageKey(key) === spec)?.[1]
  );
}
function packageSupportsTarget(lockfile, spec) {
  const entry = packageEntryForSpec(lockfile, spec);
  return (
    matchesTargetSelector(entry?.os, target.os) &&
    matchesTargetSelector(entry?.cpu, target.cpu) &&
    matchesTargetSelector(entry?.libc, target.libc)
  );
}
function addSpec(lockfile, spec) {
  if (spec && packageSupportsTarget(lockfile, spec)) {
    specs.add(spec);
  }
}
function addImporterRoots(lockfile) {
  for (const importer of Object.values(lockfile?.importers ?? {})) {
    for (const deps of [importer.dependencies, importer.optionalDependencies]) {
      for (const [name, dep] of Object.entries(deps ?? {})) {
        addSpec(lockfile, packageSpec(name, dep?.version));
      }
    }
  }
}
function readLockfile() {
  const lockfilePath = path.join(process.cwd(), "pnpm-lock.yaml");
  return parse(pnpmLockfileDocuments(fs.readFileSync(lockfilePath, "utf8")).dependencies);
}
function addSnapshotClosure(lockfile) {
  const snapshots = lockfile?.snapshots;
  const packages = lockfile?.packages;
  if (!snapshots || !packages) {
    return;
  }
  const pending = [...specs];
  const visited = new Set();
  while (pending.length > 0) {
    const spec = pending.pop();
    if (!spec || visited.has(spec)) {
      continue;
    }
    visited.add(spec);
    const snapshot = snapshotForSpec(lockfile, spec);
    if (!snapshot) {
      continue;
    }
    const addDependencySpec = (name, version) => {
      const depSpec = packageSpec(name, typeof version === "string" ? version : version.version);
      if (
        !depSpec ||
        !packages[depSpec] ||
        specs.has(depSpec) ||
        !packageSupportsTarget(lockfile, depSpec)
      ) {
        return;
      }
      specs.add(depSpec);
      pending.push(depSpec);
    };
    for (const [name, version] of Object.entries(snapshot.dependencies ?? {})) {
      addDependencySpec(name, version);
    }
    for (const [name, version] of Object.entries(snapshot.optionalDependencies ?? {})) {
      addDependencySpec(name, version);
    }
  }
}
const lockfile = readLockfile();
addImporterRoots(lockfile);
addSnapshotClosure(lockfile);
process.stdout.write([...specs].toSorted((a, b) => a.localeCompare(b)).join("\n"));
