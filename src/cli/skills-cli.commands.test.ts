import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSkillsCli } from "./skills-cli.js";

const mocks = vi.hoisted(() => {
  const runtimeLogs: string[] = [];
  const runtimeStdout: string[] = [];
  const runtimeErrors: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  const skillStatusReportFixture = {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/workspace/skills",
    skills: [
      {
        name: "calendar",
        description: "Calendar helpers",
        source: "bundled",
        bundled: false,
        filePath: "/tmp/workspace/skills/calendar/SKILL.md",
        baseDir: "/tmp/workspace/skills/calendar",
        skillKey: "calendar",
        emoji: "📅",
        homepage: "https://example.com/calendar",
        always: false,
        disabled: false,
        blockedByAllowlist: false,
        eligible: true,
        primaryEnv: "CALENDAR_API_KEY",
        requirements: {
          bins: [],
          anyBins: [],
          env: ["CALENDAR_API_KEY"],
          config: [],
          os: [],
        },
        missing: {
          bins: [],
          anyBins: [],
          env: [],
          config: [],
          os: [],
        },
        configChecks: [],
        install: [],
      },
    ],
  };
  const defaultRuntime = {
    log: vi.fn((...args: unknown[]) => {
      runtimeLogs.push(stringifyArgs(args));
    }),
    error: vi.fn((...args: unknown[]) => {
      runtimeErrors.push(stringifyArgs(args));
    }),
    writeStdout: vi.fn((value: string) => {
      runtimeStdout.push(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      runtimeStdout.push(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      if (code === 0) {
        return;
      }
      throw new Error(`__exit__:${code}`);
    }),
  };
  const buildWorkspaceSkillStatusMock = vi.fn((workspaceDir: string, options?: unknown) => {
    void workspaceDir;
    void options;
    return skillStatusReportFixture;
  });
  return {
    loadConfigMock: vi.fn(() => ({})),
    resolveDefaultAgentIdMock: vi.fn((configForTest: unknown) => "main"),
    resolveAgentIdByWorkspacePathMock: vi.fn(
      (configForTest: unknown, _workspacePath: string): string | undefined => undefined,
    ),
    resolveAgentWorkspaceDirMock: vi.fn(
      (configForTest: unknown, _agentId: string) => "/tmp/workspace",
    ),
    searchSkillsFromClawHubMock: vi.fn(),
    installSkillFromClawHubMock: vi.fn(),
    installSkillFromSourceMock: vi.fn(),
    updateSkillsFromClawHubMock: vi.fn(),
    readTrackedClawHubSkillSlugsMock: vi.fn(),
    buildWorkspaceSkillStatusMock,
    skillStatusReportFixture,
    defaultRuntime,
    runtimeLogs,
    runtimeStdout,
    runtimeErrors,
  };
});

const {
  loadConfigMock,
  resolveDefaultAgentIdMock,
  resolveAgentIdByWorkspacePathMock,
  resolveAgentWorkspaceDirMock,
  searchSkillsFromClawHubMock,
  installSkillFromClawHubMock,
  installSkillFromSourceMock,
  updateSkillsFromClawHubMock,
  readTrackedClawHubSkillSlugsMock,
  buildWorkspaceSkillStatusMock,
  skillStatusReportFixture,
  defaultRuntime,
  runtimeLogs,
  runtimeStdout,
  runtimeErrors,
} = mocks;

function mockCall(mock: unknown, index = 0): Array<unknown> {
  const calls = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock?.calls ?? [];
  const call = calls.at(index);
  if (!call) {
    throw new Error(`Expected mock call ${index + 1}`);
  }
  return call;
}

function mockFirstObjectArg(mock: unknown): Record<string, unknown> {
  const [arg] = mockCall(mock);
  if (!arg || typeof arg !== "object") {
    throw new Error("expected first mock argument object");
  }
  return arg as Record<string, unknown>;
}

function expectObjectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected object fields");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function expectLogger(value: unknown): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected logger object");
  }
}

