import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRealtimeBootstrapContextInstructions } from "./realtime-bootstrap-context.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-realtime-bootstrap-"));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(workspaceDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: { workspace: workspaceDir },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("resolveRealtimeBootstrapContextInstructions", () => {
  it("formats the default profile bootstrap files without exposing local paths", async () => {
    const workspaceDir = await makeWorkspace();
    await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), "Name: Wilfred\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "User likes concise answers.\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Warm and dry.\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Do not load me here.\n", "utf8");

    const instructions = await resolveRealtimeBootstrapContextInstructions({
      config: makeConfig(workspaceDir),
      agentId: "main",
      sessionKey: "agent:main:discord:channel:1001",
    });

    expect(instructions).toContain("OpenClaw realtime voice profile context");
    expect(instructions).toContain("### IDENTITY.md");
    expect(instructions).toContain("Name: Wilfred");
    expect(instructions).toContain("### USER.md");
    expect(instructions).toContain("User likes concise answers.");
    expect(instructions).toContain("### SOUL.md");
    expect(instructions).toContain("Warm and dry.");
    expect(instructions).not.toContain("AGENTS.md");
    expect(instructions).not.toContain("Do not load me here.");
    expect(instructions).not.toContain("openclaw_agent_consult");
    expect(instructions).not.toContain(workspaceDir);
  });

  it("ignores unsupported file requests from unchecked callers", async () => {
    const workspaceDir = await makeWorkspace();
    const warnings: string[] = [];
    const uncheckedFiles = ["IDENTITY.md", "AGENTS.md"] as unknown as NonNullable<
      Parameters<typeof resolveRealtimeBootstrapContextInstructions>[0]["files"]
    >;
    await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), "Name: Wilfred\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Do not load me here.\n", "utf8");

    const instructions = await resolveRealtimeBootstrapContextInstructions({
      config: makeConfig(workspaceDir),
      agentId: "main",
      files: uncheckedFiles,
      warn: (message) => warnings.push(message),
    });

    expect(instructions).toContain("### IDENTITY.md");
    expect(instructions).toContain("Name: Wilfred");
    expect(instructions).not.toContain("AGENTS.md");
    expect(instructions).not.toContain("Do not load me here.");
    expect(warnings).toContain('skipping unsupported realtime bootstrap context file "AGENTS.md"');
  });

  it("keeps the complete injected instruction text within the default budget", async () => {
    const workspaceDir = await makeWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, "IDENTITY.md"),
      "Name: Wilfred\n".repeat(1_000),
      "utf8",
    );
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "User likes concise answers.\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Warm and dry.\n", "utf8");

    const instructions = await resolveRealtimeBootstrapContextInstructions({
      config: makeConfig(workspaceDir),
      agentId: "main",
      files: ["IDENTITY.md", "USER.md", "SOUL.md"],
    });

    expect(instructions).toContain("### IDENTITY.md");
    expect(instructions?.length).toBeLessThanOrEqual(4_000);
  });

  it("returns undefined when no requested profile files exist", async () => {
    const workspaceDir = await makeWorkspace();

    await expect(
      resolveRealtimeBootstrapContextInstructions({
        config: makeConfig(workspaceDir),
        agentId: "main",
        files: ["IDENTITY.md", "USER.md"],
      }),
    ).resolves.toBeUndefined();
  });
});
