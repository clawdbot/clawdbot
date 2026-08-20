// Stateful Vitest project inventory helpers run in the isolated unit-fast lane.
import { globSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fullSuiteVitestShards } from "./vitest/vitest.test-shards.mjs";

type VitestTestConfig = {
  dir?: string;
  exclude?: string[];
  include?: string[];
};

type VitestConfig = {
  test?: VitestTestConfig;
};

type VitestConfigFactory = (env?: Record<string, string | undefined>) => VitestConfig;

function toRepoPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function findVitestConfigFactory(mod: Record<string, unknown>): VitestConfigFactory | null {
  for (const [name, value] of Object.entries(mod)) {
    if (name !== "default" && /^create.*VitestConfig$/u.test(name) && typeof value === "function") {
      return value as VitestConfigFactory;
    }
  }
  return null;
}

async function loadRawVitestConfig(configPath: string): Promise<VitestConfig> {
  const previousArgv = process.argv;
  const previousIncludeFile = process.env.OPENCLAW_VITEST_INCLUDE_FILE;
  process.argv = [previousArgv[0] ?? "node", previousArgv[1] ?? "vitest"];
  delete process.env.OPENCLAW_VITEST_INCLUDE_FILE;
  try {
    const configUrl = pathToFileURL(path.resolve(process.cwd(), configPath));
    // Focused runs may have cached a CLI-narrowed default config before the audit clears argv.
    configUrl.searchParams.set("openclaw-vitest-ownership-audit", "1");
    const mod = (await import(configUrl.href)) as Record<string, unknown>;
    return findVitestConfigFactory(mod)?.(process.env) ?? ((mod.default ?? {}) as VitestConfig);
  } finally {
    process.argv = previousArgv;
    if (previousIncludeFile === undefined) {
      delete process.env.OPENCLAW_VITEST_INCLUDE_FILE;
    } else {
      process.env.OPENCLAW_VITEST_INCLUDE_FILE = previousIncludeFile;
    }
  }
}

async function listFullSuiteTestFileMatches(): Promise<Map<string, string[]>> {
  const matches = new Map<string, string[]>();
  const configPaths = [...new Set(fullSuiteVitestShards.flatMap((shard) => shard.projects))];
  for (const configPath of configPaths) {
    const testConfig = (await loadRawVitestConfig(configPath)).test ?? {};
    const dir = testConfig.dir ? path.resolve(process.cwd(), testConfig.dir) : process.cwd();
    const exclude = (testConfig.exclude ?? []).map((pattern) =>
      path.isAbsolute(pattern) ? toRepoPath(path.relative(dir, pattern)) : toRepoPath(pattern),
    );
    for (const file of globSync(testConfig.include ?? [], { cwd: dir, exclude })) {
      const repoPath = toRepoPath(path.relative(process.cwd(), path.resolve(dir, file)));
      matches.set(repoPath, [...(matches.get(repoPath) ?? []), configPath]);
    }
  }
  return matches;
}

function listNormalFullSuiteTestFiles(): string[] {
  const e2eNamedIntegrationTests = new Set([
    "src/gateway/gateway.test.ts",
    "src/gateway/server.startup-matrix-migration.integration.test.ts",
    "src/gateway/sessions-history-http.test.ts",
  ]);
  return globSync(["**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], {
    cwd: process.cwd(),
    exclude: ["**/.*/**", "**/dist/**", "**/node_modules/**", "**/vendor/**"],
  })
    .map(toRepoPath)
    .filter(
      (file) =>
        !file.includes(".live.test.") &&
        !file.includes(".e2e.test.") &&
        !file.startsWith("test/fixtures/") &&
        !e2eNamedIntegrationTests.has(file),
    )
    .toSorted((left, right) => left.localeCompare(right));
}

export async function auditFullSuiteTestFileOwnership(): Promise<{
  duplicated: string[];
  missing: string[];
}> {
  const [matches, files] = await Promise.all([
    listFullSuiteTestFileMatches(),
    Promise.resolve(listNormalFullSuiteTestFiles()),
  ]);
  return {
    missing: files.filter((file) => !matches.has(file)),
    duplicated: [...matches.entries()]
      .filter(([, configs]) => configs.length > 1)
      .map(([file, configs]) => `${file}: ${configs.join(", ")}`)
      .toSorted((left, right) => left.localeCompare(right)),
  };
}
