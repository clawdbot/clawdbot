// Export trajectory tests cover trajectory export command output and file selection.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExpectedCliError } from "../cli/failure-output.js";
import type { RuntimeEnv } from "../runtime.js";
import { exportTrajectoryCommand } from "./export-trajectory.js";

const mocks = vi.hoisted(() => ({
  exportTrajectoryForCommand: vi.fn(),
  formatTrajectoryCommandExportSummary: vi.fn(),
  getRuntimeConfig: vi.fn(),
  loadSessionEntryReadOnly: vi.fn(),
  resolveExplicitStorePath: vi.fn(),
  resolveSessionTranscriptReadTarget: vi.fn(),
  resolveStorePath: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  mocks.resolveSessionTranscriptReadTarget.mockImplementation(
    actual.resolveSessionTranscriptReadTarget,
  );
  return {
    ...actual,
    loadSessionEntryReadOnly: mocks.loadSessionEntryReadOnly,
    resolveSessionTranscriptReadTarget: mocks.resolveSessionTranscriptReadTarget,
  };
});

vi.mock("../trajectory/command-export.js", () => ({
  exportTrajectoryForCommand: mocks.exportTrajectoryForCommand,
  formatTrajectoryCommandExportSummary: mocks.formatTrajectoryCommandExportSummary,
}));

vi.mock("../config/sessions/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/paths.js")>();
  return {
    ...actual,
    resolveSessionStorePathCore: mocks.resolveStorePath,
  };
});

vi.mock("./session-store-targets.js", () => ({
  resolveExplicitSessionStorePath: mocks.resolveExplicitStorePath,
}));

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

async function expectTrajectoryFailure(
  execution: Promise<void>,
  runtime: RuntimeEnv,
  message: string,
) {
  await expect(execution).rejects.toBeInstanceOf(ExpectedCliError);
  await expect(execution).rejects.toMatchObject({
    message,
    humanOutput: message,
    machineOutput: message,
  });
  expect(runtime.error).not.toHaveBeenCalled();
  expect(runtime.exit).not.toHaveBeenCalled();
  expect(runtime.log).not.toHaveBeenCalled();
}