function expectStatusWorkspaceCall(workspaceDir: string): void {
  const [actualWorkspaceDir, options] = mockCall(buildWorkspaceSkillStatusMock);
  expect(actualWorkspaceDir).toBe(workspaceDir);
  expectObjectFields(options, { config: {} });
}

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  CONFIG_DIR: "/tmp/openclaw-config",
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => mocks.loadConfigMock(),
  loadConfig: () => mocks.loadConfigMock(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentIdByWorkspacePath: (config: unknown, workspacePath: string) =>
    mocks.resolveAgentIdByWorkspacePathMock(config, workspacePath),
  resolveDefaultAgentId: (config: unknown) => mocks.resolveDefaultAgentIdMock(config),
  resolveAgentWorkspaceDir: (config: unknown, agentId: string) =>
    mocks.resolveAgentWorkspaceDirMock(config, agentId),
}));

vi.mock("../agents/skills-clawhub.js", () => ({
  searchSkillsFromClawHub: (...args: unknown[]) => mocks.searchSkillsFromClawHubMock(...args),
  installSkillFromClawHub: (...args: unknown[]) => mocks.installSkillFromClawHubMock(...args),
  updateSkillsFromClawHub: (...args: unknown[]) => mocks.updateSkillsFromClawHubMock(...args),
  readTrackedClawHubSkillSlugs: (...args: unknown[]) =>
    mocks.readTrackedClawHubSkillSlugsMock(...args),
}));

vi.mock("../agents/skills-source-install.js", () => ({
  installSkillFromSource: (...args: unknown[]) => mocks.installSkillFromSourceMock(...args),
  isSkillSourceInstallSpec: (raw: string) =>
    raw.startsWith("git:") ||
    raw.startsWith("./") ||
    raw.startsWith("../") ||
    raw.startsWith("~/") ||
    raw.startsWith("/"),
}));

vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: (workspaceDir: string, options?: unknown) =>
    mocks.buildWorkspaceSkillStatusMock(workspaceDir, options),
}));

