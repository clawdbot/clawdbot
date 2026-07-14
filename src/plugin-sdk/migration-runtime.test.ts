/**
 * Tests plugin SDK migration runtime facades and migration helper behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { bindMemoryMigrationPlanSources } from "./memory-migration-source.js";
import {
  copyMemoryMigrationFileItem,
  copyMigrationFileItem,
  withCachedMigrationConfigRuntime,
  writeMigrationReport,
} from "./migration-runtime.js";
import { createMigrationItem } from "./migration.js";
import type { MigrationProviderContext } from "./plugin-entry.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
          persistedHash: "test-persisted-hash",
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
          persistedHash: "test-persisted-hash",
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
    const root = tempDirs.make("openclaw-migration-runtime-");
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

    expect(first.status, first.reason).toBe("migrated");
    expect(second.status, second.reason).toBe("migrated");
    const firstBackup = first.details?.backupPath;
    const secondBackup = second.details?.backupPath;
    if (typeof firstBackup !== "string" || typeof secondBackup !== "string") {
      throw new Error("expected both migration results to include backup paths");
    }
    expect(path.basename(firstBackup)).toBe("AGENTS.md");
    expect(path.basename(secondBackup)).toBe("AGENTS.md");
    expect(firstBackup).not.toBe(secondBackup);
    await expect(fs.readFile(firstBackup, "utf8")).resolves.toBe("old one");
    await expect(fs.readFile(secondBackup, "utf8")).resolves.toBe("old two");
  });
});

describe("copyMemoryMigrationFileItem", () => {
  it("rejects source bytes that changed after the reviewed plan", async () => {
    const root = tempDirs.make("openclaw-memory-copy-");
    const workspaceDir = path.join(root, "workspace");
    const source = path.join(root, "source", "MEMORY.md");
    const target = path.join(workspaceDir, "memory", "imports", "codex", "MEMORY.md");
    await writeFile(source, "reviewed memory");
    const item = createMigrationItem({
      id: "memory:codex:MEMORY.md",
      kind: "memory",
      action: "copy",
      source,
      target,
      details: { sourceSha256: "provider-owned" },
    });
    const bound = await bindMemoryMigrationPlanSources({
      providerId: "codex",
      source: path.dirname(source),
      target: workspaceDir,
      summary: {
        total: 1,
        planned: 1,
        migrated: 0,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
      items: [item],
    });
    expect(bound.items[0]?.details?.sourceSha256).toBe("provider-owned");
    expect(bound.items[0]?.sourceRevision).toMatchObject({ algorithm: "sha256" });
    await writeFile(source, "changed memory");

    const result = await copyMemoryMigrationFileItem(bound.items[0]!, path.join(root, "report"), {
      workspaceDir,
    });

    expect(result.status).toBe("error");
    expect(result.reason).toContain("source changed");
    await expect(fs.access(target)).rejects.toThrow();
  });

  it("does not read source paths for non-actionable memory items", async () => {
    const missingSource = path.join(tempDirs.make("openclaw-memory-copy-"), "missing.md");
    const item = createMigrationItem({
      id: "memory:missing",
      kind: "memory",
      action: "copy",
      status: "skipped",
      source: missingSource,
      reason: "source unavailable",
    });

    const bound = await bindMemoryMigrationPlanSources({
      providerId: "codex",
      source: path.dirname(missingSource),
      summary: {
        total: 1,
        planned: 0,
        migrated: 0,
        skipped: 1,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
      items: [item],
    });

    expect(bound.items).toEqual([item]);
  });

  it("rejects a symlinked destination parent at copy time", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-memory-copy-");
    const workspaceDir = path.join(root, "workspace");
    const outsideDir = path.join(root, "outside");
    const source = path.join(root, "source", "MEMORY.md");
    const target = path.join(workspaceDir, "memory", "imports", "codex", "MEMORY.md");
    await writeFile(source, "source memory");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.symlink(outsideDir, path.join(workspaceDir, "memory"));

    const result = await copyMemoryMigrationFileItem(
      createMigrationItem({
        id: "memory:codex:MEMORY.md",
        kind: "memory",
        action: "copy",
        source,
        target,
      }),
      path.join(root, "report"),
      { workspaceDir, overwrite: true },
    );

    expect(result.status).toBe("error");
    await expect(
      fs.access(path.join(outsideDir, "imports", "codex", "MEMORY.md")),
    ).rejects.toThrow();
  });

  it("backs up and replaces an existing memory file within the workspace root", async () => {
    const root = tempDirs.make("openclaw-memory-copy-");
    const workspaceDir = path.join(root, "workspace");
    const source = path.join(root, "source", "MEMORY.md");
    const target = path.join(workspaceDir, "memory", "imports", "codex", "MEMORY.md");
    await writeFile(source, "new memory");
    await writeFile(target, "old memory");
    if (process.platform !== "win32") {
      await fs.chmod(target, 0o644);
    }

    const result = await copyMemoryMigrationFileItem(
      createMigrationItem({
        id: "memory:codex:MEMORY.md",
        kind: "memory",
        action: "copy",
        source,
        target,
      }),
      path.join(root, "report"),
      { workspaceDir, overwrite: true },
    );

    expect(result.status).toBe("migrated");
    await expect(fs.readFile(target, "utf8")).resolves.toBe("new memory");
    if (process.platform !== "win32") {
      expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    }
    const backupPath = result.details?.backupPath;
    if (typeof backupPath !== "string") {
      throw new Error("expected memory backup path");
    }
    await expect(fs.readFile(backupPath, "utf8")).resolves.toBe("old memory");
    await expect(
      fs.access(path.join(workspaceDir, ".openclaw-memory-import-staging")),
    ).rejects.toThrow();
  });

  it("keeps the existing memory file when its backup cannot be persisted", async () => {
    const root = tempDirs.make("openclaw-memory-copy-");
    const workspaceDir = path.join(root, "workspace");
    const source = path.join(root, "source", "MEMORY.md");
    const target = path.join(workspaceDir, "memory", "imports", "codex", "MEMORY.md");
    await writeFile(source, "new memory");
    await writeFile(target, "old memory");

    const writeFileSpy = vi
      .spyOn(fs, "writeFile")
      .mockRejectedValueOnce(new Error("backup unavailable"));
    const result = await copyMemoryMigrationFileItem(
      createMigrationItem({
        id: "memory:codex:MEMORY.md",
        kind: "memory",
        action: "copy",
        source,
        target,
      }),
      path.join(root, "report"),
      { workspaceDir, overwrite: true },
    );
    writeFileSpy.mockRestore();

    expect(result.status).toBe("error");
    expect(result.reason).toContain("backup unavailable");
    await expect(fs.readFile(target, "utf8")).resolves.toBe("old memory");
  });

  it("does not clobber an existing memory file when replacement is disabled", async () => {
    const root = tempDirs.make("openclaw-memory-copy-");
    const workspaceDir = path.join(root, "workspace");
    const source = path.join(root, "source", "MEMORY.md");
    const target = path.join(workspaceDir, "memory", "imports", "codex", "MEMORY.md");
    await writeFile(source, "new memory");
    await writeFile(target, "concurrent memory");

    const result = await copyMemoryMigrationFileItem(
      createMigrationItem({
        id: "memory:codex:MEMORY.md",
        kind: "memory",
        action: "copy",
        source,
        target,
      }),
      path.join(root, "report"),
      { workspaceDir },
    );

    expect(result.status).toBe("conflict");
    await expect(fs.readFile(target, "utf8")).resolves.toBe("concurrent memory");
  });
});

describe("writeMigrationReport", () => {
  it("redacts nested secret-looking config values in JSON reports", async () => {
    const root = tempDirs.make("openclaw-migration-report-");
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
