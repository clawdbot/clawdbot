import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../test-utils/repo-files.js";

type PluginManifestShape = {
  id?: unknown;
};

type OpenClawPackageShape = {
  name?: unknown;
  openclaw?: {
    install?: {
      npmSpec?: unknown;
    };
    channel?: {
      id?: unknown;
    };
  };
};

type BundledPluginRecord = {
  dirName: string;
  packageName: string;
  manifestId: string;
  installNpmSpec?: string;
  channelId?: string;
};

const EXTENSIONS_ROOT = path.resolve(process.cwd(), "extensions");
const DIR_ID_EXCEPTIONS = new Map<string, string>([
  // Historical directory name kept until a wider repo cleanup is worth the churn.
  ["kimi-coding", "kimi"],
]);
const NON_PACKAGED_BUNDLED_PLUGIN_DIRS = new Set(["qa-channel", "qa-lab", "qa-matrix"]);
const ALLOWED_PACKAGE_SUFFIXES = [
  "",
  "-provider",
  "-plugin",
  "-speech",
  "-sandbox",
  "-media-understanding",
] as const;

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets assertions ascribe JSON file shape.
function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function listBundledPluginDirs(): string[] {
  const externalDirs = listExternalBundledPluginDirs();
  if (externalDirs) {
    return externalDirs;
  }
  return fs.readdirSync(EXTENSIONS_ROOT).toSorted();
}

function listExternalBundledPluginDirs(): string[] | null {
  const files = listGitPluginMetadataFiles() ?? listFindPluginMetadataFiles();
  if (!files) {
    return null;
  }

  const metadataByDir = new Map<string, Set<string>>();
  for (const file of files) {
    const match = /^extensions\/([^/]+)\/(openclaw\.plugin\.json|package\.json)$/u.exec(file);
    if (!match) {
      continue;
    }
    const [, dirName, fileName] = match;
    const metadataFiles = metadataByDir.get(dirName) ?? new Set<string>();
    metadataFiles.add(fileName);
    metadataByDir.set(dirName, metadataFiles);
  }

  return [...metadataByDir.entries()]
    .filter(
      ([, metadataFiles]) =>
        metadataFiles.has("package.json") && metadataFiles.has("openclaw.plugin.json"),
    )
    .map(([dirName]) => dirName)
    .toSorted();
}

function listGitPluginMetadataFiles(): string[] | null {
  return listGitTrackedFiles({
    pathspecs: ["extensions/*/package.json", "extensions/*/openclaw.plugin.json"],
  });
}

