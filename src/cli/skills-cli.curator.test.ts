import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSkillsCli } from "./skills-cli.js";

const mocks = vi.hoisted(() => {
  const output: unknown[] = [];
  return {
    callGateway: vi.fn(),
    config: {} as { gateway?: { mode: "local" | "remote" } },
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
vi.mock("../gateway/call.js", () => ({ callGateway: mocks.callGateway }));
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
  const program = new Command();
  program.exitOverride();
  registerSkillsCli(program);
  return program;
}

describe("skills curator cli", () => {
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

  it("surfaces remote gateway failures without mutating local state", async () => {
    mocks.config.gateway = { mode: "remote" };
    mocks.callGateway.mockRejectedValue(new Error("remote unavailable"));

    await expect(
      createProgram().parseAsync(["skills", "curator", "pin", "daily-brief", "--json"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");
    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith("Error: remote unavailable");
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
});
