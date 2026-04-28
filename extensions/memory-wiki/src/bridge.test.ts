import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearMemoryPluginState,
  type MemoryPluginPublicArtifact,
  registerMemoryCapability,
} from "openclaw/plugin-sdk/memory-host-core";
import {
  appendMemoryHostEvent,
  resolveMemoryHostEventLogPath,
} from "openclaw/plugin-sdk/memory-host-events";
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
    expect(sourcePages.filter((name) => name.startsWith("bridge-"))).toHaveLength(3);

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
    expect(logLines).toHaveLength(2);
  });

  it("returns a no-op result outside bridge mode", async () => {
    const { config } = await createVault({ rootDir: nextCaseRoot("isolated") });

    const result = await syncMemoryWikiBridgeSources({ config });

    expect(result).toMatchObject({
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      removedCount: 0,
      artifactCount: 0,
      workspaces: 0,
      pagePaths: [],
    });
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

    expect(result).toMatchObject({
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      removedCount: 0,
      artifactCount: 0,
      workspaces: 0,
      pagePaths: [],
    });
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

    await appendMemoryHostEvent(workspaceDir, {
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
    });
    registerBridgeArtifacts([
      {
        kind: "event-log",
        workspaceDir,
        relativePath: "memory/.dreams/events.jsonl",
        absolutePath: resolveMemoryHostEventLogPath(workspaceDir),
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
    await expect(fs.stat(path.join(vaultDir, firstPagePath))).resolves.toBeTruthy();

    await fs.rm(path.join(workspaceDir, "MEMORY.md"));
    registerBridgeArtifacts([]);
    const second = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(second.artifactCount).toBe(0);
    expect(second.removedCount).toBe(1);
    await expect(fs.stat(path.join(vaultDir, firstPagePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
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
    await expect(fs.stat(path.join(vaultDir, pagePath))).resolves.toBeTruthy();
  });
});
