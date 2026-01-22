import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
  filterBootstrapFilesForSession,
} from "./workspace.js";

describe("ensureAgentWorkspace", () => {
  it("creates directory and bootstrap files when missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-ws-"));
    const nested = path.join(dir, "nested");
    const result = await ensureAgentWorkspace({
      dir: nested,
      ensureBootstrapFiles: true,
    });
    expect(result.dir).toBe(path.resolve(nested));
    expect(result.agentsPath).toBe(path.join(path.resolve(nested), "AGENTS.md"));
    expect(result.agentsPath).toBeDefined();
    if (!result.agentsPath) throw new Error("agentsPath missing");
    const content = await fs.readFile(result.agentsPath, "utf-8");
    expect(content).toContain("# AGENTS.md");

    const identity = path.join(path.resolve(nested), "IDENTITY.md");
    const user = path.join(path.resolve(nested), "USER.md");
    const heartbeat = path.join(path.resolve(nested), "HEARTBEAT.md");
    const bootstrap = path.join(path.resolve(nested), "BOOTSTRAP.md");
    await expect(fs.stat(identity)).resolves.toBeDefined();
    await expect(fs.stat(user)).resolves.toBeDefined();
    await expect(fs.stat(heartbeat)).resolves.toBeDefined();
    await expect(fs.stat(bootstrap)).resolves.toBeDefined();
  });

  it("initializes a git repo for brand-new workspaces when git is available", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-ws-"));
    const nested = path.join(dir, "nested");
    const gitAvailable = await runCommandWithTimeout(["git", "--version"], { timeoutMs: 2_000 })
      .then((res) => res.code === 0)
      .catch(() => false);
    if (!gitAvailable) return;

    await ensureAgentWorkspace({
      dir: nested,
      ensureBootstrapFiles: true,
    });

    await expect(fs.stat(path.join(nested, ".git"))).resolves.toBeDefined();
  });

  it("does not initialize git when workspace already exists", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-ws-"));
    await fs.writeFile(path.join(dir, "AGENTS.md"), "custom", "utf-8");

    await ensureAgentWorkspace({
      dir,
      ensureBootstrapFiles: true,
    });

    await expect(fs.stat(path.join(dir, ".git"))).rejects.toBeDefined();
  });

  it("does not overwrite existing AGENTS.md", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-ws-"));
    const agentsPath = path.join(dir, "AGENTS.md");
    await fs.writeFile(agentsPath, "custom", "utf-8");
    await ensureAgentWorkspace({ dir, ensureBootstrapFiles: true });
    expect(await fs.readFile(agentsPath, "utf-8")).toBe("custom");
  });

  it("does not recreate BOOTSTRAP.md once workspace exists", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-ws-"));
    const agentsPath = path.join(dir, "AGENTS.md");
    const bootstrapPath = path.join(dir, "BOOTSTRAP.md");

    await fs.writeFile(agentsPath, "custom", "utf-8");
    await fs.rm(bootstrapPath, { force: true });

    await ensureAgentWorkspace({ dir, ensureBootstrapFiles: true });

    await expect(fs.stat(bootstrapPath)).rejects.toBeDefined();
  });
});

describe("filterBootstrapFilesForSession", () => {
  const files: WorkspaceBootstrapFile[] = [
    {
      name: DEFAULT_AGENTS_FILENAME,
      path: "/tmp/AGENTS.md",
      content: "agents",
      missing: false,
    },
    {
      name: DEFAULT_SOUL_FILENAME,
      path: "/tmp/SOUL.md",
      content: "soul",
      missing: false,
    },
    {
      name: DEFAULT_TOOLS_FILENAME,
      path: "/tmp/TOOLS.md",
      content: "tools",
      missing: false,
    },
    {
      name: DEFAULT_IDENTITY_FILENAME,
      path: "/tmp/IDENTITY.md",
      content: "identity",
      missing: false,
    },
    {
      name: DEFAULT_USER_FILENAME,
      path: "/tmp/USER.md",
      content: "user",
      missing: false,
    },
    {
      name: DEFAULT_HEARTBEAT_FILENAME,
      path: "/tmp/HEARTBEAT.md",
      content: "heartbeat",
      missing: false,
    },
    {
      name: DEFAULT_BOOTSTRAP_FILENAME,
      path: "/tmp/BOOTSTRAP.md",
      content: "bootstrap",
      missing: false,
    },
  ];

  it("keeps full bootstrap set for non-subagent sessions", () => {
    const result = filterBootstrapFilesForSession(files, "agent:main:session:abc");
    expect(result.map((file) => file.name)).toEqual(files.map((file) => file.name));
  });

  it("limits bootstrap files for subagent sessions", () => {
    const result = filterBootstrapFilesForSession(files, "agent:main:subagent:abc");
    expect(result.map((file) => file.name)).toEqual([
      DEFAULT_AGENTS_FILENAME,
      DEFAULT_TOOLS_FILENAME,
    ]);
  });
});
