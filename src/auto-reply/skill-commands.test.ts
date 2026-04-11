import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let listSkillCommandsForAgents: typeof import("./skill-commands.js").listSkillCommandsForAgents;
let listSkillCommandsForWorkspace: typeof import("./skill-commands.js").listSkillCommandsForWorkspace;
let resolveSkillCommandInvocation: typeof import("./skill-commands.js").resolveSkillCommandInvocation;
let skillCommandsTesting: typeof import("./skill-commands.js").__testing;

function resolveUniqueSkillCommandName(base: string, used: Set<string>): string {
  let name = base;
  let suffix = 2;
  while (used.has(name.toLowerCase())) {
    name = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

function resolveWorkspaceSkills(
  workspaceDir: string,
): Array<{ skillName: string; description: string }> {
  const dirName = path.basename(workspaceDir);
  if (dirName === "main") {
    return [{ skillName: "demo-skill", description: "Demo skill" }];
  }
  if (dirName === "research") {
    return [
      { skillName: "demo-skill", description: "Demo skill 2" },
      { skillName: "extra-skill", description: "Extra skill" },
    ];
  }
  if (dirName === "shared-defaults") {
    return [
      { skillName: "alpha-skill", description: "Alpha skill" },
      { skillName: "beta-skill", description: "Beta skill" },
      { skillName: "hidden-skill", description: "Hidden skill" },
    ];
  }
  return [];
}

function buildWorkspaceSkillCommandSpecs(
  workspaceDir: string,
  opts?: {
    reservedNames?: Set<string>;
    skillFilter?: string[];
    agentId?: string;
    config?: {
      agents?: {
        defaults?: { skills?: string[] };
        list?: Array<{ id: string; skills?: string[] }>;
      };
    };
  },
) {
  const used = new Set<string>();
  for (const reserved of opts?.reservedNames ?? []) {
    used.add(reserved.toLowerCase());
  }
  const agentSkills = opts?.config?.agents?.list?.find((entry) => entry.id === opts?.agentId);
  const filter =
    opts?.skillFilter ??
    (agentSkills && Object.hasOwn(agentSkills, "skills")
      ? agentSkills.skills
      : opts?.config?.agents?.defaults?.skills);
  const entries =
    filter === undefined
      ? resolveWorkspaceSkills(workspaceDir)
      : resolveWorkspaceSkills(workspaceDir).filter((entry) =>
          filter.some((skillName) => skillName === entry.skillName),
        );

  return entries.map((entry) => {
    const base = entry.skillName.replace(/-/g, "_");
    const name = resolveUniqueSkillCommandName(base, used);
    return { name, skillName: entry.skillName, description: entry.description };
  });
}

vi.mock("./commands-registry.js", () => ({
  listChatCommands: () => [],
}));

vi.mock("../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: () => ({}),
}));

vi.mock("../agents/skills.js", () => ({
  buildWorkspaceSkillCommandSpecs,
}));

beforeAll(async () => {
  ({
    listSkillCommandsForAgents,
    listSkillCommandsForWorkspace,
    resolveSkillCommandInvocation,
    __testing: skillCommandsTesting,
  } = await import("./skill-commands.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveSkillCommandInvocation", () => {
  it("matches skill commands and parses args", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/demo_skill do the thing",
      skillCommands: [{ name: "demo_skill", skillName: "demo-skill", description: "Demo" }],
    });
    expect(invocation?.command.skillName).toBe("demo-skill");
    expect(invocation?.args).toBe("do the thing");
  });

  it("supports /skill with name argument", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/skill demo_skill do the thing",
      skillCommands: [{ name: "demo_skill", skillName: "demo-skill", description: "Demo" }],
    });
    expect(invocation?.command.name).toBe("demo_skill");
    expect(invocation?.args).toBe("do the thing");
  });

  it("normalizes /skill lookup names", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/skill demo-skill",
      skillCommands: [{ name: "demo_skill", skillName: "demo-skill", description: "Demo" }],
    });
    expect(invocation?.command.name).toBe("demo_skill");
    expect(invocation?.args).toBeUndefined();
  });

  it("returns null for unknown commands", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/unknown arg",
      skillCommands: [{ name: "demo_skill", skillName: "demo-skill", description: "Demo" }],
    });
    expect(invocation).toBeNull();
  });
});

