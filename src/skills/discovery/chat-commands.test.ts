// Chat command tests cover discovery and invocation of skill-provided commands.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";

let listSkillCommandsForAgents: typeof import("./chat-commands.js").listSkillCommandsForAgents;
let listSkillCommandsForWorkspace: typeof import("./chat-commands.js").listSkillCommandsForWorkspace;
let resolveSkillCommandInvocation: typeof import("./chat-commands.js").resolveSkillCommandInvocation;
let resolveSkillReferenceInvocations: typeof import("./chat-commands.js").resolveSkillReferenceInvocations;

const tempDirs = createTempDirTracker();
const resolveNodeExecEligibilityMock = vi.hoisted(() =>
  vi.fn((_params: { agentId?: string }) => ({ canExec: false })),
);

async function createWorkspace(parentDir: string, name: string) {
  const workspace = path.join(parentDir, name);
  await fs.mkdir(workspace, { recursive: true });
  return workspace;
}

async function createMainAndResearchWorkspaces(prefix: string) {
  const baseDir = tempDirs.make(prefix);
  const mainWorkspace = await createWorkspace(baseDir, "main");
  const researchWorkspace = await createWorkspace(baseDir, "research");
  return { mainWorkspace, researchWorkspace };
}

function listMainResearchSkillCommands(params: {
  mainWorkspace: string;
  researchWorkspace: string;
}) {
  return listSkillCommandsForAgents({
    cfg: {
      agents: {
        list: [
          { id: "main", workspace: params.mainWorkspace, skills: ["demo-skill"] },
          { id: "research", workspace: params.researchWorkspace, skills: ["extra-skill"] },
        ],
      },
    },
    agentIds: ["main", "research"],
  });
}

function expectDemoAndExtraSkillCommands(commands: ReturnType<typeof listSkillCommandsForAgents>) {
  expect(commands.map((entry) => entry.skillName)).toEqual(["demo-skill", "extra-skill"]);
  expect(commands.map((entry) => entry.name)).toEqual(["demo_skill", "extra_skill"]);
}

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

vi.mock("../../auto-reply/commands-registry.data.js", () => ({
  getChatCommands: () => [],
}));

vi.mock("./command-specs.js", () => ({
  buildWorkspaceSkillCommandSpecs,
}));

vi.mock("../runtime/remote.js", () => ({
  getRemoteSkillEligibility: () => ({}),
}));

vi.mock("../../agents/exec-defaults.js", () => ({
  resolveNodeExecEligibility: resolveNodeExecEligibilityMock,
}));

vi.mock("./agent-filter.js", () => ({
  resolveEffectiveAgentSkillFilter: (
    cfg: {
      agents?: {
        defaults?: { skills?: string[] };
        list?: Array<{ id?: string; skills?: string[] }>;
      };
    },
    agentId: string,
  ) => {
    const agent = cfg.agents?.list?.find((entry) => entry.id === agentId);
    if (agent && Object.hasOwn(agent, "skills")) {
      return agent.skills;
    }
    return cfg.agents?.defaults?.skills;
  },
}));

beforeAll(async () => {
  ({
    listSkillCommandsForAgents,
    listSkillCommandsForWorkspace,
    resolveSkillCommandInvocation,
    resolveSkillReferenceInvocations,
  } = await import("./chat-commands.js"));
});

afterAll(() => {
  tempDirs.cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveNodeExecEligibilityMock.mockReturnValue({ canExec: false });
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

  it("preserves multiline args for /skill invocations", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/skill demo_skill first line\nsecond line",
      skillCommands: [{ name: "demo_skill", skillName: "demo-skill", description: "Demo" }],
    });
    expect(invocation?.command.name).toBe("demo_skill");
    expect(invocation?.args).toBe("first line\nsecond line");
  });

  it("preserves multiline args for direct skill slash invocations", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/demo_skill first line\nsecond line",
      skillCommands: [{ name: "demo_skill", skillName: "demo-skill", description: "Demo" }],
    });
    expect(invocation?.command.name).toBe("demo_skill");
    expect(invocation?.args).toBe("first line\nsecond line");
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

