// Lists current-target production packages for Docker's offline prune store seed.
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

type DependencyValue = {
  from?: string;
  name?: string;
  version?: string | { version?: string };
  resolved?: string;
  dependencies?: Record<string, DependencyValue>;
};
type PackageEntry = { os?: unknown; cpu?: unknown; libc?: unknown };
type SnapshotEntry = {
  dependencies?: Record<string, string | { version?: string }>;
  optionalDependencies?: Record<string, string | { version?: string }>;
};
type ImporterEntry = {
  dependencies?: Record<string, { version?: string }>;
  optionalDependencies?: Record<string, { version?: string }>;
};
type Lockfile = {
  packages?: Record<string, PackageEntry>;
  snapshots?: Record<string, SnapshotEntry>;
  importers?: Record<string, ImporterEntry>;
};

const specs = new Set<string>();
const target = {
  cpu: process.arch,
  libc: detectLibc(),
  os: process.platform,
};

function packageSpec(name: unknown, version: unknown): string | undefined {
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

function detectLibc(): string | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: unknown } }
    | undefined;
  return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

function matchesTargetSelector(selector: unknown, value: string | undefined): boolean {
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

function packageEntryForSpec(
  lockfile: Lockfile | undefined,
  spec: string,
): PackageEntry | undefined {
  return lockfile?.packages?.[spec] ?? lockfile?.packages?.[`/${spec}`];
}

function normalizeLockfilePackageKey(key: unknown): string | undefined {
  if (typeof key !== "string") {
    return undefined;
  }
  return (key.startsWith("/") ? key.slice(1) : key).replace(/\(.+\)$/, "");
}

function snapshotForSpec(lockfile: Lockfile | undefined, spec: string): SnapshotEntry | undefined {
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

function packageSupportsTarget(lockfile: Lockfile | undefined, spec: string): boolean {
  const entry = packageEntryForSpec(lockfile, spec);
  return (
    matchesTargetSelector(entry?.os, target.os) &&
    matchesTargetSelector(entry?.cpu, target.cpu) &&
    matchesTargetSelector(entry?.libc, target.libc)
  );
}

function addSpec(lockfile: Lockfile | undefined, spec: string | undefined): void {
  if (spec && packageSupportsTarget(lockfile, spec)) {
    specs.add(spec);
  }
}

function parseListRoots(): DependencyValue[] {
  const input = fs.readFileSync(0, "utf8").trim();
  if (!input) {
    return [];
  }
  const parsed: unknown = JSON.parse(input);
  return (Array.isArray(parsed) ? parsed : [parsed]) as DependencyValue[];
}

function visitListNode(lockfile: Lockfile | undefined, node: DependencyValue): void {
  for (const dep of Object.values(node.dependencies ?? {})) {
    const name = dep.from || dep.name;
    const spec = packageSpec(name, dep.version);
    if (spec && dep.resolved?.startsWith("https://registry.npmjs.org/")) {
      addSpec(lockfile, spec);
    }
    visitListNode(lockfile, dep);
  }
}

function addImporterRoots(lockfile: Lockfile | undefined): void {
  for (const importer of Object.values(lockfile?.importers ?? {})) {
    for (const deps of [importer.dependencies, importer.optionalDependencies]) {
      for (const [name, dep] of Object.entries(deps ?? {})) {
        addSpec(lockfile, packageSpec(name, dep?.version));
      }
    }
  }
}

function readLockfile(): Lockfile | undefined {
  const lockfilePath = path.join(process.cwd(), "pnpm-lock.yaml");
  if (!fs.existsSync(lockfilePath)) {
    return undefined;
  }
  return parse(fs.readFileSync(lockfilePath, "utf8")) as Lockfile;
}

function addSnapshotClosure(lockfile: Lockfile | undefined): void {
  const snapshots = lockfile?.snapshots;
  const packages = lockfile?.packages;
  if (!snapshots || !packages) {
    return;
  }
  const pending = [...specs];
  const visited = new Set<string>();
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
    const addDependencySpec = (name: string, version: string | { version?: string }): void => {
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
for (const root of parseListRoots()) {
  visitListNode(lockfile, root);
}
addImporterRoots(lockfile);
addSnapshotClosure(lockfile);

process.stdout.write([...specs].toSorted((a, b) => a.localeCompare(b)).join("\n"));