describe("skills cli commands", () => {
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

  beforeEach(() => {
    runtimeLogs.length = 0;
    runtimeStdout.length = 0;
    runtimeErrors.length = 0;
    loadConfigMock.mockReset();
    resolveDefaultAgentIdMock.mockReset();
    resolveAgentIdByWorkspacePathMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    searchSkillsFromClawHubMock.mockReset();
    installSkillFromClawHubMock.mockReset();
    installSkillFromSourceMock.mockReset();
    updateSkillsFromClawHubMock.mockReset();
    readTrackedClawHubSkillSlugsMock.mockReset();
    buildWorkspaceSkillStatusMock.mockReset();

    loadConfigMock.mockReturnValue({});
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentIdByWorkspacePathMock.mockReturnValue(undefined);
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    searchSkillsFromClawHubMock.mockResolvedValue([]);
    installSkillFromClawHubMock.mockResolvedValue({
      ok: false,
      error: "install disabled in test",
    });
    installSkillFromSourceMock.mockResolvedValue({
      ok: false,
      error: "source install disabled in test",
    });
    updateSkillsFromClawHubMock.mockResolvedValue([]);
    readTrackedClawHubSkillSlugsMock.mockResolvedValue([]);
    buildWorkspaceSkillStatusMock.mockReturnValue(skillStatusReportFixture);
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  async function withCwd(cwd: string, run: () => Promise<void>) {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    try {
      await run();
    } finally {
      cwdSpy.mockRestore();
    }
  }

  function routeWorkspaceByAgent() {
    resolveAgentWorkspaceDirMock.mockImplementation(
      (configForTest: unknown, agentId: string) => `/tmp/workspace-${agentId}`,
    );
  }

  it("searches ClawHub skills from the native CLI", async () => {
    searchSkillsFromClawHubMock.mockResolvedValue([
      {
        slug: "calendar",
        displayName: "Calendar",
        summary: "CalDAV helpers",
        version: "1.2.3",
      },
    ]);

    await runCommand(["skills", "search", "calendar"]);

    expect(searchSkillsFromClawHubMock).toHaveBeenCalledWith({
      query: "calendar",
      limit: undefined,
    });
    expect(
      runtimeLogs.some((line) => line.includes("calendar v1.2.3  Calendar")),
      "search result log",
    ).toBe(true);
  });

  it("rejects partial numeric search limits", async () => {
    await expect(runCommand(["skills", "search", "calendar", "--limit", "10ms"])).rejects.toThrow(
      "--limit must be a positive integer.",
    );
    expect(searchSkillsFromClawHubMock).not.toHaveBeenCalled();
  });

  it("installs a skill from ClawHub into the active workspace", async () => {
    installSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: "calendar",
      version: "1.2.3",
      targetDir: "/tmp/workspace/skills/calendar",
    });

    await runCommand(["skills", "install", "calendar", "--version", "1.2.3"]);

    const installArgs = mockFirstObjectArg(installSkillFromClawHubMock);
    expectObjectFields(installArgs, {
      workspaceDir: "/tmp/workspace",
      slug: "calendar",
      version: "1.2.3",
      force: false,
    });
    expectLogger(installArgs.logger);
    expect(
      runtimeLogs.some((line) =>
        line.includes("Installed calendar@1.2.3 -> /tmp/workspace/skills/calendar"),
      ),
    ).toBe(true);
  });

  it("installs a skill from a git source into the active workspace", async () => {
    installSkillFromSourceMock.mockResolvedValue({
      ok: true,
      slug: "tools",
      targetDir: "/tmp/workspace/skills/tools",
      source: "git",
    });

    await runCommand(["skills", "install", "git:owner/tools"]);

    const installArgs = mockFirstObjectArg(installSkillFromSourceMock);
    expectObjectFields(installArgs, {
      workspaceDir: "/tmp/workspace",
      spec: "git:owner/tools",
      force: false,
    });
    expect(installArgs.slug).toBeUndefined();
    expectLogger(installArgs.logger);
    expect(installSkillFromClawHubMock).not.toHaveBeenCalled();
    expect(
      runtimeLogs.some((line) =>
        line.includes("Installed tools from git -> /tmp/workspace/skills/tools"),
      ),
    ).toBe(true);
  });

  it("accepts git refs for skill source installs", async () => {
    installSkillFromSourceMock.mockResolvedValue({
      ok: true,
      slug: "tools",
      targetDir: "/tmp/workspace/skills/tools",
      source: "git",
    });

    await runCommand(["skills", "install", "git:owner/tools@main"]);

    expect(mockFirstObjectArg(installSkillFromSourceMock).spec).toBe("git:owner/tools@main");
    expect(installSkillFromClawHubMock).not.toHaveBeenCalled();
  });

  it("installs a skill from a local directory", async () => {
    installSkillFromSourceMock.mockResolvedValue({
      ok: true,
      slug: "local-skill",
      targetDir: "/tmp/workspace/skills/local-skill",
      source: "path",
    });

    await runCommand(["skills", "install", "./local-skill"]);

    const installArgs = mockFirstObjectArg(installSkillFromSourceMock);
    expectObjectFields(installArgs, {
      workspaceDir: "/tmp/workspace",
      spec: "./local-skill",
      force: false,
    });
    expect(installArgs.slug).toBeUndefined();
    expectLogger(installArgs.logger);
    expect(installSkillFromClawHubMock).not.toHaveBeenCalled();
    expect(
      runtimeLogs.some((line) =>
        line.includes("Installed local-skill from path -> /tmp/workspace/skills/local-skill"),
      ),
    ).toBe(true);
  });

  it("passes --as as the source install slug override", async () => {
    installSkillFromSourceMock.mockResolvedValue({
      ok: true,
      slug: "custom-name",
      targetDir: "/tmp/workspace/skills/custom-name",
      source: "path",
    });

    await runCommand(["skills", "install", "./local-skill", "--as", "custom-name"]);

    expectObjectFields(mockFirstObjectArg(installSkillFromSourceMock), {
      spec: "./local-skill",
      slug: "custom-name",
    });
  });

  it("rejects --version for git and local source installs", async () => {
    await expect(
      runCommand(["skills", "install", "git:owner/tools", "--version", "1.2.3"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain("--version is only supported for ClawHub skill installs.");
    expect(installSkillFromClawHubMock).not.toHaveBeenCalled();
    expect(installSkillFromSourceMock).not.toHaveBeenCalled();
  });

  it("installs a skill into the cwd-inferred agent workspace", async () => {
    routeWorkspaceByAgent();
    resolveAgentIdByWorkspacePathMock.mockReturnValue("writer");
    installSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: "calendar",
      version: "1.2.3",
      targetDir: "/tmp/workspace-writer/skills/calendar",
    });

    await withCwd("/tmp/workspace-writer/project", async () => {
      await runCommand(["skills", "install", "calendar"]);
    });

    expect(resolveAgentIdByWorkspacePathMock).toHaveBeenCalledWith(
      {},
      "/tmp/workspace-writer/project",
    );
    expect(mockFirstObjectArg(installSkillFromClawHubMock).workspaceDir).toBe(
      "/tmp/workspace-writer",
    );
  });

  it("lets --agent override cwd-inferred workspace for installs", async () => {
    routeWorkspaceByAgent();
    resolveAgentIdByWorkspacePathMock.mockReturnValue("writer");
    installSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: "calendar",
      version: "1.2.3",
      targetDir: "/tmp/workspace-main/skills/calendar",
    });

    await withCwd("/tmp/workspace-writer", async () => {
      await runCommand(["skills", "install", "calendar", "--agent", "main"]);
    });

    expect(resolveAgentIdByWorkspacePathMock).not.toHaveBeenCalled();
    expect(resolveAgentWorkspaceDirMock).toHaveBeenCalledWith({}, "main");
    expect(mockFirstObjectArg(installSkillFromClawHubMock).workspaceDir).toBe(
      "/tmp/workspace-main",
    );
  });

  it("honors parent --agent for subcommands", async () => {
    routeWorkspaceByAgent();
    installSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: "calendar",
      version: "1.2.3",
      targetDir: "/tmp/workspace-writer/skills/calendar",
    });

    await runCommand(["skills", "--agent", "writer", "install", "calendar"]);

    expect(resolveAgentWorkspaceDirMock).toHaveBeenCalledWith({}, "writer");
    expect(mockFirstObjectArg(installSkillFromClawHubMock).workspaceDir).toBe(
      "/tmp/workspace-writer",
    );
  });

  it("installs a skill into the shared global skills directory", async () => {
    installSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: "calendar",
      version: "1.2.3",
      targetDir: "/tmp/openclaw-config/skills/calendar",
    });

    await runCommand(["skills", "install", "calendar", "--global"]);

    expect(resolveAgentIdByWorkspacePathMock).not.toHaveBeenCalled();
    expect(resolveDefaultAgentIdMock).not.toHaveBeenCalled();
    expect(resolveAgentWorkspaceDirMock).not.toHaveBeenCalled();
    expect(installSkillFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/openclaw-config",
      }),
    );
  });

  it("rejects using --global and --agent together for installs", async () => {
    await expect(
      runCommand(["skills", "install", "calendar", "--global", "--agent", "main"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain("Use either --global or --agent, not both.");
    expect(installSkillFromClawHubMock).not.toHaveBeenCalled();
  });

  it("rejects using parent --agent with install --global", async () => {
    await expect(
      runCommand(["skills", "--agent", "writer", "install", "calendar", "--global"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain("Use either --global or --agent, not both.");
    expect(installSkillFromClawHubMock).not.toHaveBeenCalled();
  });

  it("updates all tracked ClawHub skills", async () => {
    readTrackedClawHubSkillSlugsMock.mockResolvedValue(["calendar"]);
    updateSkillsFromClawHubMock.mockResolvedValue([
      {
        ok: true,
        slug: "calendar",
        previousVersion: "1.2.2",
        version: "1.2.3",
        changed: true,
        targetDir: "/tmp/workspace/skills/calendar",
      },
    ]);

    await runCommand(["skills", "update", "--all"]);

    expect(readTrackedClawHubSkillSlugsMock).toHaveBeenCalledWith("/tmp/workspace");
    const updateAllArgs = mockFirstObjectArg(updateSkillsFromClawHubMock);
    expectObjectFields(updateAllArgs, {
      workspaceDir: "/tmp/workspace",
      slug: undefined,
    });
    expectLogger(updateAllArgs.logger);
    expect(
      runtimeLogs.some((line) => line.includes("Updated calendar: 1.2.2 -> 1.2.3")),
      "update result log",
    ).toBe(true);
    expect(runtimeErrors).toStrictEqual([]);
  });

  it("updates tracked ClawHub skills in the cwd-inferred agent workspace", async () => {
    routeWorkspaceByAgent();
    resolveAgentIdByWorkspacePathMock.mockReturnValue("writer");
    readTrackedClawHubSkillSlugsMock.mockResolvedValue(["calendar"]);
    updateSkillsFromClawHubMock.mockResolvedValue([
      {
        ok: true,
        slug: "calendar",
        previousVersion: "1.2.2",
        version: "1.2.3",
        changed: true,
        targetDir: "/tmp/workspace-writer/skills/calendar",
      },
    ]);

    await withCwd("/tmp/workspace-writer", async () => {
      await runCommand(["skills", "update", "--all"]);
    });

    expect(readTrackedClawHubSkillSlugsMock).toHaveBeenCalledWith("/tmp/workspace-writer");
    const updateInferredArgs = mockFirstObjectArg(updateSkillsFromClawHubMock);
    expectObjectFields(updateInferredArgs, {
      workspaceDir: "/tmp/workspace-writer",
      slug: undefined,
    });
    expectLogger(updateInferredArgs.logger);
  });

  it("lets --agent override cwd-inferred workspace for updates", async () => {
    routeWorkspaceByAgent();
    resolveAgentIdByWorkspacePathMock.mockReturnValue("writer");
    readTrackedClawHubSkillSlugsMock.mockResolvedValue(["calendar"]);
    updateSkillsFromClawHubMock.mockResolvedValue([
      {
        ok: true,
        slug: "calendar",
        previousVersion: "1.2.2",
        version: "1.2.3",
        changed: true,
        targetDir: "/tmp/workspace-main/skills/calendar",
      },
    ]);

    await withCwd("/tmp/workspace-writer", async () => {
      await runCommand(["skills", "update", "calendar", "--agent", "main"]);
    });

    expect(resolveAgentIdByWorkspacePathMock).not.toHaveBeenCalled();
    const updateOverrideArgs = mockFirstObjectArg(updateSkillsFromClawHubMock);
    expectObjectFields(updateOverrideArgs, {
      workspaceDir: "/tmp/workspace-main",
      slug: "calendar",
    });
    expectLogger(updateOverrideArgs.logger);
  });

  it("updates tracked ClawHub skills in the shared global skills directory", async () => {
    readTrackedClawHubSkillSlugsMock.mockResolvedValue(["calendar"]);
    updateSkillsFromClawHubMock.mockResolvedValue([
      {
        ok: true,
        slug: "calendar",
        previousVersion: "1.2.2",
        version: "1.2.3",
        changed: true,
        targetDir: "/tmp/openclaw-config/skills/calendar",
      },
    ]);

    await runCommand(["skills", "update", "--all", "--global"]);

    expect(resolveAgentIdByWorkspacePathMock).not.toHaveBeenCalled();
    expect(resolveDefaultAgentIdMock).not.toHaveBeenCalled();
    expect(resolveAgentWorkspaceDirMock).not.toHaveBeenCalled();
    expect(readTrackedClawHubSkillSlugsMock).toHaveBeenCalledWith("/tmp/openclaw-config");
    expect(updateSkillsFromClawHubMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/openclaw-config",
      slug: undefined,
      logger: expect.any(Object),
    });
  });

  it("updates a single tracked ClawHub skill in the shared global skills directory", async () => {
    readTrackedClawHubSkillSlugsMock.mockResolvedValue(["calendar"]);
    updateSkillsFromClawHubMock.mockResolvedValue([
      {
        ok: true,
        slug: "calendar",
        previousVersion: "1.2.2",
        version: "1.2.3",
        changed: true,
        targetDir: "/tmp/openclaw-config/skills/calendar",
      },
    ]);

    await runCommand(["skills", "update", "calendar", "--global"]);

    expect(resolveAgentIdByWorkspacePathMock).not.toHaveBeenCalled();
    expect(resolveDefaultAgentIdMock).not.toHaveBeenCalled();
    expect(resolveAgentWorkspaceDirMock).not.toHaveBeenCalled();
    expect(readTrackedClawHubSkillSlugsMock).toHaveBeenCalledWith("/tmp/openclaw-config");
    expect(updateSkillsFromClawHubMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/openclaw-config",
      slug: "calendar",
      logger: expect.any(Object),
    });
  });

  it("rejects using --global and --agent together for updates", async () => {
    await expect(
      runCommand(["skills", "update", "--all", "--global", "--agent", "main"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain("Use either --global or --agent, not both.");
    expect(readTrackedClawHubSkillSlugsMock).not.toHaveBeenCalled();
    expect(updateSkillsFromClawHubMock).not.toHaveBeenCalled();
  });

  it("rejects using parent --agent with update --global", async () => {
    await expect(
      runCommand(["skills", "--agent", "writer", "update", "--all", "--global"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain("Use either --global or --agent, not both.");
    expect(readTrackedClawHubSkillSlugsMock).not.toHaveBeenCalled();
    expect(updateSkillsFromClawHubMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "list",
      argv: ["skills", "list", "--json"],
      assert: (payload: Record<string, unknown>) => {
        const skills = payload.skills as Array<Record<string, unknown>>;
        expect(skills).toHaveLength(1);
        expect(skills[0]?.name).toBe("calendar");
      },
    },
    {
      label: "info",
      argv: ["skills", "info", "calendar", "--json"],
      assert: (payload: Record<string, unknown>) => {
        expect(payload.name).toBe("calendar");
        expect(payload.primaryEnv).toBe("CALENDAR_API_KEY");
      },
    },
    {
      label: "check",
      argv: ["skills", "check", "--json"],
      assert: (payload: Record<string, unknown>) => {
        expectObjectFields(payload.summary, {
          total: 1,
          eligible: 1,
        });
      },
    },
  ])("routes skills $label JSON output through stdout", async ({ argv, assert }) => {
    await runCommand(argv);

    expectStatusWorkspaceCall("/tmp/workspace");
    expect(defaultRuntime.writeStdout).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    expect(defaultRuntime.log).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(runtimeErrors).toStrictEqual([]);
    expect(runtimeStdout).toHaveLength(1);

    const payload = JSON.parse(runtimeStdout.at(-1) ?? "{}") as Record<string, unknown>;
    assert(payload);
  });

  it.each([
    ["list", ["skills", "list", "--json"]],
    ["info", ["skills", "info", "calendar", "--json"]],
    ["check", ["skills", "check", "--json"]],
    ["default", ["skills"]],
  ])("routes skills %s through the cwd-inferred agent workspace", async (_label, argv) => {
    routeWorkspaceByAgent();
    resolveAgentIdByWorkspacePathMock.mockReturnValue("writer");

    await withCwd("/tmp/workspace-writer", async () => {
      await runCommand(argv);
    });

    expectStatusWorkspaceCall("/tmp/workspace-writer");
  });

  it.each([
    ["list", ["skills", "list", "--agent", "writer", "--json"]],
    ["info", ["skills", "info", "calendar", "--agent", "writer", "--json"]],
    ["check", ["skills", "check", "--agent", "writer", "--json"]],
    ["default", ["skills", "--agent", "writer"]],
  ])("routes skills %s through the explicit agent workspace", async (_label, argv) => {
    routeWorkspaceByAgent();
    resolveAgentIdByWorkspacePathMock.mockReturnValue("main");

    await withCwd("/tmp/workspace-main", async () => {
      await runCommand(argv);
    });

    expect(resolveAgentIdByWorkspacePathMock).not.toHaveBeenCalled();
    expectStatusWorkspaceCall("/tmp/workspace-writer");
  });

  it("falls back to the default agent outside configured workspaces", async () => {
    routeWorkspaceByAgent();
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentIdByWorkspacePathMock.mockReturnValue(undefined);

    await withCwd("/tmp/unrelated", async () => {
      await runCommand(["skills", "list", "--json"]);
    });

    expect(resolveAgentIdByWorkspacePathMock).toHaveBeenCalledWith({}, "/tmp/unrelated");
    expect(resolveDefaultAgentIdMock).toHaveBeenCalledWith({});
    expectStatusWorkspaceCall("/tmp/workspace-main");
  });

  it("keeps non-JSON skills list output on stdout with human-readable formatting", async () => {
    await runCommand(["skills", "list"]);

    expect(defaultRuntime.writeStdout).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.log).not.toHaveBeenCalled();
    expect(runtimeErrors).toStrictEqual([]);
    expect(runtimeStdout.at(-1)).toContain("calendar");
    expect(runtimeStdout.at(-1)).toContain("openclaw skills search");
  });
});
