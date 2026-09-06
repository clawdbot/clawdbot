import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  PluginPackageJson,
  PublishablePluginPackageCandidate,
} from "./plugin-publication-collector.ts";

// Any change here can alter the package inventory for both registries. Range
// selectors and workflow triggers must keep this closure in sync.
export const PLUGIN_PUBLICATION_SHARED_AUTHORITY_PATHS = [
  "package.json",
  "pnpm-lock.yaml",
  "packages/normalization-core/src",
  "packages/plugin-package-contract/src",
  "scripts/lib/npm-publish-plan.mjs",
  "scripts/lib/plugin-publication-candidates.ts",
  "scripts/lib/plugin-publication-collector.ts",
  "scripts/lib/release-version.mjs",
] as const;

export const PLUGIN_NPM_RELEASE_AUTHORITY_PATHS = [
  ...PLUGIN_PUBLICATION_SHARED_AUTHORITY_PATHS,
  ".github/actions/setup-node-env",
  ".github/workflows/plugin-npm-release.yml",
  "scripts/generate-npm-package-lock.mjs",
  "scripts/generate-npm-package-lock.mts",
  "scripts/lib/actions-artifact-archive.mjs",
  "scripts/lib/local-check-runtime.mts",
  "scripts/lib/npm-json-output.mts",
  "scripts/lib/plugin-npm-package-manifest.mjs",
  "scripts/lib/plugin-npm-package-manifest.mts",
  "scripts/lib/plugin-npm-release.ts",
  "scripts/lib/tsx-cli-shim.mjs",
  "scripts/tsx.mjs",
  "scripts/plugin-npm-publish.sh",
  "scripts/plugin-npm-release-check.ts",
  "scripts/plugin-npm-release-plan.ts",
  "scripts/plugin-publication-artifact.mjs",
  "scripts/release-tooling-identity.d.mts",
  "scripts/release-tooling-identity.mjs",
  "scripts/verify-plugin-npm-published-runtime.mts",
  "src/plugins/package-entrypoints.ts",
  "src/utils/run-with-concurrency.ts",
] as const;

function hasAuthorityPathChanges(
  paths: readonly string[],
  authorityPaths: readonly string[],
): boolean {
  return paths.some((path) =>
    authorityPaths.some(
      (authorityPath) => path === authorityPath || path.startsWith(`${authorityPath}/`),
    ),
  );
}

export function hasPluginPublicationSharedAuthorityChanges(paths: readonly string[]): boolean {
  return hasAuthorityPathChanges(paths, PLUGIN_PUBLICATION_SHARED_AUTHORITY_PATHS);
}

export function hasPluginNpmReleaseAuthorityChanges(paths: readonly string[]): boolean {
  return hasAuthorityPathChanges(paths, PLUGIN_NPM_RELEASE_AUTHORITY_PATHS);
}

function readPluginPackageJson(absolutePath: string, repoPath: string): PluginPackageJson {
  let raw: string;
  try {
    raw = readFileSync(absolutePath, "utf8");
  } catch (error) {
    throw new Error(`plugin candidate manifest is unreadable: ${repoPath}`, { cause: error });
  }
  try {
    return JSON.parse(raw) as PluginPackageJson;
  } catch (error) {
    throw new Error(`plugin candidate manifest is malformed JSON: ${repoPath}`, { cause: error });
  }
}

function pluginPackageJsonExists(absolutePath: string, repoPath: string): boolean {
  try {
    statSync(absolutePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw new Error(`plugin candidate manifest is unreadable: ${repoPath}`, { cause: error });
  }
}

function readOptionalPluginReadme(absolutePath: string, repoPath: string): string | undefined {
  try {
    return readFileSync(absolutePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(`plugin candidate README is unreadable: ${repoPath}`, { cause: error });
  }
}

export function collectExtensionPackageJsonCandidates<
  TPackageJson extends PluginPackageJson = PluginPackageJson,
>(rootDir = resolve(".")): PublishablePluginPackageCandidate<TPackageJson>[] {
  const extensionsDir = join(rootDir, "extensions");
  return readdirSync(extensionsDir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) {
      return [];
    }
    const packageDir = `extensions/${entry.name}`;
    const absolutePackageDir = join(extensionsDir, entry.name);
    const packageJsonPath = join(absolutePackageDir, "package.json");
    if (!pluginPackageJsonExists(packageJsonPath, `${packageDir}/package.json`)) {
      return [];
    }
    return [
      {
        extensionId: entry.name,
        packageDir,
        packageJson: readPluginPackageJson(
          packageJsonPath,
          `${packageDir}/package.json`,
        ) as TPackageJson,
        readmeText: readOptionalPluginReadme(
          join(absolutePackageDir, "README.md"),
          `${packageDir}/README.md`,
        ),
      },
    ];
  });
}
