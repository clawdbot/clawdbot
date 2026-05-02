import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type PackageJson = {
  name?: string;
  version?: string;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  openclaw?: {
    install?: {
      minHostVersion?: string;
    };
    compat?: {
      pluginApi?: string;
    };
    build?: {
      openclawVersion?: string;
    };
  };
};

type SyncPluginVersionsOptions = {
  write?: boolean;
};

const OPENCLAW_VERSION_RANGE_RE = /^>=\d{4}\.\d{1,2}\.\d{1,2}(?:[-.][^"\s]+)?$/u;

function syncOpenClawDependencyRange(
  deps: Record<string, string> | undefined,
  targetVersion: string,
): boolean {
  const current = deps?.openclaw;
  if (!current || current === "workspace:*" || !OPENCLAW_VERSION_RANGE_RE.test(current)) {
    return false;
  }
  const next = `>=${targetVersion}`;
  if (current === next) {
    return false;
  }
  deps.openclaw = next;
  return true;
}

function syncPluginApiVersion(pkg: PackageJson, targetVersion: string): boolean {
  const compat = pkg.openclaw?.compat;
  const current = compat?.pluginApi;
  if (!current || !OPENCLAW_VERSION_RANGE_RE.test(current)) {
    return false;
  }
  const next = `>=${targetVersion}`;
  if (current === next) {
    return false;
  }
  compat.pluginApi = next;
  return true;
}

function syncBuildOpenClawVersion(pkg: PackageJson, targetVersion: string): boolean {
  const build = pkg.openclaw?.build;
  const current = build?.openclawVersion;
  if (!current) {
    return false;
  }
  if (current === targetVersion) {
    return false;
  }
  build.openclawVersion = targetVersion;
  return true;
}

function ensureChangelogEntry(changelogPath: string, version: string, write: boolean): boolean {
  if (!existsSync(changelogPath)) {
    return false;
  }
  const content = readFileSync(changelogPath, "utf8");
  if (content.includes(`## ${version}`)) {
    return false;
  }
  const entry = `## ${version}\n\n### Changes\n- Version alignment with core OpenClaw release numbers.\n\n`;
  if (content.startsWith("# Changelog\n\n")) {
    const next = content.replace("# Changelog\n\n", `# Changelog\n\n${entry}`);
    if (write) {
      writeFileSync(changelogPath, next);
    }
    return true;
  }
  const next = `# Changelog\n\n${entry}${content.trimStart()}`;
  if (write) {
    writeFileSync(changelogPath, `${next}\n`);
  }
  return true;
}

export function syncPluginVersions(
  rootDir = resolve("."),
  options: SyncPluginVersionsOptions = {},
) {
  const write = options.write ?? true;
  const rootPackagePath = join(rootDir, "package.json");
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as PackageJson;
  const targetVersion = rootPackage.version;
  if (!targetVersion) {
    throw new Error("Root package.json missing version.");
  }

  const extensionsDir = join(rootDir, "extensions");
  const dirs = readdirSync(extensionsDir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  const updated: string[] = [];
  const changelogged: string[] = [];
  const skipped: string[] = [];

  for (const dir of dirs) {
    const packagePath = join(extensionsDir, dir.name, "package.json");
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
    } catch {
      continue;
    }

    if (!pkg.name) {
      skipped.push(dir.name);
      continue;
    }

    const changelogPath = join(extensionsDir, dir.name, "CHANGELOG.md");
    if (ensureChangelogEntry(changelogPath, targetVersion, write)) {
      changelogged.push(pkg.name);
    }

    const versionChanged = pkg.version !== targetVersion;
    const devDependencyChanged = syncOpenClawDependencyRange(pkg.devDependencies, targetVersion);
    const peerDependencyChanged = syncOpenClawDependencyRange(pkg.peerDependencies, targetVersion);
    // minHostVersion is a compatibility floor, not release alignment metadata.
    // Keep it stable unless the owning plugin intentionally raises it.
    const pluginApiChanged = syncPluginApiVersion(pkg, targetVersion);
    const buildOpenClawVersionChanged = syncBuildOpenClawVersion(pkg, targetVersion);
    const packageChanged =
      versionChanged ||
      devDependencyChanged ||
      peerDependencyChanged ||
      pluginApiChanged ||
      buildOpenClawVersionChanged;
    if (!packageChanged) {
      skipped.push(pkg.name);
      continue;
    }

    if (versionChanged) {
      pkg.version = targetVersion;
    }
    if (write) {
      writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    }
    updated.push(pkg.name);
  }

  return {
    targetVersion,
    updated,
    changelogged,
    skipped,
  };
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const summary = syncPluginVersions(resolve("."), { write: !check });
  console.log(
    `Synced plugin versions to ${summary.targetVersion}. Updated: ${summary.updated.length}. Changelogged: ${summary.changelogged.length}. Skipped: ${summary.skipped.length}.`,
  );
  if (check && (summary.updated.length > 0 || summary.changelogged.length > 0)) {
    for (const packageName of summary.updated) {
      console.error(`  update required: ${packageName}`);
    }
    for (const packageName of summary.changelogged) {
      console.error(`  changelog entry required: ${packageName}`);
    }
    console.error("Run `pnpm plugins:sync` and commit the plugin version alignment.");
    process.exit(1);
  }
}
