import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  PluginPackageJson,
  PublishablePluginPackageCandidate,
} from "./plugin-publication-collector.ts";

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