describe("resolveSkillReferenceInvocations", () => {
  const skillCommands = [
    { name: "demo_skill", skillName: "demo-skill", description: "Demo" },
    { name: "release_notes", skillName: "Release Notes", description: "Release notes" },
  ];

  it("resolves and deduplicates composable skill references", () => {
    expect(
      resolveSkillReferenceInvocations({
        text: "Use $demo_skill with $release-notes, then check $demo_skill again.",
        skillCommands,
      }).map((command) => command.name),
    ).toEqual(["demo_skill", "release_notes"]);
  });

  it("keeps trailing prose punctuation outside the skill reference", () => {
    expect(
      resolveSkillReferenceInvocations({
        text: "Use $demo_skill: then continue.",
        skillCommands,
      }).map((command) => command.name),
    ).toEqual(["demo_skill"]);
  });

  it("does not fall back to a shorter skill from a trailing hyphen", () => {
    expect(
      resolveSkillReferenceInvocations({
        text: "Use $demo_skill- later.",
        skillCommands,
      }),
    ).toEqual([]);
  });

  it("ignores common shell variables, escaped references, and unknown names", () => {
    expect(
      resolveSkillReferenceInvocations({
        text: String.raw`Keep $PATH and \$demo_skill literal; $unknown is not installed.`,
        skillCommands,
      }),
    ).toEqual([]);
  });

  it("keeps lowercase skill names that overlap common shell variables", () => {
    expect(
      resolveSkillReferenceInvocations({
        text: "Use $home but keep $HOME and $EDITOR literal.",
        skillCommands: [{ name: "home", skillName: "home", description: "Home automation" }],
      }).map((command) => command.name),
    ).toEqual(["home"]);
  });

  it("treats only odd backslash runs as escaping a reference", () => {
    expect(
      resolveSkillReferenceInvocations({
        text: String.raw`Ignore \$demo_skill but resolve \\$demo_skill.`,
        skillCommands,
      }).map((command) => command.name),
    ).toEqual(["demo_skill"]);
  });

  it("resolves explicitly referenced skills hidden from the model prompt", () => {
    expect(
      resolveSkillReferenceInvocations({
        text: "Use $hidden_skill.",
        skillCommands: [
          {
            name: "hidden_skill",
            skillName: "hidden-skill",
            description: "Slash only",
            modelVisible: false,
          },
        ],
      }).map((command) => command.name),
    ).toEqual(["hidden_skill"]);
  });
});

describe("listSkillCommandsForAgents", () => {
  it("deduplicates by skillName across agents, keeping the first registration", async () => {
    const { mainWorkspace, researchWorkspace } =
      await createMainAndResearchWorkspaces("openclaw-skills-");

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
    const baseDir = tempDirs.make("openclaw-skills-filter-");
    const researchWorkspace = await createWorkspace(baseDir, "research");

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
    const { mainWorkspace, researchWorkspace } =
      await createMainAndResearchWorkspaces("openclaw-skills-leak-");

    const commands = listMainResearchSkillCommands({ mainWorkspace, researchWorkspace });

    expectDemoAndExtraSkillCommands(commands);
  });

  it("merges allowlists for agents that share one workspace", async () => {
    const baseDir = tempDirs.make("openclaw-skills-shared-");
    const sharedWorkspace = await createWorkspace(baseDir, "research");

    const commands = listMainResearchSkillCommands({
      mainWorkspace: sharedWorkspace,
      researchWorkspace: sharedWorkspace,
    });

    expectDemoAndExtraSkillCommands(commands);
    expect(resolveNodeExecEligibilityMock.mock.calls.map(([params]) => params.agentId)).toEqual([
      "main",
      "research",
    ]);
  });

  it("deduplicates overlapping allowlists for shared workspace", async () => {
    const baseDir = tempDirs.make("openclaw-skills-overlap-");
    const sharedWorkspace = await createWorkspace(baseDir, "research");

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
    const baseDir = tempDirs.make("openclaw-skills-unfiltered-");
    const sharedWorkspace = await createWorkspace(baseDir, "research");

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
    const baseDir = tempDirs.make("openclaw-skills-empty-");
    const sharedWorkspace = await createWorkspace(baseDir, "research");

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
    const baseDir = tempDirs.make("openclaw-skills-defaults-");
    const sharedWorkspace = await createWorkspace(baseDir, "shared-defaults");

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
    const baseDir = tempDirs.make("openclaw-skills-defaults-empty-");
    const sharedWorkspace = await createWorkspace(baseDir, "shared-defaults");

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
    const baseDir = tempDirs.make("openclaw-skills-missing-");
    const validWorkspace = await createWorkspace(baseDir, "research");
    const missingWorkspace = path.join(baseDir, "nonexistent");

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
  it("inherits defaults when agentId is provided without an explicit skill filter", async () => {
    const baseDir = tempDirs.make("openclaw-skills-workspace-defaults-");
    const sharedWorkspace = await createWorkspace(baseDir, "shared-defaults");

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
      sessionEntry: { execHost: "node", execNode: "build-node" },
      sessionKey: "agent:alpha:main",
      execOverrides: { security: "allowlist" },
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["alpha-skill"]);
    expect(resolveNodeExecEligibilityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: { execHost: "node", execNode: "build-node" },
        sessionKey: "agent:alpha:main",
        execOverrides: { security: "allowlist" },
      }),
    );
  });
});
