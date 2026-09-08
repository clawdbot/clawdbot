import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRuntimeConfig,
  checkRuntimeConfig,
  checkSource,
  installWorkspace,
  rollbackRuntimeConfig,
  rollbackWorkspace,
  verifyInstalledWorkspace,
} from "../../scripts/program-manager-workspace.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = process.cwd();
const sourceRoot = path.join(repoRoot, "control", "program-manager");
const temporaryRoots = useAutoCleanupTempDirTracker(afterEach);
type TestAgentEntry = {
  id?: string;
  name?: string;
  role?: string;
  workspace?: string;
  params?: {
    cacheRetention?: string;
    chat_template_kwargs?: { enable_thinking?: boolean; preserve_thinking?: boolean };
    maxTokens?: number;
    text_verbosity?: string;
  };
  tools?: { alsoAllow?: string[]; deny?: string[] };
  subagents?: { allowAgents?: string[]; delegationMode?: string; requireAgentId?: boolean };
};

describe("Program Manager context package", () => {
  it("passes the compact source contract and budget", async () => {
    const result = await checkSource(sourceRoot);
    expect(result.ok).toBe(true);
    expect(result.metrics.totalBootstrapBytes).toBeLessThanOrEqual(10_000);
    expect(result.metrics.largestBootstrapBytes).toBeLessThanOrEqual(4_000);
  });

  it("keeps the initial state explicitly unknown", async () => {
    const state = JSON.parse(
      await readFile(path.join(sourceRoot, "state/program-manager.json"), "utf8"),
    );
    expect(state.status).toBe("Unknown");
    expect(state.evidenceStatus).toBe("Unknown");
    expect(state.source.verifiedAt).toBeNull();
    expect(state.lastKnownGood).toBeNull();
  });

  it("validates the reviewed runtime entry", async () => {
    const result = await checkRuntimeConfig(path.join(sourceRoot, "runtime-config.json"));
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("keeps runtime replies bounded and missing-state handling terminal", async () => {
    const agents = JSON.parse(await readFile(path.join(sourceRoot, "runtime-config.json"), "utf8"))
      .agents.entries;
    expect(agents["program-manager"].params.maxTokens).toBe(1024);
    expect(agents["program-manager"].params.chat_template_kwargs).toEqual({
      enable_thinking: false,
      preserve_thinking: false,
    });
    const instructions = await readFile(path.join(sourceRoot, "workspace/AGENTS.md"), "utf8");
    expect(instructions).toContain("stop tool calls immediately");
    expect(instructions).toContain("never search the workspace for a missing packet");
    expect(instructions).toContain("do not call tools on the first response");
  });

  it("synchronizes only the active Program Manager contract and restores it exactly", async () => {
    const root = temporaryRoots.make("openclaw-pm-config-sync-");
    const configPath = path.join(root, "director.json");
    const backupRoot = path.join(root, "backup");
    const sourceConfig = JSON.parse(
      await readFile(path.join(sourceRoot, "runtime-config.json"), "utf8"),
    ) as { agents: { entries: Record<string, TestAgentEntry> } };
    const list: TestAgentEntry[] = Object.entries(sourceConfig.agents.entries).map(
      ([id, entry]) => ({
        id,
        ...entry,
      }),
    );
    const programManagerIndex = list.findIndex((entry) => entry.id === "program-manager");
    list[programManagerIndex] = {
      ...list[programManagerIndex],
      name: "Program Manager",
      role: "program_manager",
      workspace: "/tmp/program-manager",
      params: { maxTokens: 3072, text_verbosity: "low" },
      tools: {
        alsoAllow: ["memory_search", "sessions_list"],
        deny: ["exec", "write"],
      },
      subagents: {
        allowAgents: ["builder-agent", "qa-test-agent"],
        delegationMode: "prefer",
        requireAgentId: true,
      },
    };
    const beforeText = `${JSON.stringify({ agents: { list } }, null, 2)}\n`;
    await writeFile(configPath, beforeText, "utf8");

    await applyRuntimeConfig({ sourceRoot, configPath, backupRoot });
    const applied = JSON.parse(await readFile(configPath, "utf8")) as {
      agents: { list: TestAgentEntry[] };
    };
    const programManager = applied.agents.list.find((entry) => entry.id === "program-manager");
    if (
      !programManager ||
      !programManager.params ||
      !programManager.tools?.alsoAllow ||
      !programManager.subagents?.allowAgents
    ) {
      throw new Error("Applied Program Manager entry is incomplete.");
    }
    expect(programManager.params.maxTokens).toBe(1024);
    expect(programManager.params.chat_template_kwargs).toEqual({
      enable_thinking: false,
      preserve_thinking: false,
    });
    expect(programManager.tools.alsoAllow.toSorted()).toEqual([
      "get_goal",
      "progress_card",
      "read",
      "sessions_spawn",
      "sessions_yield",
    ]);
    expect(programManager.subagents.allowAgents).toEqual(["builder-agent", "research-brief-agent"]);
    expect(programManager.role).toBe("program_manager");
    expect(programManager.workspace).toBe("/tmp/program-manager");

    await rollbackRuntimeConfig({ configPath, backupRoot });
    expect(await readFile(configPath, "utf8")).toBe(beforeText);
  });

  it("installs and rolls back only managed files", async () => {
    const root = temporaryRoots.make("openclaw-pm-context-test-");
    const workspaceRoot = path.join(root, "workspace");
    const backupRoot = path.join(root, "backup");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, "unrelated.txt"), "keep me\n", "utf8");
    await writeFile(path.join(workspaceRoot, "AGENTS.md"), "old context\n", "utf8");

    await installWorkspace({ sourceRoot, workspaceRoot, backupRoot });
    expect(await readFile(path.join(workspaceRoot, "AGENTS.md"), "utf8")).toContain(
      "# Program Manager",
    );
    expect(await readFile(path.join(workspaceRoot, "CONTRACT.md"), "utf8")).toContain(
      "# Program Manager contract",
    );
    expect(await readFile(path.join(workspaceRoot, "unrelated.txt"), "utf8")).toBe("keep me\n");
    expect(await verifyInstalledWorkspace({ sourceRoot, workspaceRoot })).toEqual({
      ok: true,
      issues: [],
      managedFiles: 7,
    });

    await rollbackWorkspace({ workspaceRoot, backupRoot });
    expect(await readFile(path.join(workspaceRoot, "AGENTS.md"), "utf8")).toBe("old context\n");
    await expect(readFile(path.join(workspaceRoot, "CONTRACT.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(path.join(workspaceRoot, "unrelated.txt"), "utf8")).toBe("keep me\n");
  });

  it("rejects symlinked managed destinations before copying", async () => {
    const root = temporaryRoots.make("openclaw-pm-context-symlink-");
    const workspaceRoot = path.join(root, "workspace");
    const backupRoot = path.join(root, "backup");
    const outside = path.join(root, "outside.txt");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(outside, "must remain unchanged\n", "utf8");
    await symlink(outside, path.join(workspaceRoot, "AGENTS.md"));

    await expect(installWorkspace({ sourceRoot, workspaceRoot, backupRoot })).rejects.toThrow(
      /symlink/i,
    );
    expect(await readFile(outside, "utf8")).toBe("must remain unchanged\n");
  });

  it("requires delegation targets to exist in the configured agent registry", async () => {
    const root = temporaryRoots.make("openclaw-pm-context-registry-");
    const configPath = path.join(root, "runtime-config.json");
    const config = JSON.parse(await readFile(path.join(sourceRoot, "runtime-config.json"), "utf8"));
    delete config.agents.entries["research-brief-agent"];
    await writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");

    const result = await checkRuntimeConfig(configPath);
    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain("delegation_target_unconfigured");
  });

  it("fails closed when state contains a sensitive field", async () => {
    const root = temporaryRoots.make("openclaw-pm-context-invalid-");
    await cp(sourceRoot, root, { recursive: true });
    const statePath = path.join(root, "state/program-manager.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.secret = "not allowed";
    await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
    const result = await checkSource(root);
    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain("state_secret_like_key");
  });
});
