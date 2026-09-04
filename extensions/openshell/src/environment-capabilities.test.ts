import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SandboxBackendCommandParams } from "openclaw/plugin-sdk/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverOpenShellCapabilityRoots } from "./environment-capabilities.js";

function runCommand(command: SandboxBackendCommandParams) {
  const result = spawnSync(
    "/bin/sh",
    ["-c", command.script, "discovery-test", ...(command.args ?? [])],
    { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.error) {
    throw result.error;
  }
  return Promise.resolve({
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.status ?? 1,
  });
}

describe.runIf(process.platform !== "win32")("OpenShell environment capabilities", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "capabilities-")));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const contents = "---\nname: demo\ndescription: Demo skill\n---\nUse remote files.\n";
  async function put(relative: string, text = contents) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    return file;
  }
  async function discover(excludePaths?: string[]) {
    return (
      await discoverOpenShellCapabilityRoots({
        roots: [{ id: "workspace", path: root, excludePaths }],
        runCommand,
      })
    )[0]!;
  }

  it("discovers executor-local instruction and metadata text alongside MCP, never arbitrary workspace instructions", async () => {
    await put(".mcp.json", "{}");
    await put(".agents/skills/demo/SKILL.md");
    await put(".agents/skills/demo/agents/openai.yaml", "interface: {}");
    await put("AGENTS.md", "not a skill");
    const result = await discover();
    expect(result.error).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(result.mcpConfig).toEqual({ path: `${root}/.mcp.json`, contents: "{}" });
    expect(result.skills).toEqual([
      {
        instructions: { path: `${root}/.agents/skills/demo/SKILL.md`, contents },
        metadata: {
          path: `${root}/.agents/skills/demo/agents/openai.yaml`,
          contents: "interface: {}",
        },
      },
    ]);
  });

  it("excludes host-projected skills and materialized copies without hiding remote siblings", async () => {
    await put("skills/host/SKILL.md");
    await put(".openclaw/sandbox-skills/skills/copy/SKILL.md");
    await put("remote/demo/SKILL.md");
    await put(".mcp.json", "{}");
    const result = await discover([`${root}/skills`, `${root}/.mcp.json`]);
    expect(result.error).toBeUndefined();
    expect(result.mcpConfig).toBeUndefined();
    expect(result.skills?.map((skill) => skill.instructions.path)).toEqual([
      `${root}/remote/demo/SKILL.md`,
    ]);
  });

  it("rejects symlink hops at files, directories and metadata plus hardlinked files", async () => {
    const outside = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "capability-outside-")),
    );
    try {
      await fs.writeFile(path.join(outside, "SKILL.md"), contents);
      await fs.symlink(path.join(outside, "SKILL.md"), path.join(root, ".mcp.json"));
      await fs.symlink(outside, path.join(root, "escape"));
      await put("valid/SKILL.md");
      await fs.symlink(outside, path.join(root, "valid/agents"));
      await fs.mkdir(path.join(root, "hardlink"));
      await fs.link(path.join(outside, "SKILL.md"), path.join(root, "hardlink/SKILL.md"));
      const result = await discover();
      expect(result.mcpConfig).toBeUndefined();
      expect(result.skills).toEqual([
        { instructions: { path: `${root}/valid/SKILL.md`, contents } },
      ]);
      expect(result.warnings?.join(" ")).toMatch(/symlink/);
      expect(result.warnings?.join(" ")).toMatch(/hardlinked/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")(
    "rejects oversized sparse MCP before allocating its contents",
    async () => {
      const file = await put(".mcp.json", "");
      await fs.truncate(file, 512 * 1024 * 1024);
      const [result] = await discoverOpenShellCapabilityRoots({
        roots: [{ id: "workspace", path: root }],
        runCommand: (command) =>
          runCommand({ ...command, script: `ulimit -v 65536\n${command.script}` }),
      });
      expect(result?.error).toBeUndefined();
      expect(result?.mcpConfig).toBeUndefined();
      expect(result?.warnings).toContain("capability file or root byte limit exceeded");
    },
  );

  it("bounds aggregate bytes, file count and traversal with recorded diagnostics", async () => {
    for (let i = 0; i < 70; i++) {
      await put(`skills/s${String(i).padStart(2, "0")}/SKILL.md`, "x".repeat(20 * 1024));
    }
    await put("a/b/c/d/e/f/g/SKILL.md");
    const result = await discover();
    expect(result.skills!.length).toBeLessThanOrEqual(64);
    expect(
      result.skills!.reduce(
        (sum, skill) => sum + Buffer.byteLength(skill.instructions.contents),
        0,
      ),
    ).toBeLessThanOrEqual(1024 * 1024);
    expect(result.warnings).toContain("capability file or root byte limit exceeded");
    expect(result.warnings).toContain("capability traversal depth limit reached");
  });

  it("caps small skill files independently of bytes and bounds directory enumeration", async () => {
    for (let index = 0; index < 70; index++) {
      await put(`skills/s${String(index).padStart(2, "0")}/SKILL.md`);
    }
    const bySkills = await discover();
    expect(bySkills.skills).toHaveLength(64);
    expect(bySkills.warnings).toContain("capability skill count limit reached");
    await fs.mkdir(path.join(root, "crowded"));
    for (let index = 0; index < 2050; index++) {
      await fs.writeFile(path.join(root, "crowded", String(index)), "");
    }
    const byEntries = await discover();
    expect(byEntries.warnings).toContain("capability traversal entry limit reached");
  });

  it("distinguishes missing roots, empty roots and invalid UTF-8", async () => {
    expect(await discover()).toMatchObject({ skills: [], warnings: [] });
    await fs.writeFile(path.join(root, ".mcp.json"), Buffer.from([255]));
    expect((await discover()).warnings).toContain("non-UTF-8 capability file skipped");
    const [missing] = await discoverOpenShellCapabilityRoots({
      roots: [{ id: "missing", path: `${root}/missing` }],
      runCommand,
    });
    expect(missing?.error).toMatch(/unavailable/);
  });

  it("rejects excess roots before execution and propagates cancellation", async () => {
    const run = vi.fn(runCommand);
    await expect(
      discoverOpenShellCapabilityRoots({
        roots: Array.from({ length: 9 }, () => ({ id: "root", path: root })),
        runCommand: run,
      }),
    ).rejects.toThrow(/at most/);
    await expect(
      discoverOpenShellCapabilityRoots({
        roots: [{ id: "root", path: root }],
        runCommand: run,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["stderr", "path", "bytes"])(
    "fails closed with a redacted diagnostic for invalid %s",
    async (kind) => {
      const response = {
        skills: [],
        warnings: [],
        mcpConfig: { path: "/outside/.mcp.json", contents: "{}" },
      };
      const [result] = await discoverOpenShellCapabilityRoots({
        roots: [{ id: "root", path: root }],
        runCommand: async () => ({
          code: kind === "stderr" ? 1 : 0,
          stderr: Buffer.from("sensitive stderr"),
          stdout:
            kind === "bytes"
              ? Buffer.alloc(7 * 1024 * 1024)
              : Buffer.from(JSON.stringify(response)),
        }),
      });
      expect(result?.error).toMatch(/failed|invalid/);
      expect(JSON.stringify(result)).not.toContain("sensitive stderr");
      expect(result?.mcpConfig).toBeUndefined();
    },
  );
});
