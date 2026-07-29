// Memory Wiki tests cover bridge plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearMemoryPluginState,
  type MemoryPluginPublicArtifact,
  registerMemoryCapability,
} from "openclaw/plugin-sdk/memory-host-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { syncMemoryWikiBridgeSources } from "./bridge.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("syncMemoryWikiBridgeSources", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-bridge-suite-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    clearMemoryPluginState();
  });

  function nextCaseRoot(name: string): string {
    return path.join(fixtureRoot, `case-${caseId++}-${name}`);
  }

  async function createBridgeWorkspace(name: string): Promise<string> {
    const workspaceDir = nextCaseRoot(name);
    await fs.mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  function registerBridgeArtifacts(artifacts: MemoryPluginPublicArtifact[]) {
    registerMemoryCapability("memory-core", {
      publicArtifacts: {
        async listArtifacts() {
          return artifacts;
        },
      },
    });
  }

  it("imports public memory artifacts and stays idempotent across reruns", async () => {
    const workspaceDir = await createBridgeWorkspace("workspace");
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexMemoryRoot: true,
          indexDailyNotes: true,
          indexDreamReports: true,
        },
      },
    });

    await fs.mkdir(path.join(workspaceDir, "memory", "dreaming"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Durable Memory\n", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-05.md"),
      "# Daily Note\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "dreaming", "2026-04-05.md"),
      "# Dream Report\n",
      "utf8",
    );
    registerBridgeArtifacts([
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "MEMORY.md",
        absolutePath: path.join(workspaceDir, "MEMORY.md"),
        agentIds: ["main"],
        contentType: "markdown",
      },
      {
        kind: "daily-note",
        workspaceDir,
        relativePath: "memory/2026-04-05.md",
        absolutePath: path.join(workspaceDir, "memory", "2026-04-05.md"),
        agentIds: ["main"],
        contentType: "markdown",
      },
      {
        kind: "dream-report",
        workspaceDir,
        relativePath: "memory/dreaming/2026-04-05.md",
        absolutePath: path.join(workspaceDir, "memory", "dreaming", "2026-04-05.md"),
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);

    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    const first = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(first.workspaces).toBe(1);
    expect(first.artifactCount).toBe(3);
    expect(first.importedCount).toBe(3);
    expect(first.updatedCount).toBe(0);
    expect(first.skippedCount).toBe(0);
    expect(first.removedCount).toBe(0);
    expect(first.pagePaths).toHaveLength(3);

    const sourcePages = await fs.readdir(path.join(vaultDir, "sources"));
    expect(
      sourcePages.reduce((count, name) => count + (name.startsWith("bridge-") ? 1 : 0), 0),
    ).toBe(3);

    const memoryPage = await fs.readFile(path.join(vaultDir, first.pagePaths[0] ?? ""), "utf8");
    expect(memoryPage).toContain("sourceType: memory-bridge");
    expect(memoryPage).toContain("## Bridge Source");

    const second = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(second.importedCount).toBe(0);
    expect(second.updatedCount).toBe(0);
    expect(second.skippedCount).toBe(3);
    expect(second.removedCount).toBe(0);

    const logLines = (await fs.readFile(path.join(vaultDir, ".openclaw-wiki", "log.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(logLines).toHaveLength(3);
  });

  it("skips generated artifacts from its own vault", async () => {
    const workspaceDir = await createBridgeWorkspace("self-import-workspace");
    const vaultDir = path.join(workspaceDir, "memory", "wiki");
    const { config } = await createVault({
      rootDir: vaultDir,
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexDailyNotes: true,
        },
      },
    });

    const dailyNotePath = path.join(workspaceDir, "memory", "2026-06-22.md");
    const generatedSourcePath = path.join(
      vaultDir,
      "sources",
      "bridge-workspace-remote-memory-daily-old.md",
    );
    const generatedIndexPath = path.join(vaultDir, "index.md");
    await fs.mkdir(path.dirname(dailyNotePath), { recursive: true });
    await fs.mkdir(path.dirname(generatedSourcePath), { recursive: true });
    await fs.writeFile(dailyNotePath, "# Daily Note\n", "utf8");
    await fs.writeFile(generatedSourcePath, "# Previously Imported Source\n", "utf8");
    await fs.writeFile(generatedIndexPath, "# Generated Index\n", "utf8");

    registerBridgeArtifacts([
      {
        kind: "daily-note",
        workspaceDir,
        relativePath: "memory/2026-06-22.md",
        absolutePath: dailyNotePath,
        agentIds: ["main"],
        contentType: "markdown",
      },
      {
        kind: "daily-note",
        workspaceDir,
        relativePath: "memory/wiki/sources/bridge-workspace-remote-memory-daily-old.md",
        absolutePath: generatedSourcePath,
        agentIds: ["main"],
        contentType: "markdown",
      },
      {
        kind: "daily-note",
        workspaceDir,
        relativePath: "memory/wiki/index.md",
        absolutePath: generatedIndexPath,
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);

    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    const result = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(result.artifactCount).toBe(1);
    expect(result.importedCount).toBe(1);
    expect(result.pagePaths).toHaveLength(1);
    expect(result.pagePaths[0]).not.toContain("memory-wiki-sources");
    const sourcePages = await fs.readdir(path.join(vaultDir, "sources"));
    expect(sourcePages.filter((name) => name.startsWith("bridge-"))).toHaveLength(2);
    expect(sourcePages.filter((name) => name.includes("memory-wiki-sources-"))).toEqual([]);
  });

  it("imports bridge artifacts from legacy providers without agent ids", async () => {
    const workspaceDir = await createBridgeWorkspace("legacy-agentids-workspace");
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("legacy-agentids-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexMemoryRoot: true,
        },
      },
    });
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(memoryPath, "# Durable Memory\n", "utf8");
    registerBridgeArtifacts([
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "MEMORY.md",
        absolutePath: memoryPath,
        contentType: "markdown",
      } as Omit<MemoryPluginPublicArtifact, "agentIds"> as MemoryPluginPublicArtifact,
    ]);

    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    const result = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(result.importedCount).toBe(1);
    expect(result.artifactCount).toBe(1);
    const page = await fs.readFile(path.join(vaultDir, result.pagePaths[0] ?? ""), "utf8");
    expect(page).toContain("# Memory Bridge: MEMORY");
    expect(page).toContain("- Agents: unknown");
  });

  it("isolates agent-scoped bridge artifacts while preserving shared ownership", async () => {
    const supportWorkspace = await createBridgeWorkspace("support-workspace");
    const marketingWorkspace = await createBridgeWorkspace("marketing-workspace");
    const sharedWorkspace = await createBridgeWorkspace("shared-workspace");
    const unknownWorkspace = await createBridgeWorkspace("unknown-workspace");
    const supportMemory = path.join(supportWorkspace, "MEMORY.md");
    const marketingMemory = path.join(marketingWorkspace, "MEMORY.md");
    const sharedMemory = path.join(sharedWorkspace, "MEMORY.md");
    const unknownMemory = path.join(unknownWorkspace, "MEMORY.md");
    await fs.writeFile(supportMemory, "# Support Sentinel\n", "utf8");
    await fs.writeFile(marketingMemory, "# Marketing Sentinel\n", "utf8");
    await fs.writeFile(sharedMemory, "# Shared Sentinel\n", "utf8");
    await fs.writeFile(unknownMemory, "# Unknown Sentinel\n", "utf8");

    registerBridgeArtifacts([
      {
        kind: "memory-root",
        workspaceDir: supportWorkspace,
        relativePath: "MEMORY.md",
        absolutePath: supportMemory,
        agentIds: [" SUPPORT "],
        contentType: "markdown",
      },
      {
        kind: "memory-root",
        workspaceDir: marketingWorkspace,
        relativePath: "MEMORY.md",
        absolutePath: marketingMemory,
        agentIds: ["marketing"],
        contentType: "markdown",
      },
      {
        kind: "memory-root",
        workspaceDir: sharedWorkspace,
        relativePath: "MEMORY.md",
        absolutePath: sharedMemory,
        agentIds: ["support", "MARKETING"],
        contentType: "markdown",
      },
      {
        kind: "memory-root",
        workspaceDir: unknownWorkspace,
        relativePath: "MEMORY.md",
        absolutePath: unknownMemory,
        contentType: "markdown",
      } as Omit<MemoryPluginPublicArtifact, "agentIds"> as MemoryPluginPublicArtifact,
    ]);

    const { rootDir: supportVault, config: unresolvedSupportConfig } = await createVault({
      rootDir: nextCaseRoot("support-vault"),
      config: {
        vaultMode: "bridge",
        vault: { scope: "agent" },
        bridge: { enabled: true, indexMemoryRoot: true },
      },
    });
    const { rootDir: marketingVault, config: unresolvedMarketingConfig } = await createVault({
      rootDir: nextCaseRoot("marketing-vault"),
      config: {
        vaultMode: "bridge",
        vault: { scope: "agent" },
        bridge: { enabled: true, indexMemoryRoot: true },
      },
    });
    const supportConfig = { ...unresolvedSupportConfig, agentId: "support" };
    const marketingConfig = { ...unresolvedMarketingConfig, agentId: "marketing" };
    const appConfig: OpenClawConfig = {
      agents: {
        list: [
          { id: "support", default: true, workspace: supportWorkspace },
          { id: "marketing", workspace: marketingWorkspace },
        ],
      },
    };

    const supportResult = await syncMemoryWikiBridgeSources({ config: supportConfig, appConfig });
    const marketingResult = await syncMemoryWikiBridgeSources({
      config: marketingConfig,
      appConfig,
    });

    expect(supportResult).toMatchObject({ artifactCount: 2, importedCount: 2, workspaces: 2 });
    expect(marketingResult).toMatchObject({ artifactCount: 2, importedCount: 2, workspaces: 2 });
    const supportPages = await Promise.all(
      supportResult.pagePaths.map((pagePath) =>
        fs.readFile(path.join(supportVault, pagePath), "utf8"),
      ),
    );
    const marketingPages = await Promise.all(
      marketingResult.pagePaths.map((pagePath) =>
        fs.readFile(path.join(marketingVault, pagePath), "utf8"),
      ),
    );
    expect(supportPages.join("\n")).toContain("Support Sentinel");
    expect(supportPages.join("\n")).toContain("Shared Sentinel");
    expect(supportPages.join("\n")).not.toContain("Marketing Sentinel");
    expect(supportPages.join("\n")).not.toContain("Unknown Sentinel");
    expect(marketingPages.join("\n")).toContain("Marketing Sentinel");
    expect(marketingPages.join("\n")).toContain("Shared Sentinel");
    expect(marketingPages.join("\n")).not.toContain("Support Sentinel");
    expect(marketingPages.join("\n")).not.toContain("Unknown Sentinel");
  });

  it("rejects an unresolved agent-scoped bridge config", async () => {
    const { config } = await createVault({
      rootDir: nextCaseRoot("unresolved-agent-vault"),
      config: { vault: { scope: "agent" } },
    });

    await expect(syncMemoryWikiBridgeSources({ config })).rejects.toThrow(
      "Memory Wiki agent-scoped vault requires a resolved agent id",
    );
  });

  it("returns a no-op result outside bridge mode", async () => {
    const { config } = await createVault({ rootDir: nextCaseRoot("isolated") });

    const result = await syncMemoryWikiBridgeSources({ config });

    expect(result.importedCount).toBe(0);
    expect(result.updatedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.removedCount).toBe(0);
    expect(result.artifactCount).toBe(0);
    expect(result.workspaces).toBe(0);
    expect(result.pagePaths).toEqual([]);
  });

  it("returns a no-op result when bridge mode is enabled without exported memory artifacts", async () => {
    const workspaceDir = await createBridgeWorkspace("no-memory-core");
    const { config } = await createVault({
      rootDir: nextCaseRoot("no-memory-core-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexMemoryRoot: true,
        },
      },
    });

    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Durable Memory\n", "utf8");

    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    const result = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(result.importedCount).toBe(0);
    expect(result.updatedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.removedCount).toBe(0);
    expect(result.artifactCount).toBe(0);
    expect(result.workspaces).toBe(0);
    expect(result.pagePaths).toEqual([]);
  });

  it("imports the public memory event journal when followMemoryEvents is enabled", async () => {
    const workspaceDir = await createBridgeWorkspace("events-workspace");
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("events-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          followMemoryEvents: true,
        },
      },
    });

    const eventContent = `${JSON.stringify({
      type: "memory.recall.recorded",
      timestamp: "2026-04-05T12:00:00.000Z",
      query: "bridge events",
      resultCount: 1,
      results: [
        {
          path: "memory/2026-04-05.md",
          startLine: 1,
          endLine: 2,
          score: 0.8,
        },
      ],
    })}\n`;
    const eventPath = path.join(workspaceDir, "memory", "events", "memory-host-events.jsonl");
    await fs.mkdir(path.dirname(eventPath), { recursive: true });
    await fs.writeFile(eventPath, eventContent, "utf8");
    registerBridgeArtifacts([
      {
        kind: "event-log",
        workspaceDir,
        relativePath: "memory/events/memory-host-events.jsonl",
        absolutePath: eventPath,
        agentIds: ["main"],
        contentType: "json",
      },
    ]);

    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    const result = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(result.artifactCount).toBe(1);
    expect(result.importedCount).toBe(1);
    expect(result.removedCount).toBe(0);
    const page = await fs.readFile(path.join(vaultDir, result.pagePaths[0] ?? ""), "utf8");
    expect(page).toContain("sourceType: memory-bridge-events");
    expect(page).toContain('"type":"memory.recall.recorded"');
  });

  it("prunes stale bridge pages when the source artifact disappears", async () => {
    const workspaceDir = await createBridgeWorkspace("prune-workspace");
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("prune-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          indexMemoryRoot: true,
          indexDailyNotes: false,
          indexDreamReports: false,
          followMemoryEvents: false,
        },
      },
    });

    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Durable Memory\n", "utf8");
    registerBridgeArtifacts([
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "MEMORY.md",
        absolutePath: path.join(workspaceDir, "MEMORY.md"),
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);
    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    const first = await syncMemoryWikiBridgeSources({ config, appConfig });
    const firstPagePath = first.pagePaths[0] ?? "";
    await expect(fs.readFile(path.join(vaultDir, firstPagePath), "utf8")).resolves.toContain(
      "# Durable Memory",
    );

    await fs.rm(path.join(workspaceDir, "MEMORY.md"));
    registerBridgeArtifacts([]);
    const second = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(second.artifactCount).toBe(0);
    expect(second.removedCount).toBe(1);
    await expect(fs.stat(path.join(vaultDir, firstPagePath))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });

  it("refuses to overwrite bridge source pages through vault symlinks", async () => {
    const workspaceDir = await createBridgeWorkspace("symlink-workspace");
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("symlink-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexMemoryRoot: true,
        },
      },
    });
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(memoryPath, "# Durable Memory\n", "utf8");
    registerBridgeArtifacts([
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "MEMORY.md",
        absolutePath: memoryPath,
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);
    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };
    const first = await syncMemoryWikiBridgeSources({ config, appConfig });
    const pagePath = first.pagePaths[0] ?? "";
    const pageAbsPath = path.join(vaultDir, pagePath);
    const externalTarget = path.join(workspaceDir, "outside.md");
    await fs.writeFile(externalTarget, "external target\n", "utf8");
    await fs.rm(pageAbsPath);
    await fs.symlink(externalTarget, pageAbsPath);
    await fs.writeFile(memoryPath, "# Updated Durable Memory\n", "utf8");

    await expect(syncMemoryWikiBridgeSources({ config, appConfig })).rejects.toThrow(
      "Refusing to write imported source page through symlink",
    );
    await expect(fs.readFile(externalTarget, "utf8")).resolves.toBe("external target\n");
  });

  async function createDirectoryCollisionFixture(params: {
    workspaceName: string;
    vaultName: string;
    populateDirectory?: boolean;
  }) {
    const workspaceDir = await createBridgeWorkspace(params.workspaceName);
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot(params.vaultName),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexMemoryRoot: true,
        },
      },
    });
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(memoryPath, "# Durable Memory\n", "utf8");
    registerBridgeArtifacts([
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "MEMORY.md",
        absolutePath: memoryPath,
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);
    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };
    const first = await syncMemoryWikiBridgeSources({ config, appConfig });
    const pagePath = first.pagePaths[0] ?? "";
    const pageAbsPath = path.join(vaultDir, pagePath);
    await fs.rm(pageAbsPath);
    await fs.mkdir(pageAbsPath);
    if (params.populateDirectory) {
      await fs.writeFile(path.join(pageAbsPath, "child.md"), "blocking child\n", "utf8");
    }
    await fs.writeFile(memoryPath, "# Updated Durable Memory\n", "utf8");
    return { appConfig, config, pageAbsPath };
  }

  it("reports non-symlink bridge source write safety failures without symlink wording", async () => {
    const { appConfig, config } = await createDirectoryCollisionFixture({
      workspaceName: "not-file-workspace",
      vaultName: "not-file-vault",
      populateDirectory: true,
    });

    const second = syncMemoryWikiBridgeSources({ config, appConfig });
    await expect(second).rejects.toThrow(
      /Refusing to write imported source page \((not-empty|not-file|path-mismatch)\): sources\//u,
    );
    await expect(second).rejects.not.toThrow("through symlink");
  });

  it("does not remove empty directory bridge source collisions as hardlinks", async () => {
    const { appConfig, config, pageAbsPath } = await createDirectoryCollisionFixture({
      workspaceName: "empty-directory-workspace",
      vaultName: "empty-directory-vault",
    });

    const second = syncMemoryWikiBridgeSources({ config, appConfig });
    await expect(second).rejects.toThrow(
      /Refusing to write imported source page \((not-file|path-mismatch)\): sources\//u,
    );
    await expect(second).rejects.not.toThrow("through symlink");
    await expect(fs.stat(pageAbsPath)).resolves.toSatisfy((stat) => stat.isDirectory());
  });

  it("replaces bridge source page hardlinks without clobbering their target", async () => {
    const workspaceDir = await createBridgeWorkspace("hardlink-workspace");
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("hardlink-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexMemoryRoot: true,
        },
      },
    });
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(memoryPath, "# Durable Memory\n", "utf8");
    registerBridgeArtifacts([
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "MEMORY.md",
        absolutePath: memoryPath,
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);
    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };
    const first = await syncMemoryWikiBridgeSources({ config, appConfig });
    const pagePath = first.pagePaths[0] ?? "";
    const pageAbsPath = path.join(vaultDir, pagePath);
    const externalTarget = path.join(workspaceDir, "outside-hardlink.md");
    await fs.writeFile(externalTarget, "external target\n", "utf8");
    await fs.rm(pageAbsPath);
    await fs.link(externalTarget, pageAbsPath);
    await fs.writeFile(memoryPath, "# Updated Durable Memory\n", "utf8");

    const second = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(second.updatedCount).toBe(1);
    await expect(fs.readFile(externalTarget, "utf8")).resolves.toBe("external target\n");
    await expect(fs.readFile(pageAbsPath, "utf8")).resolves.toContain("# Updated Durable Memory");
  });

  it("caps composed bridge source filenames to the filesystem component limit", async () => {
    const workspaceDir = await createBridgeWorkspace(`${"漢".repeat(50)}-workspace`);
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("long-bridge-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexDailyNotes: true,
        },
      },
    });

    const relativePath = `${"語".repeat(50)}/${"録".repeat(50)}.md`;
    const absolutePath = path.join(workspaceDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, "# Deep Unicode Note\n", "utf8");
    registerBridgeArtifacts([
      {
        kind: "daily-note",
        workspaceDir,
        relativePath,
        absolutePath,
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);

    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    const result = await syncMemoryWikiBridgeSources({ config, appConfig });
    const pagePath = result.pagePaths[0] ?? "";

    expect(result.importedCount).toBe(1);
    expect(Buffer.byteLength(path.basename(pagePath))).toBeLessThanOrEqual(255);
    await expect(fs.readFile(path.join(vaultDir, pagePath), "utf8")).resolves.toContain(
      "# Deep Unicode Note",
    );
  });
});
