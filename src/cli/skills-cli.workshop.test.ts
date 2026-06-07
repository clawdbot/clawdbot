// Skills workshop CLI tests cover workshop skill commands and filesystem setup.
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { registerSkillsCli } from "./skills-cli.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
let stateDir = "";

const mocks = vi.hoisted(() => {
  const runtimeStdout: string[] = [];
  const runtimeErrors: string[] = [];
  const defaultRuntime = {
    log: vi.fn((message: string) => {
      runtimeStdout.push(message);
    }),
    error: vi.fn((message: string) => {
      runtimeErrors.push(message);
    }),
    writeStdout: vi.fn((value: string) => {
      runtimeStdout.push(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      runtimeStdout.push(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    defaultRuntime,
    runtimeStdout,
    runtimeErrors,
    workspaceDir: "",
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../terminal/links.js", () => ({
  formatDocsLink: () => "docs.openclaw.ai/cli/skills",
}));

vi.mock("../terminal/theme.js", () => ({
  theme: {
    command: (value: string) => value,
    error: (value: string) => value,
    heading: (value: string) => value,
    muted: (value: string) => value,
    success: (value: string) => value,
    warn: (value: string) => value,
  },
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentIdByWorkspacePath: () => undefined,
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => mocks.workspaceDir,
}));

describe("skills workshop cli", () => {
  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerSkillsCli(program);
    return program;
  };

  const runCommand = async (argv: string[]) => {
    try {
      await createProgram().parseAsync(argv, { from: "user" });
    } catch (error) {
      if (error instanceof Error && error.message === "__exit__:0") {
        return;
      }
      throw error;
    }
  };

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skills-cli-workshop-state-",
    });
    mocks.workspaceDir = await tempDirs.make("openclaw-skills-cli-workshop-");
    stateDir = testState.stateDir;
    mocks.runtimeStdout.length = 0;
    mocks.runtimeErrors.length = 0;
    mocks.defaultRuntime.log.mockClear();
    mocks.defaultRuntime.error.mockClear();
    mocks.defaultRuntime.writeStdout.mockClear();
    mocks.defaultRuntime.writeJson.mockClear();
    mocks.defaultRuntime.exit.mockClear();
  });

  afterEach(async () => {
    await testState.cleanup();
    await tempDirs.cleanup();
  });

  it("creates, lists, inspects, and applies a skill proposal", async () => {
    const draftPath = path.join(mocks.workspaceDir, "proposal-draft");
    await fs.mkdir(path.join(draftPath, "references"), { recursive: true });
    await fs.writeFile(
      path.join(draftPath, "PROPOSAL.md"),
      "# Paris Weather\n\nCheck current weather before advice.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(draftPath, "references", "weather.md"),
      "Use current conditions before recommendations.\n",
      "utf8",
    );

    await runCommand([
      "skills",
      "workshop",
      "propose-create",
      "--name",
      "Paris Weather",
      "--description",
      "Weather lookup workflow",
      "--proposal-dir",
      draftPath,
    ]);

    const proposalId = mocks.runtimeStdout.at(-1);
    expect(proposalId).toMatch(/^paris-weather-/);

    await runCommand(["skills", "workshop", "list"]);
    expect(mocks.runtimeStdout.at(-1)).toContain(`${proposalId}  pending  create`);

    await runCommand(["skills", "workshop", "inspect", proposalId!]);
    expect(mocks.runtimeStdout.at(-1)).toContain("status: proposal");
    expect(mocks.runtimeStdout.at(-1)).toContain("--- references/weather.md ---");
    expect(mocks.runtimeStdout.at(-1)).toContain("Use current conditions before recommendations.");

    const revisedPath = path.join(mocks.workspaceDir, "revised-proposal.md");
    await fs.writeFile(
      revisedPath,
      "# Paris Weather\n\nCheck current weather and alerts before advice.\n",
      "utf8",
    );
    await runCommand([
      "skills",
      "workshop",
      "revise",
      proposalId!,
      "--description",
      "Revised weather lookup workflow",
      "--proposal",
      revisedPath,
    ]);
    expect(mocks.runtimeStdout.at(-1)).toContain(`Revised ${proposalId} v2`);

    await runCommand(["skills", "workshop", "apply", proposalId!]);
    expect(mocks.runtimeStdout.at(-1)).toContain("Applied");
    await expect(
      fs.readFile(path.join(mocks.workspaceDir, "skills", "paris-weather", "SKILL.md"), "utf8"),
    ).resolves.toContain("Check current weather and alerts");
    await expect(
      fs.readFile(
        path.join(mocks.workspaceDir, "skills", "paris-weather", "references", "weather.md"),
        "utf8",
      ),
    ).resolves.toContain("Use current conditions");
  });

  it("scopes list and inspect to the selected workspace", async () => {
    const firstWorkspaceDir = mocks.workspaceDir;
    const draftPath = path.join(firstWorkspaceDir, "proposal-draft.md");
    await fs.writeFile(draftPath, "# First CLI Skill\n", "utf8");

    await runCommand([
      "skills",
      "workshop",
      "propose-create",
      "--name",
      "First CLI Skill",
      "--description",
      "First workspace proposal",
      "--proposal",
      draftPath,
    ]);
    const proposalId = mocks.runtimeStdout.at(-1);
    expect(proposalId).toMatch(/^first-cli-skill-/);

    mocks.workspaceDir = await tempDirs.make("openclaw-skills-cli-workshop-second-");
    await runCommand(["skills", "workshop", "list"]);
    expect(mocks.runtimeStdout.at(-1)).toBe("No skill proposals.");
    await expect(runCommand(["skills", "workshop", "inspect", proposalId!])).rejects.toThrow(
      "__exit__:1",
    );
    expect(mocks.runtimeErrors).toContain(`Skill proposal not found: ${proposalId}`);

    mocks.workspaceDir = firstWorkspaceDir;
    await runCommand(["skills", "workshop", "inspect", proposalId!]);
    expect(mocks.runtimeStdout.at(-1)).toContain("status: proposal");
  });

  it("rejects missing proposal drafts before creating workshop state", async () => {
    await expect(
      runCommand([
        "skills",
        "workshop",
        "propose-create",
        "--name",
        "Missing Draft",
        "--description",
        "Missing draft",
        "--proposal",
        path.join(mocks.workspaceDir, "missing.md"),
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.runtimeErrors[0]).toContain("file not found");
    await expect(fs.access(path.join(stateDir, "skill-workshop"))).rejects.toThrow();
  });
});
