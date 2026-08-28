// Skills CLI command tests cover skill command registration and subcommand behavior.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import {
  AgentSelectionRequiredError,
  resolveConfiguredAgentId,
  type AgentSelectionContext,
} from "../agents/agent-scope-config.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { registerSkillsCli } from "./skills-cli.js";

const ORIGINAL_STDIN_TTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const ORIGINAL_STDOUT_TTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

function restoreTty(): void {
  if (ORIGINAL_STDIN_TTY) {
    Object.defineProperty(process.stdin, "isTTY", ORIGINAL_STDIN_TTY);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
  if (ORIGINAL_STDOUT_TTY) {
    Object.defineProperty(process.stdout, "isTTY", ORIGINAL_STDOUT_TTY);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
}

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
    callGatewayMock: vi.fn(),
    loadConfigMock: vi.fn((_options?: unknown) => ({})),
    resolveDefaultAgentIdMock: vi.fn(
      (_configForTest: unknown, _context?: AgentSelectionContext) => "main",
    ),
    resolveAgentIdByWorkspacePathMock: vi.fn(
      (_configForTest: unknown, _workspacePath: string): string | undefined => undefined,
    ),
    resolveConfiguredAgentIdMock: vi.fn(
      (_configForTest: unknown, agentId: string): string => agentId,
    ),
    resolveAgentWorkspaceDirMock: vi.fn(
      (_configForTest: unknown, _agentId: string) => "/tmp/workspace",
    ),
    searchSkillsFromClawHubMock: vi.fn(),
    installSkillFromClawHubMock: vi.fn(),
    installSkillFromSourceMock: vi.fn(),
    updateSkillsFromClawHubMock: vi.fn(),
    readTrackedClawHubSkillSlugsMock: vi.fn(),
    readVerifiedClawHubSkillSourceUrlMock: vi.fn(),
    resolveClawHubSkillVerificationTargetMock: vi.fn(),
    readClawHubSkillsLockfileStatusSyncMock: vi.fn((..._args: unknown[]) => ({ kind: "missing" })),
    resolveClawHubSkillStatusLinkSyncMock: vi.fn(),
    resolveLocalSkillCardStatusSyncMock: vi.fn(),
    verifySkillWithClawHubMock: vi.fn(),
    fetchClawHubSkillCardMock: vi.fn(),
    buildWorkspaceSkillStatusMock,
    skillStatusReportFixture,
    defaultRuntime,
    runtimeLogs,
    runtimeStdout,
    runtimeErrors,
  };
});

const {
  callGatewayMock,
  loadConfigMock,
  resolveDefaultAgentIdMock,
  resolveAgentIdByWorkspacePathMock,
  resolveConfiguredAgentIdMock,
  resolveAgentWorkspaceDirMock,
  searchSkillsFromClawHubMock,
  installSkillFromClawHubMock,
  installSkillFromSourceMock,
  updateSkillsFromClawHubMock,
  readTrackedClawHubSkillSlugsMock,
  readVerifiedClawHubSkillSourceUrlMock,
  resolveClawHubSkillVerificationTargetMock,
  readClawHubSkillsLockfileStatusSyncMock,
  resolveClawHubSkillStatusLinkSyncMock,
  resolveLocalSkillCardStatusSyncMock,
  verifySkillWithClawHubMock,
  fetchClawHubSkillCardMock,
  buildWorkspaceSkillStatusMock,
  skillStatusReportFixture,
  defaultRuntime,
  runtimeLogs,
  runtimeStdout,
  runtimeErrors,
} = mocks;

function primeSkillVerification(overrides: Record<string, unknown> = {}) {
  return verifySkillWithClawHubMock.mockResolvedValueOnce({
    ok: true,
    value: {
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      skill: { slug: "agentreceipt" },
      publisher: null,
      version: { version: "1.2.3" },
      card: { available: true },
      artifact: null,
      provenance: null,
      security: { status: "clean" },
      signature: { status: "unsigned" },
      ...overrides,
    },
  });
}

afterEach(() => {
  restoreTty();
  vi.unstubAllEnvs();
});

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

function requireCommand(parent: Command, name: string): Command {
  const command = parent.commands.find((candidate) => candidate.name() === name);
  if (!command) {
    throw new Error(`missing command: ${name}`);
  }
  return command;
}

function expectStatusWorkspaceCall(workspaceDir: string): void {
  const [actualWorkspaceDir, options] = mockCall(buildWorkspaceSkillStatusMock);
  expect(actualWorkspaceDir).toBe(workspaceDir);
  expectObjectFields(options, { config: {} });
}

function primeCalendarInstall(workspaceDir = "/tmp/workspace"): void {
  installSkillFromClawHubMock.mockResolvedValue({
    ok: true,
    slug: "calendar",
    version: "1.2.3",
    targetDir: `${workspaceDir}/skills/calendar`,
  });
}

function primeCalendarUpdate(workspaceDir = "/tmp/workspace"): void {
  readTrackedClawHubSkillSlugsMock.mockResolvedValue(["calendar"]);
  updateSkillsFromClawHubMock.mockResolvedValue([
    {
      ok: true,
      slug: "calendar",
      previousVersion: "1.2.2",
      version: "1.2.3",
      changed: true,
      targetDir: `${workspaceDir}/skills/calendar`,
    },
  ]);
}

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => mocks.callGatewayMock(...args),
  isGatewayClientRequestError: (error: unknown) =>
    error instanceof Error && error.name === "GatewayClientRequestError",
  isGatewayCredentialsRequiredError: (error: unknown) =>
    error instanceof Error && error.name === "GatewayCredentialsRequiredError",
  isImplicitLocalGatewayTarget: async ({ config }: { config?: { gateway?: { mode?: string } } }) =>
    !process.env.OPENCLAW_GATEWAY_URL && config?.gateway?.mode !== "remote",
}));

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  CONFIG_DIR: "/tmp/openclaw-config",
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: (...args: unknown[]) => mocks.loadConfigMock(...args),
  loadConfig: () => mocks.loadConfigMock(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentIdByWorkspacePath: (config: unknown, workspacePath: string) =>
    mocks.resolveAgentIdByWorkspacePathMock(config, workspacePath),
  resolveConfiguredAgentId: (config: unknown, agentId: string) =>
    mocks.resolveConfiguredAgentIdMock(config, agentId),
  resolveDefaultAgentId: (config: unknown, context?: AgentSelectionContext) =>
    mocks.resolveDefaultAgentIdMock(config, context),
  resolveAgentWorkspaceDir: (config: unknown, agentId: string) =>
    mocks.resolveAgentWorkspaceDirMock(config, agentId),
}));

