import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendMemoryHostEvent,
  resolveMemoryHostEventLogPath,
} from "openclaw/plugin-sdk/memory-core-host-events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  it("lists public workspace artifacts with stable kinds", async () => {
    const workspaceDir = path.join(fixtureRoot, "workspace-stable-kinds");
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

    await expect(listMemoryCorePublicArtifacts({ cfg })).resolves.toEqual([
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
      {
        kind: "event-log",
        workspaceDir,
        relativePath: "memory/.dreams/events.jsonl",
        absolutePath: resolveMemoryHostEventLogPath(workspaceDir),
        agentIds: ["main"],
        contentType: "json",
      },
    ]);
  });

  it("lists lowercase memory root when only the legacy filename exists", async () => {
    const workspaceDir = path.join(fixtureRoot, "workspace-lowercase-root");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "memory.md"), "# Legacy Durable Memory\n", "utf8");

    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    await expect(listMemoryCorePublicArtifacts({ cfg })).resolves.toEqual([
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "memory.md",
        absolutePath: path.join(workspaceDir, "memory.md"),
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);
  });
});