describe("exportTrajectoryCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.resolveStorePath.mockReturnValue("/tmp/openclaw/sessions.json");
    mocks.resolveExplicitStorePath.mockImplementation(
      (params: { storePath: string }) => params.storePath,
    );
    mocks.loadSessionEntryReadOnly.mockReturnValue({ sessionId: "session-1", updatedAt: 1 });
    mocks.exportTrajectoryForCommand.mockResolvedValue({
      outputDir: "/tmp/workspace/.openclaw/trajectory-exports/export",
      displayPath: ".openclaw/trajectory-exports/export",
      sessionId: "session-1",
      eventCount: 2,
      runtimeEventCount: 0,
      transcriptEventCount: 2,
      files: ["manifest.json", "events.jsonl", "session-branch.json"],
    });
    mocks.formatTrajectoryCommandExportSummary.mockReturnValue("trajectory exported");
  });

  it("points missing session key users at the sessions command", async () => {
    const runtime = createRuntime();

    await expectTrajectoryFailure(
      exportTrajectoryCommand({}, runtime),
      runtime,
      "--session-key is required. Run openclaw sessions to choose a session.",
    );
    expect(mocks.resolveStorePath).not.toHaveBeenCalled();
    expect(mocks.loadSessionEntryReadOnly).not.toHaveBeenCalled();
    expect(mocks.exportTrajectoryForCommand).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "malformed JSON",
      encoded: Buffer.from("not json", "utf8").toString("base64url"),
      detail: "Encoded trajectory export request is invalid JSON",
    },
    {
      name: "a non-object JSON value",
      encoded: Buffer.from("[]", "utf8").toString("base64url"),
      detail: "Encoded trajectory export request must be a JSON object",
    },
    {
      name: "a discarded suffix",
      encoded: `${Buffer.from(JSON.stringify({ sessionKey: "x" }), "utf8").toString("base64url")}A`,
      detail: "Encoded trajectory export request is invalid",
    },
    {
      name: "nonzero padding bits",
      encoded: `${Buffer.from(JSON.stringify({ sessionKey: "xy" }), "utf8")
        .toString("base64url")
        .slice(0, -1)}R`,
      detail: "Encoded trajectory export request is invalid",
    },
    {
      name: "surrounding whitespace",
      encoded: ` ${Buffer.from(JSON.stringify({ sessionKey: "xyz" }), "utf8").toString("base64url")} `,
      detail: "Encoded trajectory export request is invalid",
    },
  ])(
    "rejects an encoded request containing $name before looking up its session",
    async ({ encoded, detail }) => {
      const runtime = createRuntime();

      await expectTrajectoryFailure(
        exportTrajectoryCommand({ requestJsonBase64: encoded }, runtime),
        runtime,
        `Failed to decode trajectory export request: ${detail}`,
      );
      expect(mocks.resolveStorePath).not.toHaveBeenCalled();
      expect(mocks.loadSessionEntryReadOnly).not.toHaveBeenCalled();
      expect(mocks.exportTrajectoryForCommand).not.toHaveBeenCalled();
    },
  );

  it("preserves direct options when an encoded request omits them", async () => {
    const runtime = createRuntime();
    const requestJsonBase64 = Buffer.from(
      JSON.stringify({ output: "/tmp/export.json" }),
      "utf8",
    ).toString("base64url");
    mocks.resolveStorePath.mockReturnValue("/tmp/direct-store.json");

    await exportTrajectoryCommand(
      {
        requestJsonBase64,
        sessionKey: "agent:main:telegram:direct:123",
        store: "/tmp/direct-store.json",
      },
      runtime,
    );

    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.resolveStorePath).toHaveBeenCalledWith("/tmp/direct-store.json", {
      agentId: "main",
    });
    expect(mocks.loadSessionEntryReadOnly).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:123",
      storePath: "/tmp/direct-store.json",
    });
    expect(mocks.exportTrajectoryForCommand).toHaveBeenCalledWith(
      expect.objectContaining({ outputPath: "/tmp/export.json" }),
    );
  });

  it.each([
    [
      "unknown",
      "nope-agent",
      'Unknown agent id "nope-agent". Run openclaw agents list to see configured agents.',
    ],
    ["empty", "", "--agent must not be blank"],
    ["whitespace-only", "   ", "--agent must not be blank"],
  ])("rejects an %s explicit agent before reading a session", async (_label, agent, message) => {
    const runtime = createRuntime();
    mocks.getRuntimeConfig.mockReturnValue({ agents: { list: [{ id: "main" }] } });

    await expectTrajectoryFailure(
      exportTrajectoryCommand({ sessionKey: "agent:main:telegram:direct:123", agent }, runtime),
      runtime,
      message,
    );
    expect(mocks.resolveStorePath).not.toHaveBeenCalled();
    expect(mocks.loadSessionEntryReadOnly).not.toHaveBeenCalled();
    expect(mocks.exportTrajectoryForCommand).not.toHaveBeenCalled();
  });

  it("routes invalid explicit stores through the command failure owner", async () => {
    const runtime = createRuntime();
    mocks.resolveStorePath.mockReturnValue("/tmp/missing.sqlite");
    mocks.resolveExplicitStorePath.mockImplementationOnce(() => {
      throw new Error("Session store target does not exist: /tmp/missing.sqlite");
    });

    await expectTrajectoryFailure(
      exportTrajectoryCommand(
        {
          sessionKey: "agent:main:telegram:direct:123",
          store: "/tmp/missing.sqlite",
          json: true,
        },
        runtime,
      ),
      runtime,
      "Session store target does not exist: /tmp/missing.sqlite",
    );

    expect(mocks.loadSessionEntryReadOnly).not.toHaveBeenCalled();
    expect(mocks.exportTrajectoryForCommand).not.toHaveBeenCalled();
  });

  it.each(["agent:main:telegram:direct:123", "global"])(
    "keeps a configured explicit agent as the store owner for %s",
    async (sessionKey) => {
      const runtime = createRuntime();
      mocks.getRuntimeConfig.mockReturnValue({
        agents: { list: [{ id: "main" }, { id: "work" }] },
        session: { store: "/tmp/openclaw/agents/{agentId}/sessions/sessions.json" },
      });
      mocks.resolveStorePath.mockReturnValue("/tmp/openclaw/agents/work/sessions/sessions.json");

      await exportTrajectoryCommand({ sessionKey, agent: "work" }, runtime);

      expect(mocks.resolveStorePath).toHaveBeenCalledWith(
        "/tmp/openclaw/agents/{agentId}/sessions/sessions.json",
        { agentId: "work" },
      );
      expect(mocks.loadSessionEntryReadOnly).toHaveBeenCalledWith({
        agentId: "work",
        sessionKey,
        storePath: "/tmp/openclaw/agents/work/sessions/sessions.json",
      });
    },
  );

  it.each([
    ["home-prefixed", "~/x/sessions.json", "/home/demo/x/sessions.json"],
    [
      "agent template",
      "/tmp/openclaw/agents/{agentId}/sessions/sessions.json",
      "/tmp/openclaw/agents/work/sessions/sessions.json",
    ],
  ])(
    "resolves explicit --store %s paths through the shared resolver",
    async (_name, store, resolvedStore) => {
      const runtime = createRuntime();
      mocks.resolveStorePath.mockReturnValue(resolvedStore);

      await exportTrajectoryCommand(
        { sessionKey: "agent:work:telegram:direct:123", store },
        runtime,
      );

      expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
      expect(mocks.resolveStorePath).toHaveBeenCalledWith(store, { agentId: "work" });
      expect(mocks.resolveExplicitStorePath).toHaveBeenCalledWith({
        storePath: resolvedStore,
        inputStorePath: store,
        agentId: "work",
      });
      expect(mocks.loadSessionEntryReadOnly).toHaveBeenCalledWith({
        agentId: "work",
        sessionKey: "agent:work:telegram:direct:123",
        storePath: resolvedStore,
      });
    },
  );

  it("uses configured session.store when no explicit store is provided", async () => {
    const runtime = createRuntime();
    mocks.getRuntimeConfig.mockReturnValue({
      session: { store: "/tmp/openclaw/agents/{agentId}/sessions/sessions.json" },
    });
    mocks.resolveStorePath.mockReturnValue("/tmp/openclaw/agents/work/sessions/sessions.json");

    await exportTrajectoryCommand({ sessionKey: "agent:work:telegram:direct:123" }, runtime);

    expect(mocks.resolveStorePath).toHaveBeenCalledWith(
      "/tmp/openclaw/agents/{agentId}/sessions/sessions.json",
      { agentId: "work" },
    );
    expect(mocks.loadSessionEntryReadOnly).toHaveBeenCalledWith({
      agentId: "work",
      sessionKey: "agent:work:telegram:direct:123",
      storePath: "/tmp/openclaw/agents/work/sessions/sessions.json",
    });
  });

  it("falls back through resolveStorePath when no session.store is configured", async () => {
    const runtime = createRuntime();

    await exportTrajectoryCommand({ sessionKey: "agent:main:telegram:direct:123" }, runtime);

    expect(mocks.resolveStorePath).toHaveBeenCalledWith(undefined, { agentId: "main" });
    expect(mocks.loadSessionEntryReadOnly).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:123",
      storePath: "/tmp/openclaw/sessions.json",
    });
  });

  it("passes blank configured session.store through the default-store resolver", async () => {
    const runtime = createRuntime();
    mocks.getRuntimeConfig.mockReturnValue({ session: { store: "" } });

    await exportTrajectoryCommand({ sessionKey: "agent:main:telegram:direct:123" }, runtime);

    expect(mocks.resolveStorePath).toHaveBeenCalledWith("", { agentId: "main" });
    expect(mocks.loadSessionEntryReadOnly).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:123",
      storePath: "/tmp/openclaw/sessions.json",
    });
  });

  it("reports a missing session without resolving its transcript or exporting", async () => {
    const runtime = createRuntime();
    mocks.loadSessionEntryReadOnly.mockReturnValue(undefined);

    await expectTrajectoryFailure(
      exportTrajectoryCommand({ sessionKey: "agent:main:telegram:direct:123" }, runtime),
      runtime,
      "Session not found: agent:main:telegram:direct:123. Run openclaw sessions to see available sessions.",
    );

    expect(mocks.resolveSessionTranscriptReadTarget).not.toHaveBeenCalled();
    expect(mocks.exportTrajectoryForCommand).not.toHaveBeenCalled();
  });

  it("reports transcript target resolution failures without invoking the exporter", async () => {
    const runtime = createRuntime();
    mocks.resolveSessionTranscriptReadTarget.mockImplementationOnce(() => {
      throw new Error("transcript target is unavailable");
    });

    await expectTrajectoryFailure(
      exportTrajectoryCommand({ sessionKey: "agent:main:telegram:direct:123" }, runtime),
      runtime,
      "Failed to resolve session file: transcript target is unavailable",
    );

    expect(mocks.exportTrajectoryForCommand).not.toHaveBeenCalled();
  });

  it("reports exporter failures without formatting a successful result", async () => {
    const runtime = createRuntime();
    mocks.exportTrajectoryForCommand.mockRejectedValueOnce(new Error("workspace is unavailable"));

    await expectTrajectoryFailure(
      exportTrajectoryCommand({ sessionKey: "agent:main:telegram:direct:123" }, runtime),
      runtime,
      "Failed to export trajectory: workspace is unavailable",
    );

    expect(mocks.formatTrajectoryCommandExportSummary).not.toHaveBeenCalled();
  });

  it("exports SQLite sessions without probing a transcript JSONL file", async () => {
    const runtime = createRuntime();

    await exportTrajectoryCommand(
      {
        sessionKey: "agent:main:telegram:direct:123",
        workspace: "/tmp/workspace",
      },
      runtime,
    );

    expect(mocks.exportTrajectoryForCommand).toHaveBeenCalledWith({
      outputPath: undefined,
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:direct:123",
      sessionTarget: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:telegram:direct:123",
        storePath: "/tmp/openclaw/sessions.json",
      },
      workspaceDir: "/tmp/workspace",
    });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("trajectory exported");
  });

  it("preserves successful JSON output", async () => {
    const runtime = createRuntime();

    await exportTrajectoryCommand(
      { sessionKey: "agent:main:telegram:direct:123", json: true },
      runtime,
    );

    expect(runtime.log).toHaveBeenCalledWith(
      JSON.stringify(await mocks.exportTrajectoryForCommand.mock.results[0]?.value, null, 2),
    );
    expect(mocks.formatTrajectoryCommandExportSummary).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
