import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProtocolRequestTimeoutError } from "../../packages/gateway-client/src/protocol-request.js";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { registerSkillsCli } from "./skills-cli.js";

const mocks = vi.hoisted(() => {
  const output: unknown[] = [];
  return {
    acquireGatewayLock: vi.fn(),
    callGateway: vi.fn(),
    config: {} as { gateway?: { mode: "local" | "remote" } },
    getSkillCuratorStatus: vi.fn(),
    pinCuratedSkill: vi.fn(),
    releaseGatewayLock: vi.fn(),
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
  isGatewayClientRequestError: (error: unknown) =>
    error instanceof Error && error.name === "GatewayClientRequestError",
  isGatewayCredentialsRequiredError: (error: unknown) =>
    error instanceof Error && error.name === "GatewayCredentialsRequiredError",
  isImplicitLocalGatewayTarget: async ({ config }: { config?: { gateway?: { mode?: string } } }) =>
    !process.env.OPENCLAW_GATEWAY_URL && config?.gateway?.mode !== "remote",
}));
vi.mock("../infra/gateway-lock.js", () => ({
  acquireGatewayLock: mocks.acquireGatewayLock,
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

function createGatewayTransportError(kind: "closed" | "timeout", code = 1006) {
  return new GatewayTransportError({
    kind,
    message:
      kind === "closed" ? `gateway closed (${code}): unavailable` : "gateway timeout after 1500ms",
    connectionDetails: { url: "ws://127.0.0.1:18789", urlSource: "local loopback", message: "" },
    ...(kind === "closed" ? { code, reason: "unavailable" } : { timeoutMs: 1_500 }),
  });
}

describe("skills curator cli", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    delete mocks.config.gateway;
    mocks.output.length = 0;
    mocks.releaseGatewayLock.mockReset();
    mocks.acquireGatewayLock.mockReset().mockResolvedValue({ release: mocks.releaseGatewayLock });
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

  it.each([
    {
      label: "missing credentials before connecting",
      error: Object.assign(new Error("gateway requires credentials"), {
        name: "GatewayCredentialsRequiredError",
        method: "skills.curator.status",
        configPath: "/tmp/openclaw.json",
      }),
    },
    { label: "close", error: createGatewayTransportError("closed") },
    { label: "timeout", error: createGatewayTransportError("timeout") },
    { label: "pending-request timeout", error: new Error("gateway timeout after 1500ms") },
  ])(
    "retains local curator status and ownership-locked mutations after implicit-local $label",
    async ({ error }) => {
      mocks.callGateway.mockRejectedValue(error);

      for (const action of curatorActions) {
        await createProgram().parseAsync(["skills", "curator", ...action.argv, "--json"], {
          from: "user",
        });
      }

      expect(mocks.getSkillCuratorStatus).toHaveBeenCalledOnce();
      expect(mocks.pinCuratedSkill).toHaveBeenCalledExactlyOnceWith("daily-brief");
      expect(mocks.unpinCuratedSkill).toHaveBeenCalledExactlyOnceWith("daily-brief");
      expect(mocks.restoreCuratedSkill).toHaveBeenCalledExactlyOnceWith("daily-brief");
      expect(mocks.acquireGatewayLock).toHaveBeenCalledTimes(3);
      expect(mocks.acquireGatewayLock).toHaveBeenCalledWith({
        allowInTests: true,
        port: 18789,
        role: "skill-workshop-apply",
        timeoutMs: 250,
      });
      expect(mocks.releaseGatewayLock).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    {
      label: "missing credentials",
      error: Object.assign(new Error("gateway requires credentials"), {
        name: "GatewayCredentialsRequiredError",
        method: "skills.curator.pin",
        configPath: "/tmp/openclaw.json",
      }),
    },
    { label: "an ambiguous transport close", error: createGatewayTransportError("closed") },
  ])("preserves $label when the Gateway still owns the lock", async ({ error }) => {
    mocks.callGateway.mockRejectedValue(error);
    mocks.acquireGatewayLock.mockRejectedValue(new Error("gateway already running"));

    for (const action of curatorActions.slice(1)) {
      await expect(
        createProgram().parseAsync(["skills", "curator", ...action.argv, "--json"], {
          from: "user",
        }),
        action.label,
      ).rejects.toBe(error);
    }

    expect(mocks.acquireGatewayLock).toHaveBeenCalledTimes(3);
    expect(mocks.releaseGatewayLock).not.toHaveBeenCalled();
    expect(mocks.pinCuratedSkill).not.toHaveBeenCalled();
    expect(mocks.unpinCuratedSkill).not.toHaveBeenCalled();
    expect(mocks.restoreCuratedSkill).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.error).not.toHaveBeenCalled();
  });

  it("preserves a pending-request timeout when the Gateway still owns the lock", async () => {
    const gatewayError = new Error("gateway timeout after 1500ms");
    mocks.callGateway.mockRejectedValue(gatewayError);
    mocks.acquireGatewayLock.mockRejectedValue(new Error("gateway already running"));

    for (const action of curatorActions.slice(1)) {
      await expect(
        createProgram().parseAsync(["skills", "curator", ...action.argv, "--json"], {
          from: "user",
        }),
        action.label,
      ).rejects.toThrow("__exit__:1");
    }

    expect(mocks.acquireGatewayLock).toHaveBeenCalledTimes(3);
    expect(mocks.releaseGatewayLock).not.toHaveBeenCalled();
    expect(mocks.pinCuratedSkill).not.toHaveBeenCalled();
    expect(mocks.unpinCuratedSkill).not.toHaveBeenCalled();
    expect(mocks.restoreCuratedSkill).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.error).toHaveBeenCalledTimes(3);
    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(gatewayError.message);
  });

  it("releases offline Gateway ownership when the local curator mutation fails", async () => {
    const mutationError = new Error("curator mutation failed");
    mocks.callGateway.mockRejectedValue(createGatewayTransportError("closed"));
    mocks.pinCuratedSkill.mockImplementation(() => {
      throw mutationError;
    });

    await expect(
      createProgram().parseAsync(["skills", "curator", "pin", "daily-brief", "--json"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.pinCuratedSkill).toHaveBeenCalledExactlyOnceWith("daily-brief");
    expect(mocks.acquireGatewayLock).toHaveBeenCalledOnce();
    expect(mocks.releaseGatewayLock).toHaveBeenCalledOnce();
    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(mutationError.message);
  });

  it.each([
    {
      label: "request validation",
      outcome: "command",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "invalid skills.curator.pin params: skill is required",
      }),
    },
    {
      label: "internal server failure",
      outcome: "command",
      error: new GatewayClientRequestError({ code: "INTERNAL_ERROR", message: "curator crashed" }),
    },
    { label: "pairing close", outcome: "root", error: createGatewayTransportError("closed", 1008) },
    {
      label: "authentication rotation",
      outcome: "root",
      error: createGatewayTransportError("closed", 4001),
    },
    {
      label: "plain pairing close",
      outcome: "command",
      error: new Error("gateway closed (1008): pairing required"),
    },
    {
      label: "already-dispatched request timeout",
      outcome: "command",
      error: new GatewayProtocolRequestTimeoutError({
        method: "skills.curator.pin",
        timeoutMs: 1_500,
        requestSent: true,
      }),
    },
    { label: "unknown failure", outcome: "command", error: new Error("gateway unavailable") },
  ])("does not touch implicit-local curator state after $label", async ({ error, outcome }) => {
    mocks.callGateway.mockRejectedValue(error);

    for (const action of curatorActions) {
      const command = createProgram().parseAsync(["skills", "curator", ...action.argv, "--json"], {
        from: "user",
      });
      if (outcome === "root") {
        await expect(command, action.label).rejects.toBe(error);
      } else {
        await expect(command, action.label).rejects.toThrow("__exit__:1");
      }
    }

    // Root-owned credential/transport errors propagate; ordinary command errors log and exit.
    if (outcome === "root") {
      expect(mocks.defaultRuntime.error).not.toHaveBeenCalled();
    } else {
      expect(mocks.defaultRuntime.error).toHaveBeenCalledTimes(curatorActions.length);
      expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(error.message);
    }
    expect(mocks.getSkillCuratorStatus).not.toHaveBeenCalled();
    expect(mocks.pinCuratedSkill).not.toHaveBeenCalled();
    expect(mocks.unpinCuratedSkill).not.toHaveBeenCalled();
    expect(mocks.restoreCuratedSkill).not.toHaveBeenCalled();
    expect(mocks.acquireGatewayLock).not.toHaveBeenCalled();
    expect(mocks.releaseGatewayLock).not.toHaveBeenCalled();
  });

  it("falls back only for status when an older implicit-local Gateway lacks curator methods", async () => {
    mocks.callGateway.mockImplementation(async ({ method }: { method: string }) => {
      throw new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: `unknown method: ${method}`,
      });
    });

    await createProgram().parseAsync(["skills", "curator", "status", "--json"], {
      from: "user",
    });

    for (const action of curatorActions.slice(1)) {
      const command = createProgram().parseAsync(["skills", "curator", ...action.argv, "--json"], {
        from: "user",
      });
      await expect(command, action.label).rejects.toThrow("__exit__:1");
      expect(mocks.defaultRuntime.error).toHaveBeenLastCalledWith(
        `unknown method: skills.curator.${action.label}`,
      );
    }

    expect(mocks.getSkillCuratorStatus).toHaveBeenCalledOnce();
    expect(mocks.pinCuratedSkill).not.toHaveBeenCalled();
    expect(mocks.unpinCuratedSkill).not.toHaveBeenCalled();
    expect(mocks.restoreCuratedSkill).not.toHaveBeenCalled();
    expect(mocks.acquireGatewayLock).not.toHaveBeenCalled();
    expect(mocks.releaseGatewayLock).not.toHaveBeenCalled();
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