describe("listSkillCommandsForAgents", () => {
  const tempDirs: string[] = [];
  const makeTempDir = async (prefix: string) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };
  afterAll(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("deduplicates by skillName across agents, keeping the first registration", async () => {
    const baseDir = await makeTempDir("openclaw-skills-");
    const mainWorkspace = path.join(baseDir, "main");
    const researchWorkspace = path.join(baseDir, "research");
    await fs.mkdir(mainWorkspace, { recursive: true });
    await fs.mkdir(researchWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      cfg: {
        agents: {
          list: [
            { id: "main", workspace: mainWorkspace },
            { id: "research", workspace: researchWorkspace },
          ],
        },
      },
    });
    const names = commands.map((entry) => entry.name);
    expect(names).toContain("demo_skill");
    expect(names).not.toContain("demo_skill_2");
    expect(names).toContain("extra_skill");
  });

  it("scopes to specific agents when agentIds is provided", async () => {
    const baseDir = await makeTempDir("openclaw-skills-filter-");
    const researchWorkspace = path.join(baseDir, "research");
    await fs.mkdir(researchWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      cfg: {
        agents: {
          list: [{ id: "research", workspace: researchWorkspace, skills: ["extra-skill"] }],
        },
      },
      agentIds: ["research"],
    });

    expect(commands.map((entry) => entry.name)).toEqual(["extra_skill"]);
    expect(commands.map((entry) => entry.skillName)).toEqual(["extra-skill"]);
  });

  it("prevents cross-agent skill leakage when each agent has an allowlist", async () => {
    const baseDir = await makeTempDir("openclaw-skills-leak-");
    const mainWorkspace = path.join(baseDir, "main");
    const researchWorkspace = path.join(baseDir, "research");
    await fs.mkdir(mainWorkspace, { recursive: true });
    await fs.mkdir(researchWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      cfg: {
        agents: {
          list: [
            { id: "main", workspace: mainWorkspace, skills: ["demo-skill"] },
            { id: "research", workspace: researchWorkspace, skills: ["extra-skill"] },
          ],
        },
      },
      agentIds: ["main", "research"],
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["demo-skill", "extra-skill"]);
    expect(commands.map((entry) => entry.name)).toEqual(["demo_skill", "extra_skill"]);
  });

  it("merges allowlists for agents that share one workspace", async () => {
    const baseDir = await makeTempDir("openclaw-skills-shared-");
    const sharedWorkspace = path.join(baseDir, "research");
    await fs.mkdir(sharedWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      cfg: {
        agents: {
          list: [
            { id: "main", workspace: sharedWorkspace, skills: ["demo-skill"] },
            { id: "research", workspace: sharedWorkspace, skills: ["extra-skill"] },
          ],
        },
      },
      agentIds: ["main", "research"],
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["demo-skill", "extra-skill"]);
    expect(commands.map((entry) => entry.name)).toEqual(["demo_skill", "extra_skill"]);
  });

  it("deduplicates overlapping allowlists for shared workspace", async () => {
    const baseDir = await makeTempDir("openclaw-skills-overlap-");
    const sharedWorkspace = path.join(baseDir, "research");
    await fs.mkdir(sharedWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      cfg: {
        agents: {
          list: [
            { id: "agent-a", workspace: sharedWorkspace, skills: ["extra-skill"] },
            { id: "agent-b", workspace: sharedWorkspace, skills: ["extra-skill", "demo-skill"] },
          ],
        },
      },
      agentIds: ["agent-a", "agent-b"],
    });

    // Both agents allowlist "extra-skill"; it should appear once, not twice.
    expect(commands.map((entry) => entry.skillName)).toEqual(["demo-skill", "extra-skill"]);
    expect(commands.map((entry) => entry.name)).toEqual(["demo_skill", "extra_skill"]);
  });

  it("keeps workspace unrestricted when one co-tenant agent has no skills filter", async () => {
    const baseDir = await makeTempDir("openclaw-skills-unfiltered-");
    const sharedWorkspace = path.join(baseDir, "research");
    await fs.mkdir(sharedWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      cfg: {
        agents: {
          list: [
            { id: "restricted", workspace: sharedWorkspace, skills: ["extra-skill"] },
            { id: "unrestricted", workspace: sharedWorkspace },
          ],
        },
      },
      agentIds: ["restricted", "unrestricted"],
    });

    const skillNames = commands.map((entry) => entry.skillName);
    expect(skillNames).toContain("demo-skill");
    expect(skillNames).toContain("extra-skill");
  });

  it("merges empty allowlist with non-empty allowlist for shared workspace", async () => {
    const baseDir = await makeTempDir("openclaw-skills-empty-");
    const sharedWorkspace = path.join(baseDir, "research");
    await fs.mkdir(sharedWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      cfg: {
        agents: {
          list: [
            { id: "locked", workspace: sharedWorkspace, skills: [] },
            { id: "partial", workspace: sharedWorkspace, skills: ["extra-skill"] },
          ],
        },
      },
      agentIds: ["locked", "partial"],
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["extra-skill"]);
  });

  it("uses inherited defaults for agents that share one workspace", async () => {
    const baseDir = await makeTempDir("openclaw-skills-defaults-");
    const sharedWorkspace = path.join(baseDir, "shared-defaults");
    await fs.mkdir(sharedWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      cfg: {
        agents: {
          defaults: {
            skills: ["alpha-skill"],
          },
          list: [
            { id: "alpha", workspace: sharedWorkspace },
            { id: "beta", workspace: sharedWorkspace, skills: ["beta-skill"] },
            { id: "gamma", workspace: sharedWorkspace },
          ],
        },
      },
      agentIds: ["alpha", "beta", "gamma"],
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["alpha-skill", "beta-skill"]);
  });

  it("does not inherit defaults when an agent sets an explicit empty skills list", async () => {
    const baseDir = await makeTempDir("openclaw-skills-defaults-empty-");
    const sharedWorkspace = path.join(baseDir, "shared-defaults");
    await fs.mkdir(sharedWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      cfg: {
        agents: {
          defaults: {
            skills: ["alpha-skill", "hidden-skill"],
          },
          list: [
            { id: "alpha", workspace: sharedWorkspace, skills: [] },
            { id: "beta", workspace: sharedWorkspace, skills: ["beta-skill"] },
          ],
        },
      },
      agentIds: ["alpha", "beta"],
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["beta-skill"]);
  });

  it("skips agents with missing workspaces gracefully", async () => {
    const baseDir = await makeTempDir("openclaw-skills-missing-");
    const validWorkspace = path.join(baseDir, "research");
    const missingWorkspace = path.join(baseDir, "nonexistent");
    await fs.mkdir(validWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      cfg: {
        agents: {
          list: [
            { id: "valid", workspace: validWorkspace },
            { id: "broken", workspace: missingWorkspace },
          ],
        },
      },
      agentIds: ["valid", "broken"],
    });

    // The valid agent's skills should still be listed despite the broken one.
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.map((entry) => entry.skillName)).toContain("demo-skill");
  });
});