function listFindPluginMetadataFiles(): string[] | null {
  const result = spawnSync(
    "find",
    [
      EXTENSIONS_ROOT,
      "-maxdepth",
      "2",
      "-type",
      "f",
      "(",
      "-name",
      "package.json",
      "-o",
      "-name",
      "openclaw.plugin.json",
      ")",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((file) => toRepoRelativePath(process.cwd(), file))
    .toSorted();
}

function readBundledPluginRecords(): BundledPluginRecord[] {
  return listBundledPluginDirs().flatMap((dirName) => {
    const rootDir = path.join(EXTENSIONS_ROOT, dirName);
    const packagePath = path.join(rootDir, "package.json");
    const manifestPath = path.join(rootDir, "openclaw.plugin.json");
    if (!fs.existsSync(packagePath) || !fs.existsSync(manifestPath)) {
      return [];
    }

    const manifest = readJsonFile<PluginManifestShape>(manifestPath);
    const pkg = readJsonFile<OpenClawPackageShape>(packagePath);
    const manifestId = normalizeText(manifest.id);
    const packageName = normalizeText(pkg.name);
    if (!manifestId || !packageName) {
      return [];
    }

    return [
      {
        dirName,
        packageName,
        manifestId,
        installNpmSpec: normalizeText(pkg.openclaw?.install?.npmSpec),
        channelId: normalizeText(pkg.openclaw?.channel?.id),
      },
    ];
  });
}

function resolveAllowedPackageNamesForId(pluginId: string): string[] {
  return ALLOWED_PACKAGE_SUFFIXES.map((suffix) => `@openclaw/${pluginId}${suffix}`);
}

function resolveBundledPluginMismatches(
  collectMismatches: (records: BundledPluginRecord[]) => string[],
) {
  return collectMismatches(readBundledPluginRecords());
}

function expectNoBundledPluginNamingMismatches(params: {
  message: string;
  collectMismatches: (records: BundledPluginRecord[]) => string[];
}) {
  const mismatches = resolveBundledPluginMismatches(params.collectMismatches);
  expect(
    mismatches,
    `${params.message}\nFound: ${mismatches.join(", ") || "<none>"}`,
  ).toStrictEqual([]);
}

describe("bundled plugin naming guardrails", () => {
  it("lists bundled plugin metadata without scanning extension directories in-process", () => {
    expectNoReaddirSyncDuring(() => {
      const records = readBundledPluginRecords();

      expect(records.length).toBeGreaterThan(0);
      expect(records.every((record) => record.dirName.length > 0)).toBe(true);
    });
  });

  it.each([
    {
      name: "keeps bundled workspace package names anchored to the plugin id",
      message: `Bundled extension package names must stay anchored to the manifest id via @openclaw/<id> or an approved suffix (${ALLOWED_PACKAGE_SUFFIXES.join(", ")}). Update the plugin naming docs and this invariant before adding a new naming form.`,
      collectMismatches: (records: BundledPluginRecord[]) =>
        records
          .filter(
            ({ packageName, manifestId }) =>
              !resolveAllowedPackageNamesForId(manifestId).includes(packageName),
          )
          .map(
            ({ dirName, packageName, manifestId }) =>
              `${dirName}: ${packageName} (id=${manifestId})`,
          ),
    },
    {
      name: "keeps bundled workspace directories aligned with the plugin id unless explicitly allowlisted",
      message:
        "Bundled extension directory names should match openclaw.plugin.json:id. If a legacy exception is unavoidable, add it to DIR_ID_EXCEPTIONS with a comment.",
      collectMismatches: (records: BundledPluginRecord[]) =>
        records
          .filter(
            ({ dirName, manifestId }) => (DIR_ID_EXCEPTIONS.get(dirName) ?? dirName) !== manifestId,
          )
          .map(({ dirName, manifestId }) => `${dirName} -> ${manifestId}`),
    },
    {
      name: "keeps bundled openclaw.install.npmSpec aligned with the package name",
      message:
        "Bundled openclaw.install.npmSpec values must match the package name so install/update paths stay deterministic.",
      collectMismatches: (records: BundledPluginRecord[]) =>
        records
          .filter(
            ({ installNpmSpec, packageName }) =>
              typeof installNpmSpec === "string" && installNpmSpec !== packageName,
          )
          .map(
            ({ dirName, packageName, installNpmSpec }) =>
              `${dirName}: package=${packageName}, npmSpec=${installNpmSpec}`,
          ),
    },
    {
      name: "keeps non-packaged bundled plugins from advertising npm installs",
      message:
        "Non-packaged bundled plugins are source-only/private and must not advertise openclaw.install.npmSpec.",
      collectMismatches: (records: BundledPluginRecord[]) =>
        records
          .filter(
            ({ dirName, installNpmSpec }) =>
              NON_PACKAGED_BUNDLED_PLUGIN_DIRS.has(dirName) && typeof installNpmSpec === "string",
          )
          .map(({ dirName, installNpmSpec }) => `${dirName}: npmSpec=${installNpmSpec}`),
    },
    {
      name: "keeps bundled channel ids aligned with the canonical plugin id",
      message:
        "Bundled openclaw.channel.id values must match openclaw.plugin.json:id for the owning plugin.",
      collectMismatches: (records: BundledPluginRecord[]) =>
        records
          .filter(
            ({ channelId, manifestId }) =>
              typeof channelId === "string" && channelId !== manifestId,
          )
          .map(
            ({ dirName, manifestId, channelId }) =>
              `${dirName}: channel=${channelId}, id=${manifestId}`,
          ),
    },
  ] as const)("$name", ({ message, collectMismatches }) => {
    expectNoBundledPluginNamingMismatches({
      message,
      collectMismatches,
    });
  });
});