vi.mock("../skills/lifecycle/clawhub.js", () => ({
  searchSkillsFromClawHub: (...args: unknown[]) => mocks.searchSkillsFromClawHubMock(...args),
  installSkillFromClawHub: (...args: unknown[]) => mocks.installSkillFromClawHubMock(...args),
  updateSkillsFromClawHub: (...args: unknown[]) => mocks.updateSkillsFromClawHubMock(...args),
  readTrackedClawHubSkillSlugs: (...args: unknown[]) =>
    mocks.readTrackedClawHubSkillSlugsMock(...args),
  readVerifiedClawHubSkillSourceUrl: (...args: unknown[]) =>
    mocks.readVerifiedClawHubSkillSourceUrlMock(...args),
  resolveClawHubSkillVerificationTarget: (...args: unknown[]) =>
    mocks.resolveClawHubSkillVerificationTargetMock(...args),
  readClawHubSkillsLockfileStatusSync: (...args: unknown[]) =>
    mocks.readClawHubSkillsLockfileStatusSyncMock(...args),
  resolveClawHubSkillStatusLinkSync: (...args: unknown[]) =>
    mocks.resolveClawHubSkillStatusLinkSyncMock(...args),
  resolveLocalSkillCardStatusSync: (...args: unknown[]) =>
    mocks.resolveLocalSkillCardStatusSyncMock(...args),
  verifySkillWithClawHub: (...args: unknown[]) => mocks.verifySkillWithClawHubMock(...args),
}));

vi.mock("../infra/clawhub-skills.js", () => ({
  CLAWHUB_SKILLS_SH_REF_PREFIX: "skills-sh:",
  CLAWHUB_SKILLS_SH_TRUST_LABEL: "Not scanned by ClawHub",
  CLAWHUB_SKILLS_SH_TRUST_STATE: "not-scanned-by-clawhub",
  fetchClawHubSkillCard: (...args: unknown[]) => mocks.fetchClawHubSkillCardMock(...args),
}));

vi.mock("../skills/lifecycle/source-install.js", () => ({
  installSkillFromSource: (...args: unknown[]) => mocks.installSkillFromSourceMock(...args),
  isSkillSourceInstallSpec: (raw: string) =>
    raw.startsWith("git:") ||
    raw.startsWith("./") ||
    raw.startsWith("../") ||
    raw.startsWith("~/") ||
    raw.startsWith("/"),
}));

