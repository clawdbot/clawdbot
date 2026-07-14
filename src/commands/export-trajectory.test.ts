// Export trajectory tests cover trajectory export command output and file selection.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { exportTrajectoryCommand } from "./export-trajectory.js";

const mocks = vi.hoisted(() => ({
  exportTrajectoryForCommand: vi.fn(),
  formatTrajectoryCommandExportSummary: vi.fn(),
  getRuntimeConfig: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveStorePath: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    loadSessionEntry: mocks.loadSessionEntry,
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
    resolveStorePath: mocks.resolveStorePath,
  };
});

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("exportTrajectoryCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.resolveStorePath.mockReturnValue("/tmp/openclaw/sessions.json");
    mocks.loadSessionEntry.mockReturnValue(undefined);
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

    await exportTrajectoryCommand({}, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "--session-key is required. Run openclaw sessions to choose a session.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("reports malformed encoded request JSON without leaking parser output", async () => {
    const runtime = createRuntime();
    const requestJsonBase64 = Buffer.from("not json", "utf8").toString("base64url");

    await exportTrajectoryCommand({ requestJsonBase64 }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "Failed to decode trajectory export request: Encoded trajectory export request is invalid JSON",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    ["a discarded suffix", (encoded: string) => `${encoded}A`, "x"],
    ["nonzero padding bits", (encoded: string) => `${encoded.slice(0, -1)}R`, "xy"],
    ["surrounding whitespace", (encoded: string) => ` ${encoded} `, "xyz"],
  ])(
    "rejects a non-canonical base64url request with %s before looking up its session",
    async (_case, makeNonCanonical, sessionKey) => {
      const runtime = createRuntime();
      const canonical = Buffer.from(JSON.stringify({ sessionKey }), "utf8").toString("base64url");
      const requestJsonBase64 = makeNonCanonical(canonical);

      await exportTrajectoryCommand({ requestJsonBase64 }, runtime);

      expect(runtime.error).toHaveBeenCalledWith(
        "Failed to decode trajectory export request: Encoded trajectory export request is invalid",
      );
      expect(mocks.loadSessionEntry).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(1);
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
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:123",
      storePath: "/tmp/direct-store.json",
    });
    expect(runtime.error).toHaveBeenCalledWith(
      "Session not found: agent:main:telegram:direct:123. Run openclaw sessions to see available sessions.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

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
      expect(mocks.loadSessionEntry).toHaveBeenCalledWith({
        agentId: "work",
        sessionKey: "agent:work:telegram:direct:123",
        storePath: resolvedStore,
      });
      expect(runtime.error).toHaveBeenCalledWith(
        "Session not found: agent:work:telegram:direct:123. Run openclaw sessions to see available sessions.",
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
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
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith({
      agentId: "work",
      sessionKey: "agent:work:telegram:direct:123",
      storePath: "/tmp/openclaw/agents/work/sessions/sessions.json",
    });
    expect(runtime.error).toHaveBeenCalledWith(
      "Session not found: agent:work:telegram:direct:123. Run openclaw sessions to see available sessions.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("falls back through resolveStorePath when no session.store is configured", async () => {
    const runtime = createRuntime();

    await exportTrajectoryCommand({ sessionKey: "agent:main:telegram:direct:123" }, runtime);

    expect(mocks.resolveStorePath).toHaveBeenCalledWith(undefined, { agentId: "main" });
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:123",
      storePath: "/tmp/openclaw/sessions.json",
    });
    expect(runtime.error).toHaveBeenCalledWith(
      "Session not found: agent:main:telegram:direct:123. Run openclaw sessions to see available sessions.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("passes blank configured session.store through the default-store resolver", async () => {
    const runtime = createRuntime();
    mocks.getRuntimeConfig.mockReturnValue({ session: { store: "" } });

    await exportTrajectoryCommand({ sessionKey: "agent:main:telegram:direct:123" }, runtime);

    expect(mocks.resolveStorePath).toHaveBeenCalledWith("", { agentId: "main" });
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:123",
      storePath: "/tmp/openclaw/sessions.json",
    });
    expect(runtime.error).toHaveBeenCalledWith(
      "Session not found: agent:main:telegram:direct:123. Run openclaw sessions to see available sessions.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("exports SQLite marker sessions without probing a transcript JSONL file", async () => {
    const runtime = createRuntime();
    const sessionFile = "sqlite:main:session-1:/tmp/openclaw/sessions.json";
    mocks.loadSessionEntry.mockReturnValue({
      sessionId: "session-1",
      sessionFile,
      updatedAt: 1,
    });

    await exportTrajectoryCommand(
      {
        sessionKey: "agent:main:telegram:direct:123",
        workspace: "/tmp/workspace",
      },
      runtime,
    );

    expect(mocks.exportTrajectoryForCommand).toHaveBeenCalledWith({
      outputPath: undefined,
      sessionFile,
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:direct:123",
      workspaceDir: "/tmp/workspace",
    });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("trajectory exported");
  });
});
