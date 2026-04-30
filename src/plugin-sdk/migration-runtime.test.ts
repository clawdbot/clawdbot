import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyMigrationFileItem,
  withCachedMigrationConfigRuntime,
  writeMigrationReport,
} from "./migration-runtime.js";
import { createMigrationItem } from "./migration.js";
import type { MigrationProviderContext } from "./plugin-entry.js";

async function writeFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

describe("withCachedMigrationConfigRuntime", () => {
  it("serves later config mutations from the same cached runtime snapshot", async () => {
    type Runtime = NonNullable<MigrationProviderContext["runtime"]>;
    type RuntimeConfig = MigrationProviderContext["config"];
    type MutateConfigFileParams = Parameters<Runtime["config"]["mutateConfigFile"]>[0];
    type ReplaceConfigFileParams = Parameters<Runtime["config"]["replaceConfigFile"]>[0];
    type MutateConfigFileResult = Awaited<ReturnType<Runtime["config"]["mutateConfigFile"]>>;
    type ReplaceConfigFileResult = Awaited<ReturnType<Runtime["config"]["replaceConfigFile"]>>;

    const fallbackConfig = { agents: { defaults: { model: { primary: "openai/base" } } } };
    let runtimeConfig: RuntimeConfig = structuredClone(fallbackConfig);
    const current = vi.fn(() => runtimeConfig);
    const mutateConfigFile = vi.fn(
      async (params: MutateConfigFileParams): Promise<MutateConfigFileResult> => {
        const draft = structuredClone(runtimeConfig);
        const result = await params.mutate(draft, {
          snapshot: {} as never,
          previousHash: null,
        });
        runtimeConfig = structuredClone(draft);
        return {
          path: "/tmp/openclaw.json",
          previousHash: null,
          snapshot: {} as never,
          nextConfig: runtimeConfig,
          afterWrite: { mode: "auto" },
          followUp: { mode: "auto", requiresRestart: false },
          result,
        };
      },
    );
    const replaceConfigFile = vi.fn(
      async (params: ReplaceConfigFileParams): Promise<ReplaceConfigFileResult> => {
        runtimeConfig = structuredClone(params.nextConfig);
        return {
          path: "/tmp/openclaw.json",
          previousHash: null,
          snapshot: {} as never,
          nextConfig: runtimeConfig,
          afterWrite: { mode: "auto" },
          followUp: { mode: "auto", requiresRestart: false },
        };
      },
    );
    const runtime = {
      config: {
        current,
        mutateConfigFile,
        replaceConfigFile,
      },
    } as unknown as Runtime;

    const wrapped = withCachedMigrationConfigRuntime(runtime, fallbackConfig);
    expect(wrapped?.config.current()).toEqual(fallbackConfig);
    runtimeConfig = { agents: { defaults: { model: { primary: "openai/external" } } } };

    await wrapped?.config.mutateConfigFile({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate(draft) {
        draft.agents ??= {};
        draft.agents.defaults ??= {};
        draft.agents.defaults.model = { primary: "openai/mutated" };
      },
    });
    expect(wrapped?.config.current()).toEqual({
      agents: { defaults: { model: { primary: "openai/mutated" } } },
    });

    await wrapped?.config.replaceConfigFile({
      nextConfig: { agents: { defaults: { model: { primary: "openai/replaced" } } } },
      afterWrite: { mode: "auto" },
    });
    expect(wrapped?.config.current()).toEqual({
      agents: { defaults: { model: { primary: "openai/replaced" } } },
    });
    expect(current).toHaveBeenCalledTimes(1);
  });
});

describe("copyMigrationFileItem", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses unique backup paths for same-basename targets in the same millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-migration-runtime-"));
    const reportDir = path.join(root, "report");
    const sourceOne = path.join(root, "source-one", "AGENTS.md");
    const sourceTwo = path.join(root, "source-two", "AGENTS.md");
    const targetOne = path.join(root, "target-one", "AGENTS.md");
    const targetTwo = path.join(root, "target-two", "AGENTS.md");

    await writeFile(sourceOne, "new one");
    await writeFile(sourceTwo, "new two");
    await writeFile(targetOne, "old one");
    await writeFile(targetTwo, "old two");

    const first = await copyMigrationFileItem(
      createMigrationItem({
        id: "first",
        kind: "file",
        action: "copy",
        source: sourceOne,
        target: targetOne,
      }),
      reportDir,
      { overwrite: true },
    );
    const second = await copyMigrationFileItem(
      createMigrationItem({
        id: "second",
        kind: "file",
        action: "copy",
        source: sourceTwo,
        target: targetTwo,
      }),
      reportDir,
      { overwrite: true },
    );

    expect(first.status).toBe("migrated");
    expect(second.status).toBe("migrated");
    const firstBackup = first.details?.backupPath;
    const secondBackup = second.details?.backupPath;
    expect(firstBackup).toEqual(expect.stringContaining("AGENTS.md"));
    expect(secondBackup).toEqual(expect.stringContaining("AGENTS.md"));
    expect(firstBackup).not.toBe(secondBackup);
    await expect(fs.readFile(firstBackup as string, "utf8")).resolves.toBe("old one");
    await expect(fs.readFile(secondBackup as string, "utf8")).resolves.toBe("old two");
  });
});

describe("writeMigrationReport", () => {
  it("redacts nested secret-looking config values in JSON reports", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-migration-report-"));
    const reportDir = path.join(root, "report");

    await writeMigrationReport({
      providerId: "hermes",
      source: path.join(root, "hermes"),
      summary: {
        total: 1,
        planned: 0,
        migrated: 1,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
      items: [
        createMigrationItem({
          id: "config:mcp-servers",
          kind: "config",
          action: "merge",
          status: "migrated",
          details: {
            value: {
              mcp: {
                env: {
                  OPENAI_API_KEY: "short-dev-key",
                  SAFE_FLAG: "visible",
                },
                headers: {
                  Authorization: "Bearer short-dev-key",
                  "x-api-key": "another-short-dev-key",
                },
              },
            },
          },
        }),
      ],
      reportDir,
    });

    const report = await fs.readFile(path.join(reportDir, "report.json"), "utf8");
    expect(report).not.toContain("short-dev-key");
    expect(report).not.toContain("another-short-dev-key");
    expect(JSON.parse(report).items[0].details.value.mcp).toEqual({
      env: {
        OPENAI_API_KEY: "[redacted]",
        SAFE_FLAG: "visible",
      },
      headers: {
        Authorization: "[redacted]",
        "x-api-key": "[redacted]",
      },
    });
  });
});