vi.mock("../skills/discovery/status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/discovery/status.js")>()),
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
    callGatewayMock.mockReset();
    loadConfigMock.mockReset();
    resolveDefaultAgentIdMock.mockReset();
    resolveAgentIdByWorkspacePathMock.mockReset();
    resolveConfiguredAgentIdMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    searchSkillsFromClawHubMock.mockReset();
    installSkillFromClawHubMock.mockReset();
    installSkillFromSourceMock.mockReset();
    updateSkillsFromClawHubMock.mockReset();
    readTrackedClawHubSkillSlugsMock.mockReset();
    readVerifiedClawHubSkillSourceUrlMock.mockReset();
    resolveClawHubSkillVerificationTargetMock.mockReset();
    readClawHubSkillsLockfileStatusSyncMock.mockReset();
    resolveClawHubSkillStatusLinkSyncMock.mockReset();
    resolveLocalSkillCardStatusSyncMock.mockReset();
    verifySkillWithClawHubMock.mockReset();
    fetchClawHubSkillCardMock.mockReset();
    buildWorkspaceSkillStatusMock.mockReset();

    callGatewayMock.mockRejectedValue(
      new GatewayTransportError({
        kind: "closed",
        code: 1006,
        reason: "abnormal closure",
        message: "gateway closed (1006): abnormal closure",
        connectionDetails: {
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
          message: "",
        },
      }),
    );
    loadConfigMock.mockReturnValue({});
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentIdByWorkspacePathMock.mockReturnValue(undefined);
    resolveConfiguredAgentIdMock.mockImplementation((_config, agentId: string) => agentId);
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
    readVerifiedClawHubSkillSourceUrlMock.mockReturnValue(undefined);
    readClawHubSkillsLockfileStatusSyncMock.mockReturnValue({ kind: "missing" });
    resolveClawHubSkillStatusLinkSyncMock.mockReturnValue(undefined);
    resolveLocalSkillCardStatusSyncMock.mockReturnValue(undefined);
    resolveClawHubSkillVerificationTargetMock.mockResolvedValue({
      ok: true,
      slug: "agentreceipt",
      baseUrl: "https://private.example.com/clawhub",
      version: "1.2.3",
      tag: undefined,
      resolution: {
        source: "installed",
        selector: "installed-version",
        registry: "https://private.example.com/clawhub",
        skillDir: "/tmp/workspace/skills/agentreceipt",
        installedVersion: "1.2.3",
      },
    });
    verifySkillWithClawHubMock.mockResolvedValue({
      ok: true,
      value: {
        schema: "clawhub.skill.verify.v1",
        ok: true,
        decision: "pass",
        reasons: [],
        skill: { slug: "agentreceipt", displayName: "Agent Receipt" },
        publisher: { handle: "openclaw" },
        version: { version: "1.2.3" },
        card: {
          available: true,
          url: "https://private.example.com/clawhub/api/v1/skills/agentreceipt/card?version=1.2.3",
        },
        artifact: {
          sourceFingerprint: "source-fingerprint",
          bundleFingerprints: ["generated-bundle-fingerprint"],
        },
        provenance: null,
        security: { status: "clean" },
        signature: { status: "unsigned" },
      },
    });
    fetchClawHubSkillCardMock.mockResolvedValue("# Agent Receipt\n\nGenerated by ClawHub.\n");
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

  it("distinguishes duplicate ClawHub skill slugs by owner", async () => {
    searchSkillsFromClawHubMock.mockResolvedValue([
      {
        slug: "calendar",
        ownerHandle: "demo-owner",
        installRef: "@demo-owner/calendar",
        displayName: "Calendar",
        summary: "CalDAV helpers",
        version: "1.2.3",
      },
      {
        slug: "calendar",
        ownerHandle: "work-owner",
        installRef: "@work-owner/calendar",
        displayName: "Team Calendar",
      },
    ]);

    await runCommand(["skills", "search", "calendar"]);

    expect(searchSkillsFromClawHubMock).toHaveBeenCalledWith({
      query: "calendar",
      limit: undefined,
    });
    expect(runtimeLogs).toEqual([
      "@demo-owner/calendar v1.2.3  Calendar  CalDAV helpers",
      "@work-owner/calendar  Team Calendar",
    ]);
  });

  it("keeps bare skill slugs when ClawHub omits the owner", async () => {
    searchSkillsFromClawHubMock.mockResolvedValue([
      {
        slug: "legacy-calendar",
        displayName: "Legacy Calendar",
      },
    ]);

    await runCommand(["skills", "search", "calendar"]);

    expect(runtimeLogs).toEqual(["legacy-calendar  Legacy Calendar"]);
  });

  it("shows skills.sh entries in normal ClawHub search results", async () => {
    searchSkillsFromClawHubMock.mockResolvedValue([
      {
        slug: "weather",
        installRef: "skills-sh:openclaw/skills/weather",
        trustState: "not-scanned-by-clawhub",
        displayName: "Weather",
        summary: "Forecast helpers",
      },
    ]);

    await runCommand(["skills", "search", "weather"]);

    expect(searchSkillsFromClawHubMock).toHaveBeenCalledWith({
      query: "weather",
      limit: undefined,
    });
    expect(runtimeLogs).toEqual([
      "skills-sh:openclaw/skills/weather  Weather  Forecast helpers  Not scanned by ClawHub",
    ]);
  });

  it("keeps multiline ClawHub search metadata on one terminal line", async () => {
    searchSkillsFromClawHubMock.mockResolvedValue([
      {
        slug: "oauth-helper",
        ownerHandle: "demo-owner",
        installRef: "@demo-owner/oauth-helper",
        displayName: "Oauth\nHelper",
        summary:
          "Automate OAuth login flows.\nSupports multiple providers.\n\nFeatures:\n- Confirm before authorizing",
      },
    ]);

    await runCommand(["skills", "search", "oauth-helper"]);

    expect(runtimeLogs).toEqual([
      "@demo-owner/oauth-helper  Oauth Helper  Automate OAuth login flows. Supports multiple providers. Features: - Confirm before authorizing",
    ]);
  });

  it("keeps ClawHub skill search JSON output unchanged", async () => {
    const results = [
      {
        score: 0.9,
        slug: "calendar",
        ownerHandle: "demo-owner",
        displayName: "Calendar",
        summary: "CalDAV helpers",
        version: "1.2.3",
        updatedAt: 1_700_000_000_000,
      },
    ];
    searchSkillsFromClawHubMock.mockResolvedValue(results);

    await runCommand(["skills", "search", "calendar", "--json"]);

    expect(runtimeLogs).toEqual([]);
    expect(runtimeStdout).toEqual([JSON.stringify({ results }, null, 2)]);
  });

  it("rejects partial numeric search limits", async () => {
    await expect(runCommand(["skills", "search", "calendar", "--limit", "10ms"])).rejects.toThrow(
      "--limit must be a positive integer.",
    );
    expect(searchSkillsFromClawHubMock).not.toHaveBeenCalled();
  });

  it("installs a skill from ClawHub into the active workspace", async () => {
    primeCalendarInstall();

    await runCommand(["skills", "install", "calendar", "--version", "1.2.3"]);

    const installArgs = mockFirstObjectArg(installSkillFromClawHubMock);
    expectObjectFields(installArgs, {
      workspaceDir: "/tmp/workspace",
      slug: "calendar",
      version: "1.2.3",
      force: false,
      config: {},
    });
    expectLogger(installArgs.logger);
    expect(
      runtimeLogs.some((line) =>
        line.includes("Installed calendar@1.2.3 -> /tmp/workspace/skills/calendar"),
      ),
    ).toBe(true);
  });

  it("passes owner-qualified ClawHub skill refs through to the installer", async () => {
    primeCalendarInstall();

    await runCommand(["skills", "install", "@demo-owner/calendar"]);

    const installArgs = mockFirstObjectArg(installSkillFromClawHubMock);
    expectObjectFields(installArgs, {
      workspaceDir: "/tmp/workspace",
      slug: "@demo-owner/calendar",
      force: false,
    });
    expect(installSkillFromSourceMock).not.toHaveBeenCalled();
    expect(
      runtimeLogs.some((line) =>
        line.includes("Installed calendar@1.2.3 -> /tmp/workspace/skills/calendar"),
      ),
    ).toBe(true);
  });

  it("routes skills-sh refs through ClawHub without translating them", async () => {
    const reference = "skills-sh:openclaw/skills/weather";
    installSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: "weather",
      version: "a".repeat(40),
      targetDir: "/tmp/workspace/skills/weather",
    });

    await runCommand(["skills", "install", reference]);

    expect(mockFirstObjectArg(installSkillFromClawHubMock).slug).toBe(reference);
    expect(installSkillFromSourceMock).not.toHaveBeenCalled();
  });

  it("rejects --version for skills-sh refs", async () => {
    await expect(
      runCommand(["skills", "install", "skills-sh:openclaw/skills/weather", "--version", "1.2.3"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain("--version is not supported for skills-sh references.");
    expect(installSkillFromClawHubMock).not.toHaveBeenCalled();
    expect(installSkillFromSourceMock).not.toHaveBeenCalled();
  });

  it("rejects the legacy skills-sh slash syntax before network access", async () => {
    await expect(
      runCommand(["skills", "install", "skills-sh/openclaw/skills/weather"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain(
      "Invalid skills.sh skill reference: skills-sh/openclaw/skills/weather",
    );
    expect(installSkillFromClawHubMock).not.toHaveBeenCalled();
    expect(installSkillFromSourceMock).not.toHaveBeenCalled();
  });

  it.each(["install", "verify"])(
    "documents owner-qualified ClawHub %s refs in command help",
    (commandName) => {
      const skillsCommand = createProgram().commands.find((command) => command.name() === "skills");
      const command = skillsCommand?.commands.find((entry) => entry.name() === commandName);
      const output: string[] = [];

      command?.configureOutput({
        writeOut: (value) => output.push(value),
        writeErr: (value) => output.push(value),
      });
      command?.outputHelp();
      const help = output.join("");

      expect(help).toContain("<skill-ref>");
      expect(help).toContain("@owner/slug");
      expect(help).toContain(`openclaw skills ${commandName} @owner/weather`);
      expect(help).not.toContain(`openclaw skills ${commandName} weather`);
    },
  );

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
      config: {},
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

  it("passes an install-policy warning prompt to interactive skill installs", async () => {
    setTty(true);
    installSkillFromSourceMock.mockResolvedValue({
      ok: true,
      slug: "tools",
      targetDir: "/tmp/workspace/skills/tools",
      source: "git",
    });

    await runCommand(["skills", "install", "git:owner/tools"]);

    expect(mockFirstObjectArg(installSkillFromSourceMock).onInstallPolicyWarning).toEqual(
      expect.any(Function),
    );
  });

  it("passes a generic install confirmation to interactive ClawHub skill installs", async () => {
    setTty(true);
    primeCalendarInstall();

    await runCommand(["skills", "install", "calendar"]);

    expect(mockFirstObjectArg(installSkillFromClawHubMock).confirmInstall).toEqual(
      expect.any(Function),
    );
  });

  it("passes noninteractive install-policy acknowledgement to skill installs", async () => {
    setTty(false);
    installSkillFromSourceMock.mockResolvedValue({
      ok: true,
      slug: "tools",
      targetDir: "/tmp/workspace/skills/tools",
      source: "git",
    });

    await runCommand([
      "skills",
      "install",
      "git:owner/tools",
      "--acknowledge-install-policy-warning",
    ]);

    expect(mockFirstObjectArg(installSkillFromSourceMock).onInstallPolicyWarning).toEqual(
      expect.any(Function),
    );
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

  it("declares inherited options on every applicable nested leaf", () => {
    const program = new Command().enablePositionalOptions();
    registerSkillsCli(program);
    const skills = requireCommand(program, "skills");
    const workshop = requireCommand(skills, "workshop");
    const curator = requireCommand(skills, "curator");

    for (const command of workshop.commands) {
      expect(
        command.options.some((option) => option.long === "--agent"),
        command.name(),
      ).toBe(true);
    }
    for (const command of curator.commands) {
      expect(
        command.options.some((option) => option.long === "--json"),
        command.name(),
      ).toBe(true);
    }
  });

  it("rejects --version for git and local source installs", async () => {
    await expect(
      runCommand(["skills", "install", "git:owner/tools", "--version", "1.2.3"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain("--version is only supported for ClawHub skill installs.");
    expect(installSkillFromClawHubMock).not.toHaveBeenCalled();
    expect(installSkillFromSourceMock).not.toHaveBeenCalled();
  });

  it.each([
    { spec: "git:owner/tools", flag: "--force-install" },
    { spec: "./local-skill", flag: "--force-install" },
  ])("rejects ClawHub-only $flag for source install $spec", async ({ spec, flag }) => {
    await expect(runCommand(["skills", "install", spec, flag])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain(`${flag} is only supported for ClawHub skill installs.`);
    expect(installSkillFromClawHubMock).not.toHaveBeenCalled();
    expect(installSkillFromSourceMock).not.toHaveBeenCalled();
  });

  it("installs a skill into the cwd-inferred agent workspace", async () => {
    routeWorkspaceByAgent();
    resolveAgentIdByWorkspacePathMock.mockReturnValue("writer");
    primeCalendarInstall("/tmp/workspace-writer");

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
    primeCalendarInstall("/tmp/workspace-main");

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
    primeCalendarInstall("/tmp/workspace-writer");

    await runCommand(["skills", "--agent", "writer", "install", "calendar"]);

    expect(resolveAgentWorkspaceDirMock).toHaveBeenCalledWith({}, "writer");
    expect(mockFirstObjectArg(installSkillFromClawHubMock).workspaceDir).toBe(
      "/tmp/workspace-writer",
    );
  });

  it("installs a skill into the shared global skills directory", async () => {
    primeCalendarInstall("/tmp/openclaw-config");

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

  it.each([{ flag: "--force-install", option: "forceInstall" }])(
    "passes $flag through for ClawHub skill installs",
    async ({ flag, option }) => {
      primeCalendarInstall();

      await runCommand(["skills", "install", "calendar", flag]);

      expect(installSkillFromClawHubMock).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceDir: "/tmp/workspace",
          slug: "calendar",
          [option]: true,
        }),
      );
    },
  );

  it("prints blocked ClawHub skill install failures when no trust warning was emitted", async () => {
    installSkillFromClawHubMock.mockResolvedValue({
      ok: false,
      code: "clawhub_download_blocked",
      error:
        'ClawHub blocked artifact download for "calendar@1.2.3"; install was not started. ClawHub /api/v1/skills/calendar/versions/1.2.3/download failed (403): blocked.',
    });

    await expect(runCommand(["skills", "install", "calendar"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain(
      'ClawHub blocked artifact download for "calendar@1.2.3"; install was not started. ClawHub /api/v1/skills/calendar/versions/1.2.3/download failed (403): blocked.',
    );
  });

  it.each([
    {
      name: "rejects using --global and --agent together for installs",
      args: ["skills", "install", "calendar", "--global", "--agent", "main"],
    },
    {
      name: "rejects using parent --agent with install --global",
      args: ["skills", "--agent", "writer", "install", "calendar", "--global"],
    },
  ])("$name", async ({ args }) => {
    await expect(runCommand(args)).rejects.toThrow("__exit__:1");
    expect(runtimeErrors).toContain("Use either --global or --agent, not both.");
    expect(installSkillFromClawHubMock).not.toHaveBeenCalled();
  });

  it("updates all tracked ClawHub skills", async () => {
    primeCalendarUpdate();

    await runCommand(["skills", "update", "--all"]);

    expect(readTrackedClawHubSkillSlugsMock).toHaveBeenCalledWith("/tmp/workspace");
    const updateAllArgs = mockFirstObjectArg(updateSkillsFromClawHubMock);
    expectObjectFields(updateAllArgs, {
      workspaceDir: "/tmp/workspace",
      slug: undefined,
    });
    expect(updateAllArgs.config).toEqual({});
    expectLogger(updateAllArgs.logger);
    expect(
      runtimeLogs.some((line) => line.includes("Updated calendar: 1.2.2 -> 1.2.3")),
      "update result log",
    ).toBe(true);
    expect(runtimeErrors).toStrictEqual([]);
  });

  it("does not bootstrap configured skills during update all", async () => {
    loadConfigMock.mockReturnValueOnce({
      agents: {
        defaults: {
          skills: ["apple-notes"],
        },
      },
    });
    readTrackedClawHubSkillSlugsMock.mockResolvedValue([]);

    await runCommand(["skills", "update", "--all"]);

    expect(readTrackedClawHubSkillSlugsMock).toHaveBeenCalledWith("/tmp/workspace");
    expect(updateSkillsFromClawHubMock).not.toHaveBeenCalled();
    expect(runtimeLogs).toContain("No tracked ClawHub skills to update.");
    expect(runtimeErrors).toStrictEqual([]);
  });

  it.each([
    { flag: "--force", option: "force" },
    { flag: "--force-install", option: "forceInstall" },
  ])("passes $flag through for ClawHub skill updates", async ({ flag, option }) => {
    primeCalendarUpdate();

    await runCommand(["skills", "update", "--all", flag]);

    expect(updateSkillsFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/workspace",
        ...(option === "forceInstall" ? { slug: undefined } : {}),
        [option]: true,
      }),
    );
  });

  it("prints --force retry guidance for blocked ClawHub skill updates", async () => {
    readTrackedClawHubSkillSlugsMock.mockResolvedValue(["calendar"]);
    updateSkillsFromClawHubMock.mockResolvedValue([
      {
        ok: false,
        code: "force_required",
        error:
          'Skill "calendar" has local file changes. Updating replaces the installed skill directory.',
      },
    ]);

    await expect(runCommand(["skills", "update", "calendar"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain(
      'Skill "calendar" has local file changes. Updating replaces the installed skill directory. Re-run with --force to update it anyway.',
    );
  });

  it("updates tracked ClawHub skills in the cwd-inferred agent workspace", async () => {
    routeWorkspaceByAgent();
    resolveAgentIdByWorkspacePathMock.mockReturnValue("writer");
    primeCalendarUpdate("/tmp/workspace-writer");

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
    primeCalendarUpdate("/tmp/workspace-main");

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

  it.each([
    {
      name: "updates tracked ClawHub skills in the shared global skills directory",
      selection: "--all",
      slug: undefined,
    },
    {
      name: "updates a single tracked ClawHub skill in the shared global skills directory",
      selection: "calendar",
      slug: "calendar",
    },
  ])("$name", async ({ selection, slug }) => {
    primeCalendarUpdate("/tmp/openclaw-config");

    await runCommand(["skills", "update", selection, "--global"]);

    expect(resolveAgentIdByWorkspacePathMock).not.toHaveBeenCalled();
    expect(resolveDefaultAgentIdMock).not.toHaveBeenCalled();
    expect(resolveAgentWorkspaceDirMock).not.toHaveBeenCalled();
    expect(readTrackedClawHubSkillSlugsMock).toHaveBeenCalledWith("/tmp/openclaw-config");
    expect(updateSkillsFromClawHubMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/openclaw-config",
      slug,
      logger: expect.any(Object),
      config: {},
    });
  });

  it("exits nonzero when a tracked ClawHub skill update fails", async () => {
    readTrackedClawHubSkillSlugsMock.mockResolvedValue(["calendar"]);
    updateSkillsFromClawHubMock.mockResolvedValue([
      {
        ok: false,
        error: "blocked by install policy: calendar is not approved",
      },
    ]);

    await expect(runCommand(["skills", "update", "calendar"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain("blocked by install policy: calendar is not approved");
    expect(runtimeLogs).toStrictEqual([]);
  });

  it.each([
    {
      name: "rejects using --global and --agent together for updates",
      args: ["skills", "update", "--all", "--global", "--agent", "main"],
    },
    {
      name: "rejects using parent --agent with update --global",
      args: ["skills", "--agent", "writer", "update", "--all", "--global"],
    },
  ])("$name", async ({ args }) => {
    await expect(runCommand(args)).rejects.toThrow("__exit__:1");
    expect(runtimeErrors).toContain("Use either --global or --agent, not both.");
    expect(readTrackedClawHubSkillSlugsMock).not.toHaveBeenCalled();
    expect(updateSkillsFromClawHubMock).not.toHaveBeenCalled();
  });

  it("verifies ClawHub skills with JSON output by default", async () => {
    await runCommand(["skills", "verify", "agentreceipt"]);

    expect(resolveClawHubSkillVerificationTargetMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
      version: undefined,
      tag: undefined,
    });
    expect(verifySkillWithClawHubMock).toHaveBeenCalledWith({
      slug: "agentreceipt",
      version: "1.2.3",
      tag: undefined,
      baseUrl: "https://private.example.com/clawhub",
    });
    expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(runtimeStdout.at(-1) ?? "{}") as Record<string, unknown>;
    expect(payload.schema).toBe("clawhub.skill.verify.v1");
    expect(payload.ok).toBe(true);
    expect(payload.signature).toEqual({ status: "unsigned" });
    expect(payload.openclaw).toEqual({
      resolution: {
        source: "installed",
        selector: "installed-version",
        registry: "https://private.example.com/clawhub",
        installedVersion: "1.2.3",
      },
    });
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("passes owner-qualified installed verification targets to ClawHub verification", async () => {
    resolveClawHubSkillVerificationTargetMock.mockResolvedValueOnce({
      ok: true,
      slug: "weather",
      ownerHandle: "demo-owner",
      baseUrl: "https://private.example.com/clawhub",
      version: "1.2.3",
      tag: undefined,
      resolution: {
        source: "installed",
        selector: "installed-version",
        registry: "https://private.example.com/clawhub",
        skillDir: "/tmp/workspace/skills/weather",
        installedVersion: "1.2.3",
      },
    });

    await runCommand(["skills", "verify", "weather"]);

    expect(verifySkillWithClawHubMock).toHaveBeenCalledWith({
      slug: "weather",
      ownerHandle: "demo-owner",
      version: "1.2.3",
      tag: undefined,
      baseUrl: "https://private.example.com/clawhub",
    });
  });

  it("passes owner-qualified verify refs and selectors through the resolver", async () => {
    resolveClawHubSkillVerificationTargetMock.mockResolvedValueOnce({
      ok: true,
      slug: "weather",
      ownerHandle: "demo-owner",
      baseUrl: "https://private.example.com/clawhub",
      version: undefined,
      tag: "latest",
      resolution: {
        source: "registry",
        selector: "tag",
        registry: "https://private.example.com/clawhub",
        skillDir: undefined,
        installedVersion: undefined,
      },
    });

    await runCommand(["skills", "verify", "@demo-owner/weather", "--tag", "latest", "--card"]);

    expect(resolveClawHubSkillVerificationTargetMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      slug: "@demo-owner/weather",
      version: undefined,
      tag: "latest",
    });
    expect(verifySkillWithClawHubMock).toHaveBeenCalledWith({
      slug: "weather",
      ownerHandle: "demo-owner",
      version: undefined,
      tag: "latest",
      baseUrl: "https://private.example.com/clawhub",
    });
    expect(fetchClawHubSkillCardMock).toHaveBeenCalledWith({
      url: "https://private.example.com/clawhub/api/v1/skills/agentreceipt/card?version=1.2.3",
      baseUrl: "https://private.example.com/clawhub",
    });
  });

  it("passes explicit verify selectors and shared workspace options to the resolver", async () => {
    await runCommand(["skills", "verify", "agentreceipt", "--version", "2.0.0", "--global"]);

    expect(resolveAgentIdByWorkspacePathMock).not.toHaveBeenCalled();
    expect(resolveDefaultAgentIdMock).not.toHaveBeenCalled();
    expect(resolveAgentWorkspaceDirMock).not.toHaveBeenCalled();
    expect(resolveClawHubSkillVerificationTargetMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/openclaw-config",
      slug: "agentreceipt",
      version: "2.0.0",
      tag: undefined,
    });
  });

  it("includes verified ClawHub source URLs in verify JSON output", async () => {
    const provenance = {
      source: "server-resolved-github-import",
      repo: "openclaw/skills",
      commit: "0123456789abcdef0123456789abcdef01234567",
      path: "agentreceipt",
    };
    const verifiedSourceUrl =
      "https://github.com/openclaw/skills/tree/0123456789abcdef0123456789abcdef01234567/agentreceipt";
    readVerifiedClawHubSkillSourceUrlMock.mockReturnValueOnce(verifiedSourceUrl);
    primeSkillVerification({
      skill: { slug: "agentreceipt", displayName: "Agent Receipt" },
      publisher: { handle: "openclaw" },
      card: {
        available: true,
        url: "https://private.example.com/clawhub/api/v1/skills/agentreceipt/card?version=1.2.3",
      },
      artifact: {
        sourceFingerprint: "source-fingerprint",
        bundleFingerprints: ["generated-bundle-fingerprint"],
      },
      provenance,
    });

    await runCommand(["skills", "verify", "agentreceipt"]);

    expect(readVerifiedClawHubSkillSourceUrlMock).toHaveBeenCalledWith(provenance);
    const payload = JSON.parse(runtimeStdout.at(-1) ?? "{}") as {
      openclaw?: { verifiedSourceUrl?: string };
    };
    expect(payload.openclaw?.verifiedSourceUrl).toBe(verifiedSourceUrl);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("fetches generated Skill Card markdown for --card", async () => {
    primeSkillVerification({
      skill: { slug: "agentreceipt", displayName: "Agent Receipt" },
      publisher: { handle: "openclaw" },
      card: {
        available: true,
        url: "https://cards.example.test/generated/agentreceipt.md",
      },
      artifact: {
        sourceFingerprint: "source-fingerprint",
        bundleFingerprints: ["generated-bundle-fingerprint"],
      },
    });

    await runCommand(["skills", "verify", "agentreceipt", "--tag", "latest", "--card"]);

    expect(resolveClawHubSkillVerificationTargetMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
      version: undefined,
      tag: "latest",
    });
    expect(fetchClawHubSkillCardMock).toHaveBeenCalledWith({
      url: "https://cards.example.test/generated/agentreceipt.md",
      baseUrl: "https://private.example.com/clawhub",
    });
    expect(defaultRuntime.writeStdout).toHaveBeenCalledTimes(1);
    expect(runtimeStdout.at(-1)).toBe("# Agent Receipt\n\nGenerated by ClawHub.");
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
  });

  it("fails --card when the verified Skill Card is unavailable", async () => {
    primeSkillVerification({
      ok: false,
      decision: "fail",
      reasons: ["card.missing"],
      card: { available: false },
    });

    await expect(runCommand(["skills", "verify", "agentreceipt", "--card"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors).toContain("Skill Card is not available.");
    expect(fetchClawHubSkillCardMock).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing card", card: null },
    { label: "missing card URL", card: { available: true } },
  ])("fails --card when the verification response has $label metadata", async ({ card }) => {
    primeSkillVerification({ card });

    await expect(runCommand(["skills", "verify", "agentreceipt", "--card"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors).toContain(
      "ClawHub verification response did not include a Skill Card URL.",
    );
    expect(fetchClawHubSkillCardMock).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
  });

  it("exits non-zero when the ClawHub verification envelope fails", async () => {
    primeSkillVerification({
      ok: false,
      decision: "fail",
      reasons: ["security.status_not_clean"],
      security: { status: "malicious" },
    });

    await expect(runCommand(["skills", "verify", "agentreceipt"])).rejects.toThrow("__exit__:1");

    expect(JSON.parse(runtimeStdout.at(-1) ?? "{}")).toEqual({
      schema: "clawhub.skill.verify.v1",
      ok: false,
      decision: "fail",
      reasons: ["security.status_not_clean"],
      skill: { slug: "agentreceipt" },
      publisher: null,
      version: { version: "1.2.3" },
      card: { available: true },
      artifact: null,
      provenance: null,
      security: { status: "malicious" },
      signature: { status: "unsigned" },
      openclaw: {
        resolution: {
          source: "installed",
          selector: "installed-version",
          registry: "https://private.example.com/clawhub",
          installedVersion: "1.2.3",
        },
      },
    });
    expect(runtimeErrors).toStrictEqual([]);
  });

  it.each([
    { label: "unknown decision", ok: true, decision: "quarantined" },
    { label: "non-boolean ok", ok: "false", decision: "pass" },
  ])("fails closed for malformed verification envelopes with $label", async ({ ok, decision }) => {
    primeSkillVerification({
      ok,
      decision,
      card: {
        available: true,
        url: "https://private.example.com/clawhub/api/v1/skills/agentreceipt/card?version=1.2.3",
      },
    });

    await expect(runCommand(["skills", "verify", "agentreceipt"])).rejects.toThrow("__exit__:1");

    const payload = JSON.parse(runtimeStdout.at(-1) ?? "{}") as Record<string, unknown>;
    expect(payload.ok).toBe(ok);
    expect(payload.decision).toBe(decision);
    expect(runtimeErrors).toStrictEqual([]);
  });

  it("returns JSON when verify workspace selection fails", async () => {
    defaultRuntime.exit.mockImplementationOnce(() => undefined);

    await runCommand(["skills", "verify", "agentreceipt", "--global", "--agent", "main"]);

    expect(JSON.parse(runtimeStdout.at(-1) ?? "{}")).toEqual({
      ok: false,
      error: {
        type: "cli_error",
        message: "Use either --global or --agent, not both.",
      },
    });
    expect(runtimeErrors).toStrictEqual([]);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(resolveClawHubSkillVerificationTargetMock).not.toHaveBeenCalled();
  });

  it("registers explicit --json output for verify", () => {
    const skills = createProgram().commands.find((command) => command.name() === "skills");
    const verify = skills?.commands.find((command) => command.name() === "verify");

    expect(verify?.options.map((option) => option.long)).toEqual([
      "--version",
      "--tag",
      "--card",
      "--json",
      "--global",
      "--agent",
    ]);
  });

  it.each([
    {
      label: "default list",
      argv: ["skills", "--json"],
      assert: (payload: Record<string, unknown>) => {
        const skills = payload.skills as Array<Record<string, unknown>>;
        expect(skills).toHaveLength(1);
        expect(skills[0]?.name).toBe("calendar");
      },
    },
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
    {
      label: "human",
      argv: ["skills", "info", "missing-skill"],
      expected:
        'Skill "missing-skill" not found. Run `openclaw skills list` to see available skills.\n\nTip: use `openclaw skills search`, `openclaw skills install`, and `openclaw skills update` for ClawHub-backed skills.',
    },
    {
      label: "JSON",
      argv: ["skills", "info", "missing-skill", "--json"],
      expected: JSON.stringify(
        {
          ok: false,
          error: { type: "cli_error", message: 'Skill "missing-skill" not found.' },
          skill: "missing-skill",
        },
        null,
        2,
      ),
    },
  ])("exits nonzero for missing skill info in $label mode", async ({ argv, expected }) => {
    vi.stubEnv("OPENCLAW_PROFILE", "");
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");

    await expect(runCommand(argv)).rejects.toThrow("__exit__:1");

    expect(runtimeStdout).toEqual([expected]);
    expect(runtimeErrors).toStrictEqual([]);
    expect(defaultRuntime.exit).toHaveBeenCalledOnce();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps successful human skill info output at exit zero", async () => {
    await runCommand(["skills", "info", "calendar"]);

    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(runtimeStdout).toHaveLength(1);
    expect(runtimeStdout.at(-1)).toContain("📅 calendar ✓ Ready");
    expect(runtimeStdout.at(-1)).toContain("Calendar helpers");
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

    expect(resolveConfiguredAgentIdMock).not.toHaveBeenCalled();
    expectStatusWorkspaceCall("/tmp/workspace-writer");
  });

  it("uses gateway skills.status for read-only status commands when reachable", async () => {
    routeWorkspaceByAgent();
    const gatewayReport = {
      ...skillStatusReportFixture,
      agentId: "writer",
      workspaceDir: "/gateway/workspace-writer",
      skills: [
        {
          ...skillStatusReportFixture.skills[0],
          name: "apple-notes",
          description: "Notes helpers",
          eligible: true,
          modelVisible: true,
          commandVisible: true,
          requirements: {
            bins: ["memo"],
            anyBins: [],
            env: [],
            config: [],
            os: ["darwin"],
          },
          missing: {
            bins: [],
            anyBins: [],
            env: [],
            config: [],
            os: [],
          },
        },
      ],
    };
    callGatewayMock.mockResolvedValue(gatewayReport);

    await runCommand(["skills", "check", "--agent", "writer", "--json"]);

    expect(callGatewayMock).toHaveBeenCalledWith({
      config: {},
      method: "skills.status",
      params: { agentId: "writer" },
      timeoutMs: 1_500,
      clientName: "cli",
      mode: "cli",
    });
    expect(buildWorkspaceSkillStatusMock).not.toHaveBeenCalled();
    const output = JSON.parse(runtimeStdout.at(-1) ?? "{}") as {
      workspaceDir?: string;
      eligible?: string[];
      missingRequirements?: Array<{ name: string }>;
    };
    expect(output.workspaceDir).toBe("/gateway/workspace-writer");
    expect(output.eligible).toEqual(["apple-notes"]);
    expect(output.missingRequirements).toEqual([]);
  });

  const explicitGatewaySkillFailures = [
    {
      label: "configured remote missing URL",
      config: { gateway: { mode: "remote" as const } },
      message: "gateway remote mode misconfigured: gateway.remote.url missing",
    },
    {
      label: "configured remote transport failure",
      config: { gateway: { mode: "remote" as const, remote: { url: "ws://127.0.0.1:9" } } },
      message: "Gateway not reachable: ws://127.0.0.1:9",
    },
    {
      label: "configured remote auth failure",
      config: { gateway: { mode: "remote" as const, remote: { url: "ws://127.0.0.1:9" } } },
      message: "gateway authentication failed",
    },
    {
      label: "environment-selected transport failure",
      config: {},
      url: "ws://127.0.0.1:9",
      message: "Gateway not reachable: ws://127.0.0.1:9",
    },
    {
      label: "environment-selected auth failure",
      config: {},
      url: "ws://127.0.0.1:9",
      message: "gateway authentication failed",
    },
  ];
  const skillReadCommands = [
    { label: "default", argv: ["skills"] },
    { label: "list", argv: ["skills", "list"] },
    { label: "info", argv: ["skills", "info", "calendar"] },
    { label: "check", argv: ["skills", "check"] },
  ];

  it.each(
    explicitGatewaySkillFailures.flatMap((target) =>
      skillReadCommands.flatMap((command) =>
        [false, true].map((json) => ({
          target,
          command,
          json,
          label: `${command.label} ${json ? "JSON" : "human"}: ${target.label}`,
        })),
      ),
    ),
  )("does not substitute local skills after $label", async ({ target, command, json }) => {
    loadConfigMock.mockReturnValue(target.config);
    if (target.url) {
      vi.stubEnv("OPENCLAW_GATEWAY_URL", target.url);
    }
    callGatewayMock.mockRejectedValue(new Error(target.message));

    await expect(runCommand([...command.argv, ...(json ? ["--json"] : [])])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors).toEqual([target.message]);
    expect(runtimeStdout).toEqual([]);
    expect(buildWorkspaceSkillStatusMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "request validation",
      outcome: "command",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: 'invalid skills.status params: unknown agent id "retired"',
      }),
    },
    {
      label: "internal server failure",
      outcome: "command",
      error: new GatewayClientRequestError({
        code: "INTERNAL_ERROR",
        message: "inventory crashed",
      }),
    },
    {
      label: "authentication close",
      outcome: "root",
      error: new GatewayTransportError({
        kind: "closed",
        code: 1008,
        reason: "pairing required",
        message: "gateway closed (1008): pairing required",
        connectionDetails: {
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
          message: "",
        },
      }),
    },
    {
      label: "plain pairing close",
      outcome: "command",
      error: new Error("gateway closed (1008): pairing required"),
    },
    { label: "unknown failure", outcome: "command", error: new Error("gateway unavailable") },
  ])("does not substitute implicit-local skills after $label", async ({ error, outcome }) => {
    callGatewayMock.mockRejectedValue(error);

    // Root-owned credential/transport errors propagate; ordinary command errors log and exit.
    const command = runCommand(["skills", "list", "--json"]);
    if (outcome === "root") {
      await expect(command).rejects.toBe(error);
      expect(runtimeErrors).toEqual([]);
    } else {
      await expect(command).rejects.toThrow("__exit__:1");
      expect(runtimeErrors).toEqual([error.message]);
    }
    expect(runtimeStdout).toEqual([]);
    expect(buildWorkspaceSkillStatusMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "missing credentials before connecting",
      error: Object.assign(new Error("gateway requires credentials"), {
        name: "GatewayCredentialsRequiredError",
        method: "skills.status",
        configPath: "/tmp/openclaw.json",
      }),
    },
    {
      label: "typed timeout",
      error: new GatewayTransportError({
        kind: "timeout",
        timeoutMs: 1_500,
        message: "gateway timeout after 1500ms",
        connectionDetails: {
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
          message: "",
        },
      }),
    },
    { label: "pending-request close", error: new Error("gateway closed (1006): abnormal closure") },
    { label: "pending-request timeout", error: new Error("gateway timeout after 1500ms") },
    {
      label: "older unknown method",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: skills.status",
      }),
    },
    {
      label: "older unsupported agent selector",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "invalid skills.status params: unexpected property agentId",
      }),
    },
    {
      label: "older standard agent-selector validation",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "invalid skills.status params: at root: unexpected property 'agentId'",
      }),
    },
  ])("retains implicit-local skills recovery after $label", async ({ error }) => {
    callGatewayMock.mockRejectedValue(error);

    await runCommand(["skills", "list", "--json"]);

    expect(buildWorkspaceSkillStatusMock).toHaveBeenCalledOnce();
    expect(runtimeErrors).toEqual([]);
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
    expect(resolveConfiguredAgentIdMock).toHaveBeenCalledWith({}, "writer");
    expectStatusWorkspaceCall("/tmp/workspace-writer");
  });

  it.each([
    ["list", ["skills", "list", "--agent", "nope-agent"]],
    ["check", ["skills", "check", "--agent", "nope-agent"]],
    ["default parent option", ["skills", "--agent", "nope-agent"]],
    ["install", ["skills", "install", "calendar", "--agent", "nope-agent"]],
    ["verify", ["skills", "verify", "calendar", "--card", "--agent", "nope-agent"]],
    ["workshop list", ["skills", "workshop", "list", "--agent", "nope-agent"]],
    ["workshop inspect", ["skills", "workshop", "inspect", "proposal-id", "--agent", "nope-agent"]],
    [
      "workshop proposal",
      [
        "skills",
        "workshop",
        "propose-create",
        "--name",
        "calendar-helper",
        "--description",
        "Calendar helper",
        "--proposal",
        "/missing/proposal.md",
        "--agent",
        "nope-agent",
      ],
    ],
  ])("rejects an unknown agent before skills %s work", async (_label, argv) => {
    resolveConfiguredAgentIdMock.mockImplementation((_config, agentId: string) =>
      resolveConfiguredAgentId({ agents: { list: [{ id: "main" }, { id: "writer" }] } }, agentId),
    );

    await expect(runCommand(argv)).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toStrictEqual([
      'Unknown agent id "nope-agent". Run openclaw agents list to see configured agents.',
    ]);
    expect(resolveAgentWorkspaceDirMock).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ["skills", "check", "--agent", ""]],
    ["whitespace-only", ["skills", "check", "--agent", "   "]],
    ["empty with --global", ["skills", "install", "calendar", "--global", "--agent", ""]],
  ])("rejects a blank explicit skills agent (%s)", async (_label, argv) => {
    await expect(runCommand(argv)).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toStrictEqual(["--agent must not be blank"]);
    expect(resolveConfiguredAgentIdMock).not.toHaveBeenCalled();
    expect(resolveAgentWorkspaceDirMock).not.toHaveBeenCalled();
  });

  it("falls back to the default agent outside configured workspaces", async () => {
    routeWorkspaceByAgent();
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentIdByWorkspacePathMock.mockReturnValue(undefined);

    await withCwd("/tmp/unrelated", async () => {
      await runCommand(["skills", "list", "--json"]);
    });

    expect(resolveAgentIdByWorkspacePathMock).toHaveBeenCalledWith({}, "/tmp/unrelated");
    expect(resolveDefaultAgentIdMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ hint: "Pass --agent <id>." }),
    );
    expect(resolveConfiguredAgentIdMock).not.toHaveBeenCalled();
    expectStatusWorkspaceCall("/tmp/workspace-main");
  });

  it("renders the supported skills escape without advertising --all-agents", async () => {
    resolveDefaultAgentIdMock.mockImplementationOnce((_config, context) => {
      throw new AgentSelectionRequiredError(["main", "helper", "third"], context);
    });

    await expect(runCommand(["skills", "list"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toStrictEqual([
      "Multiple agents are configured, but the skills command has no explicit owner. Pass --agent <id>.",
    ]);
    expect(runtimeErrors[0]).not.toContain("--all-agents");
  });

  it("redacts secrets from rendered skills CLI errors", async () => {
    const secret = "sk-abcdefghijklmnopqrstuv";
    resolveDefaultAgentIdMock.mockImplementationOnce(() => {
      throw new Error(`Skill lookup failed with token=${secret}`);
    });

    await expect(runCommand(["skills", "list"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toHaveLength(1);
    expect(runtimeErrors[0]).toContain("Skill lookup failed");
    expect(runtimeErrors[0]).not.toContain(secret);
  });

  it("keeps non-JSON skills list output on stdout with human-readable formatting", async () => {
    await runCommand(["skills", "list"]);

    expect(loadConfigMock).toHaveBeenCalledWith({ skipPluginValidation: true });
    expect(defaultRuntime.writeStdout).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.log).not.toHaveBeenCalled();
    expect(runtimeErrors).toStrictEqual([]);
    expect(runtimeStdout.at(-1)).toContain("calendar");
    expect(runtimeStdout.at(-1)).toContain("openclaw skills search");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
