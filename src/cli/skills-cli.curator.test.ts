import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSkillsCli } from "./skills-cli.js";

const mocks = vi.hoisted(() => {
  const output: unknown[] = [];
  return {
    callGateway: vi.fn(),
    config: {} as { gateway?: { mode: "local" | "remote" } },
    getSkillCuratorStatus: vi.fn(),
    pinCuratedSkill: vi.fn(),
    restoreCuratedSkill: vi.fn(),
    unpinCuratedSkill: vi.fn(),
    output,
    defaultRuntime: {
      log: vi.fn(),
      error: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn((value: unknown) => output.push(value)),
      exit: vi.fn((code: number) => {
        throw new Error(`__exit__:${code}`);
      }),
    },
  };
});

vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.defaultRuntime }));
vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
  isImplicitLocalGatewayTarget: async ({ config }: { config?: { gateway?: { mode?: string } } }) =>
    !process.env.OPENCLAW_GATEWAY_URL && config?.gateway?.mode !== "remote",
}));
vi.mock("../skills/workshop/curator.js", () => ({
  getSkillCuratorStatus: mocks.getSkillCuratorStatus,
  pinCuratedSkill: mocks.pinCuratedSkill,
  restoreCuratedSkill: mocks.restoreCuratedSkill,
  unpinCuratedSkill: mocks.unpinCuratedSkill,
}));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => mocks.config,
  resetConfigRuntimeState: () => undefined,
}));
vi.mock("../terminal/links.js", () => ({ formatDocsLink: () => "docs.openclaw.ai/cli/skills" }));
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

const status = {
  lastAttemptAtMs: 1,
  lastSuccessAtMs: 1,
  lastError: null,
  collectionReview: {
    workspace1: { attemptedAtMs: Date.now() - 60_000, succeededAtMs: Date.now() - 30_000 },
  },
  experienceReview: {
    workspace1: {
      attemptedAtMs: Date.now() - 15_000,
      outcome: "proposed" as const,
      proposalId: "proposal-1",
    },
  },
  counts: { active: 1, stale: 0, archived: 0 },
  skills: [
    {
      skillFile: "/workspace/skills/daily-brief/SKILL.md",
      skillKey: "daily-brief",
      skillName: "Daily Brief",
      state: "active",
      pinned: false,
      createdAtMs: 1,
      stateChangedAtMs: 1,
      lastUsedAtMs: null,
      useCount: 0,
      archivedReason: null,
    },
  ],
  overlaps: [],
};

function createProgram(): Command {
  const program = new Command().enablePositionalOptions();
  program.exitOverride();
  registerSkillsCli(program);
  return program;
}