describe("listSkillCommandsForWorkspace", () => {
  const tempDirs: string[] = [];
  const makeTempDir = async (prefix: string) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };
  afterAll(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("inherits defaults when agentId is provided without an explicit skill filter", async () => {
    const baseDir = await makeTempDir("openclaw-skills-workspace-defaults-");
    const sharedWorkspace = path.join(baseDir, "shared-defaults");
    await fs.mkdir(sharedWorkspace, { recursive: true });

    const commands = listSkillCommandsForWorkspace({
      workspaceDir: sharedWorkspace,
      cfg: {
        agents: {
          defaults: {
            skills: ["alpha-skill"],
          },
          list: [{ id: "alpha", workspace: sharedWorkspace }],
        },
      },
      agentId: "alpha",
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["alpha-skill"]);
  });
});

describe("dedupeBySkillName", () => {
  it("keeps the first entry when multiple commands share a skillName", () => {
    const input = [
      { name: "github", skillName: "github", description: "GitHub" },
      { name: "github_2", skillName: "github", description: "GitHub" },
      { name: "weather", skillName: "weather", description: "Weather" },
      { name: "weather_2", skillName: "weather", description: "Weather" },
    ];
    const output = skillCommandsTesting.dedupeBySkillName(input);
    expect(output.map((e) => e.name)).toEqual(["github", "weather"]);
  });

  it("matches skillName case-insensitively", () => {
    const input = [
      { name: "ClawHub", skillName: "ClawHub", description: "ClawHub" },
      { name: "clawhub_2", skillName: "clawhub", description: "ClawHub" },
    ];
    const output = skillCommandsTesting.dedupeBySkillName(input);
    expect(output).toHaveLength(1);
    expect(output[0]?.name).toBe("ClawHub");
  });

  it("passes through commands with an empty skillName", () => {
    const input = [
      { name: "a", skillName: "", description: "A" },
      { name: "b", skillName: "", description: "B" },
    ];
    expect(skillCommandsTesting.dedupeBySkillName(input)).toHaveLength(2);
  });

  it("returns an empty array for empty input", () => {
    expect(skillCommandsTesting.dedupeBySkillName([])).toEqual([]);
  });
});
