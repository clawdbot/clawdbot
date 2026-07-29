// Memory Core tests cover public artifacts plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendMemoryHostEvent } from "openclaw/plugin-sdk/memory-host-events";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { listMemoryCorePublicArtifacts } from "./public-artifacts.js";

describe("listMemoryCorePublicArtifacts", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-public-artifacts-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("lists public workspace artifacts with stable kinds", async () => {
    const workspaceDir = path.join(fixtureRoot, "workspace-stable-kinds");
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtureRoot);
    await fs.mkdir(path.join(workspaceDir, "memory", "dreaming"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Durable Memory\n", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-06.md"),
      "# Daily Note\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "dreaming", "2026-04-06.md"),
      "# Dream Report\n",
      "utf8",
    );
    const eventStoredAt = Date.parse("2026-04-07T09:30:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(eventStoredAt);
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.recall.recorded",
      timestamp: "2026-04-06T12:00:00.000Z",
      query: "alpha",
      resultCount: 0,
      results: [],
    });

    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    const artifacts = await listMemoryCorePublicArtifacts({ cfg });
    const eventArtifact = artifacts.find((artifact) => artifact.kind === "event-log");
    if (!eventArtifact) {
      throw new Error("expected memory event export");
    }
    expect(artifacts.filter((artifact) => artifact.kind !== "event-log")).toEqual([
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
        relativePath: "memory/2026-04-06.md",
        absolutePath: path.join(workspaceDir, "memory", "2026-04-06.md"),
        agentIds: ["main"],
        contentType: "markdown",
      },
      {
        kind: "dream-report",
        workspaceDir,
        relativePath: "memory/dreaming/2026-04-06.md",
        absolutePath: path.join(workspaceDir, "memory", "dreaming", "2026-04-06.md"),
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);
    expect(eventArtifact.relativePath).toMatch(
      /^memory\/events\/[a-f0-9]{32}\/memory-host-events\.jsonl$/u,
    );
    await expect(fs.readFile(eventArtifact.absolutePath, "utf8")).resolves.toBe(
      `${JSON.stringify({
        type: "memory.recall.recorded",
        timestamp: "2026-04-06T12:00:00.000Z",
        query: "alpha",
        resultCount: 0,
        results: [],
      })}\n`,
    );
  });

  it("ignores lowercase memory root when only the legacy filename exists", async () => {
    const workspaceDir = path.join(fixtureRoot, "workspace-lowercase-root");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "memory.md"), "# Legacy Durable Memory\n", "utf8");

    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    await expect(listMemoryCorePublicArtifacts({ cfg })).resolves.toStrictEqual([]);
  });
});
