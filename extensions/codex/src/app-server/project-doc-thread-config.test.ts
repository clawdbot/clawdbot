import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureCodexNativeProjectInstructions } from "./project-doc-thread-config.js";

describe("Codex native project-document snapshots", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-project-doc-snapshot-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("preserves Codex source selection and order while excluding global instructions", async () => {
    const packageDir = path.join(workspaceDir, "packages");
    const cwd = path.join(packageDir, "worker");
    const globalInstructions = path.join(workspaceDir, ".codex", "AGENTS.md");
    const rootFallback = path.join(workspaceDir, "PROJECT.md");
    const packageOverride = path.join(packageDir, "AGENTS.override.md");
    const cwdFallback = path.join(cwd, "WORKSPACE.md");
    await fs.mkdir(path.dirname(globalInstructions), { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(globalInstructions, "global policy");
    await fs.writeFile(rootFallback, "root fallback");
    await fs.writeFile(packageOverride, "package override");
    await fs.writeFile(cwdFallback, "cwd fallback");

    await expect(
      captureCodexNativeProjectInstructions({
        cwd,
        instructionSources: [globalInstructions, rootFallback, packageOverride, cwdFallback],
      }),
    ).resolves.toBe(
      [
        "## OpenClaw Agent Workspace Instructions",
        "",
        "OpenClaw froze the Codex-selected root-to-working-directory project instructions that established this thread.",
        "",
        `### ${rootFallback}`,
        "",
        "root fallback",
        "",
        `### ${packageOverride}`,
        "",
        "package override",
        "",
        `### ${cwdFallback}`,
        "",
        "cwd fallback",
      ].join("\n"),
    );
  });

  it("does not rediscover project files omitted by Codex", async () => {
    const cwd = path.join(workspaceDir, "nested");
    const selected = path.join(cwd, "PROJECT.md");
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "unselected parent policy");
    await fs.writeFile(selected, "selected custom policy");

    await expect(
      captureCodexNativeProjectInstructions({ cwd, instructionSources: [selected] }),
    ).resolves.toContain(`### ${selected}\n\nselected custom policy`);
  });

  it("shares the configured byte budget across Codex-selected sources", async () => {
    const cwd = path.join(workspaceDir, "nested");
    const rootInstructions = path.join(workspaceDir, "AGENTS.md");
    const nestedInstructions = path.join(cwd, "AGENTS.md");
    await fs.mkdir(cwd);
    await fs.writeFile(rootInstructions, "root");
    await fs.writeFile(nestedInstructions, "nested");

    await expect(
      captureCodexNativeProjectInstructions({
        cwd,
        instructionSources: [rootInstructions, nestedInstructions],
        config: { project_doc_max_bytes: 7 },
      }),
    ).resolves.toContain(`### ${rootInstructions}\n\nroot\n\n### ${nestedInstructions}\n\nnes`);
  });

  it("renders a bounded frozen snapshot from the response sources", async () => {
    const instructions = path.join(workspaceDir, "CUSTOM.md");
    await fs.writeFile(instructions, "custom authority");

    await expect(
      captureCodexNativeProjectInstructions({
        cwd: workspaceDir,
        instructionSources: [instructions],
        config: { project_doc_max_bytes: 6 },
      }),
    ).resolves.toContain("### " + instructions + "\n\ncustom");
  });

  it("fails closed if a Codex-selected source disappears before capture", async () => {
    const missingInstructions = path.join(workspaceDir, "AGENTS.md");

    await expect(
      captureCodexNativeProjectInstructions({
        cwd: workspaceDir,
        instructionSources: [missingInstructions],
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when a selected local source changed after native startup began", async () => {
    const instructions = path.join(workspaceDir, "AGENTS.md");
    await fs.writeFile(instructions, "changed authority");
    const identity = await fs.stat(instructions);

    await expect(
      captureCodexNativeProjectInstructions({
        cwd: workspaceDir,
        instructionSources: [instructions],
        notModifiedSinceMs: Math.max(identity.mtimeMs, identity.ctimeMs) - 1,
      }),
    ).rejects.toThrow("changed during native startup");
  });

  it("accepts a selected source whose timestamp equals the startup boundary", async () => {
    const instructions = path.join(workspaceDir, "AGENTS.md");
    await fs.writeFile(instructions, "authority written before startup");
    const identity = await fs.stat(instructions);

    await expect(
      captureCodexNativeProjectInstructions({
        cwd: workspaceDir,
        instructionSources: [instructions],
        notModifiedSinceMs: Math.max(identity.mtimeMs, identity.ctimeMs),
      }),
    ).resolves.toContain("authority written before startup");
  });
});