describe("skills curator cli", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    delete mocks.config.gateway;
    mocks.output.length = 0;
    mocks.callGateway.mockReset().mockImplementation(async (request: { method: string }) => {
      if (request.method === "skills.curator.status") {
        return status;
      }
      return { ...status.skills[0], pinned: request.method === "skills.curator.pin" };
    });
    mocks.defaultRuntime.writeJson.mockClear();
    mocks.defaultRuntime.writeStdout.mockClear();
    mocks.defaultRuntime.error.mockClear();
    mocks.getSkillCuratorStatus.mockReset().mockReturnValue(status);
    mocks.pinCuratedSkill.mockReset().mockReturnValue(status.skills[0]);
    mocks.restoreCuratedSkill.mockReset().mockReturnValue(status.skills[0]);
    mocks.unpinCuratedSkill.mockReset().mockReturnValue(status.skills[0]);
  });

  it("uses a parent --json when the leaf has its default false value", async () => {
    await createProgram().parseAsync(["skills", "curator", "--json", "status"], {
      from: "user",
    });

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith(status);
  });

  it("uses --json for the default curator action", async () => {
    await createProgram().parseAsync(["skills", "curator", "--json"], { from: "user" });

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith(status);
  });

  it("supports status, pin, unpin, and restore JSON paths", async () => {
    for (const argv of [
      ["skills", "curator", "status", "--json"],
      ["skills", "curator", "pin", "daily-brief", "--json"],
      ["skills", "curator", "unpin", "daily-brief", "--json"],
      ["skills", "curator", "restore", "daily-brief", "--json"],
    ]) {
      await createProgram().parseAsync(argv, { from: "user" });
    }

    expect(mocks.callGateway.mock.calls.map(([request]) => request.method)).toEqual([
      "skills.curator.status",
      "skills.curator.pin",
      "skills.curator.unpin",
      "skills.curator.restore",
    ]);
    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledTimes(4);
    expect(mocks.output).toHaveLength(4);
  });

  const curatorActions = [
    { label: "status", argv: ["status"] },
    { label: "pin", argv: ["pin", "daily-brief"] },
    { label: "unpin", argv: ["unpin", "daily-brief"] },
    { label: "restore", argv: ["restore", "daily-brief"] },
  ];

  it.each(["configured remote", "environment-selected"] as const)(
    "does not touch local curator state after a %s gateway fails",
    async (target) => {
      if (target === "configured remote") {
        mocks.config.gateway = { mode: "remote" };
      } else {
        vi.stubEnv("OPENCLAW_GATEWAY_URL", "ws://127.0.0.1:9");
      }
      mocks.callGateway.mockRejectedValue(new Error("remote unavailable"));

      for (const action of curatorActions) {
        const failure = await createProgram()
          .parseAsync(["skills", "curator", ...action.argv, "--json"], { from: "user" })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(failure, action.label).toMatchObject({ message: "__exit__:1" });
      }

      expect(mocks.defaultRuntime.error).toHaveBeenCalledTimes(curatorActions.length);
      expect(mocks.defaultRuntime.error).toHaveBeenCalledWith("remote unavailable");
      expect(mocks.getSkillCuratorStatus).not.toHaveBeenCalled();
      expect(mocks.pinCuratedSkill).not.toHaveBeenCalled();
      expect(mocks.unpinCuratedSkill).not.toHaveBeenCalled();
      expect(mocks.restoreCuratedSkill).not.toHaveBeenCalled();
    },
  );

  it("retains local curator status and mutations for an offline implicit local gateway", async () => {
    mocks.callGateway.mockRejectedValue(new Error("local gateway unavailable"));

    for (const action of curatorActions) {
      await createProgram().parseAsync(["skills", "curator", ...action.argv, "--json"], {
        from: "user",
      });
    }

    expect(mocks.getSkillCuratorStatus).toHaveBeenCalledOnce();
    expect(mocks.pinCuratedSkill).toHaveBeenCalledWith("daily-brief");
    expect(mocks.unpinCuratedSkill).toHaveBeenCalledWith("daily-brief");
    expect(mocks.restoreCuratedSkill).toHaveBeenCalledWith("daily-brief");
  });

  it("disambiguates duplicate skill keys in text status", async () => {
    mocks.callGateway.mockResolvedValue({
      ...status,
      skills: [
        status.skills[0],
        {
          ...status.skills[0],
          skillFile: "/other-workspace/skills/daily-brief/SKILL.md",
        },
      ],
    });

    await createProgram().parseAsync(["skills", "curator", "status"], { from: "user" });

    expect(mocks.defaultRuntime.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("daily-brief (/workspace/skills/daily-brief/SKILL.md)  active"),
    );
    expect(mocks.defaultRuntime.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("daily-brief (/other-workspace/skills/daily-brief/SKILL.md)  active"),
    );
  });

  it("prints the last collection and experience outcomes", async () => {
    await createProgram().parseAsync(["skills", "curator", "status"], { from: "user" });
    expect(mocks.defaultRuntime.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("Collection review workspac"),
    );
    expect(mocks.defaultRuntime.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("Experience review workspac: proposed (proposal-1)"),
    );
  });
});
