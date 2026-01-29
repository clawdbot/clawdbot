import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveBootstrapContextForRun, resolveBootstrapFilesForRun } from "./bootstrap-files.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import type { ClawdbotConfig } from "../config/config.js";

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("applies bootstrap hook overrides", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "EXTRA.md",
          path: path.join(context.workspaceDir, "EXTRA.md"),
          content: "extra",
          missing: false,
        },
      ];
    });

    const workspaceDir = await makeTempWorkspace("moltbot-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.some((file) => file.name === "EXTRA.md")).toBe(true);
  });
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns context files for hook-adjusted bootstrap files", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "EXTRA.md",
          path: path.join(context.workspaceDir, "EXTRA.md"),
          content: "extra",
          missing: false,
        },
      ];
    });

    const workspaceDir = await makeTempWorkspace("moltbot-bootstrap-");
    const result = await resolveBootstrapContextForRun({ workspaceDir });
    const extra = result.contextFiles.find((file) => file.path === "EXTRA.md");

    expect(extra?.content).toBe("extra");
  });
});

describe("extraWorkspaceFiles per-agent config", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("uses per-agent extraWorkspaceFiles over defaults", async () => {
    const workspaceDir = await makeTempWorkspace("clawdbot-bootstrap-");
    await writeWorkspaceFile({ dir: workspaceDir, name: "AGENT_SPECIFIC.md", content: "agent" });
    await writeWorkspaceFile({ dir: workspaceDir, name: "DEFAULT.md", content: "default" });

    const config: ClawdbotConfig = {
      agents: {
        defaults: { extraWorkspaceFiles: ["DEFAULT.md"] },
        list: [{ id: "test-agent", extraWorkspaceFiles: ["AGENT_SPECIFIC.md"] }],
      },
    };

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config,
      agentId: "test-agent",
    });

    // Per-agent config should be used, not defaults
    expect(files.some((f) => f.name === "AGENT_SPECIFIC.md")).toBe(true);
    expect(files.some((f) => f.name === "DEFAULT.md")).toBe(false);
  });

  it("falls back to defaults when agent has no extraWorkspaceFiles", async () => {
    const workspaceDir = await makeTempWorkspace("clawdbot-bootstrap-");
    await writeWorkspaceFile({ dir: workspaceDir, name: "DEFAULT.md", content: "default" });

    const config: ClawdbotConfig = {
      agents: {
        defaults: { extraWorkspaceFiles: ["DEFAULT.md"] },
        list: [{ id: "other-agent" }],
      },
    };

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config,
      agentId: "other-agent",
    });

    expect(files.some((f) => f.name === "DEFAULT.md")).toBe(true);
  });

  it("allows per-agent to disable extras with empty array", async () => {
    const workspaceDir = await makeTempWorkspace("clawdbot-bootstrap-");
    await writeWorkspaceFile({ dir: workspaceDir, name: "DEFAULT.md", content: "default" });

    const config: ClawdbotConfig = {
      agents: {
        defaults: { extraWorkspaceFiles: ["DEFAULT.md"] },
        list: [{ id: "no-extras", extraWorkspaceFiles: [] }],
      },
    };

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config,
      agentId: "no-extras",
    });

    // Empty array should override defaults - no extra files
    expect(files.some((f) => f.name === "DEFAULT.md")).toBe(false);
  });
});
