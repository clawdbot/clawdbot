import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupCrestodianAgentSession,
  createCrestodianAgentSession,
  runCrestodianAgentTurn,
  runCrestodianAgentTurnWithDeps,
} from "./agent-turn.js";

const mocks = vi.hoisted(() => ({
  runEmbeddedAgent: vi.fn(async (_params: { sessionFile: string }) => ({
    meta: { finalAssistantVisibleText: "ready" },
  })),
}));

vi.mock("../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgent,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "hash",
    config: {},
    runtimeConfig: {},
    sourceConfig: {},
    issues: [],
  })),
}));

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runCrestodianAgentTurn", () => {
  it("pins a randomized local backend and its native session to one conversation", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "crestodian-turn-backend-"));
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const overview = {
      defaultModel: undefined,
      tools: {
        claude: { command: "claude", found: true },
        codex: { command: "codex", found: true },
        gemini: { command: "gemini", found: false },
      },
    } as never;
    const session = createCrestodianAgentSession();
    const randomInt = vi.fn(() => 0);
    const runCliAgent = vi.fn(async (_params: Record<string, unknown>) => ({
      meta: {
        finalAssistantVisibleText: "ready",
        agentMeta: {
          cliSessionBinding: {
            sessionId: "claude-native-session",
            authProfileId: "claude:oauth",
            authEpoch: "epoch-1",
            authEpochVersion: 1,
            cwdHash: "cwd-hash",
            mcpConfigHash: "mcp-hash",
          },
        },
      },
    }));
    const runEmbeddedAgent = vi.fn(async () => ({
      meta: { finalAssistantVisibleText: "ready" },
    }));
    const params = {
      input: "hello",
      overview,
      surface: "gateway" as const,
      approvalArmed: false,
      session,
    };

    await runCrestodianAgentTurnWithDeps(params, {
      randomInt,
      runCliAgent: runCliAgent as never,
      runEmbeddedAgent: runEmbeddedAgent as never,
    });
    await runCrestodianAgentTurnWithDeps(params, {
      randomInt,
      runCliAgent: runCliAgent as never,
      runEmbeddedAgent: runEmbeddedAgent as never,
    });

    expect(randomInt).toHaveBeenCalledOnce();
    expect(runCliAgent).toHaveBeenCalledTimes(2);
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(runCliAgent.mock.calls[1]?.[0]).toMatchObject({
      provider: "claude-cli",
      cliSessionId: "claude-native-session",
      cliSessionBinding: {
        sessionId: "claude-native-session",
        authProfileId: "claude:oauth",
        authEpoch: "epoch-1",
        authEpochVersion: 1,
        cwdHash: "cwd-hash",
        mcpConfigHash: "mcp-hash",
      },
    });
    expect(session).toMatchObject({
      localBackendPreference: "claude-cli",
      cliSessionBackendId: "claude-cli",
      cliSessionBinding: {
        sessionId: "claude-native-session",
        authProfileId: "claude:oauth",
        authEpoch: "epoch-1",
        authEpochVersion: 1,
        cwdHash: "cwd-hash",
        mcpConfigHash: "mcp-hash",
      },
    });

    const codexSession = createCrestodianAgentSession();
    await runCrestodianAgentTurnWithDeps(
      { ...params, session: codexSession },
      {
        randomInt: () => 1,
        runCliAgent: runCliAgent as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
      },
    );
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(codexSession.localBackendPreference).toBe("codex-app-server");
  });

  it("does not pin a randomized peer until it produces a reply", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "crestodian-turn-fallback-"));
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const overview = {
      defaultModel: undefined,
      tools: {
        claude: { command: "claude", found: true },
        codex: { command: "codex", found: true },
        gemini: { command: "gemini", found: false },
      },
    } as never;
    const session = createCrestodianAgentSession();
    const randomInt = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1);
    const runCliAgent = vi.fn(async () => {
      throw new Error("Claude is logged out");
    });
    const runEmbeddedAgent = vi.fn(async () => ({
      meta: { finalAssistantVisibleText: "ready" },
    }));
    const params = {
      input: "hello",
      overview,
      surface: "gateway" as const,
      approvalArmed: false,
      session,
    };

    await expect(
      runCrestodianAgentTurnWithDeps(params, {
        randomInt,
        runCliAgent: runCliAgent as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
      }),
    ).resolves.toBeNull();
    expect(session.localBackendPreference).toBeUndefined();

    await expect(
      runCrestodianAgentTurnWithDeps(params, {
        randomInt,
        runCliAgent: runCliAgent as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
      }),
    ).resolves.toMatchObject({ text: "ready" });
    expect(randomInt).toHaveBeenCalledTimes(2);
    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(session.localBackendPreference).toBe("codex-app-server");
  });

  it.each(["empty reply", "throw"] as const)(
    "does not arm a proposal hidden by a failed %s turn",
    async (failureMode) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "crestodian-turn-proposal-"));
      tempDirs.push(stateDir);
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const overview = {
        defaultModel: undefined,
        tools: {
          claude: { command: "claude", found: true },
          codex: { command: "codex", found: false },
          gemini: { command: "gemini", found: false },
        },
      } as never;
      const session = createCrestodianAgentSession();
      session.proposalRef.current = "previously-shown-proposal";
      const runCliAgent = vi.fn(async (params: Record<string, unknown>) => {
        const crestodianTool = params.crestodianTool as {
          proposalRef: { current?: string };
        };
        crestodianTool.proposalRef.current = "hidden-proposal";
        if (failureMode === "throw") {
          throw new Error("CLI failed after the tool call");
        }
        return { meta: {} };
      });

      await expect(
        runCrestodianAgentTurnWithDeps(
          {
            input: "change it",
            overview,
            surface: "gateway",
            approvalArmed: false,
            session,
          },
          { runCliAgent: runCliAgent as never },
        ),
      ).resolves.toBeNull();

      expect(session.proposalRef.current).toBe("previously-shown-proposal");
    },
  );

  it("uses a distinct transcript for each chat session", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "crestodian-turn-"));
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const overview = { defaultModel: "openai/gpt-5.5" } as never;
    const first = createCrestodianAgentSession();
    const second = createCrestodianAgentSession();

    await runCrestodianAgentTurn({
      input: "hello",
      overview,
      surface: "gateway",
      approvalArmed: false,
      session: first,
    });
    await runCrestodianAgentTurn({
      input: "hello",
      overview,
      surface: "gateway",
      approvalArmed: false,
      session: second,
    });

    const firstPath = mocks.runEmbeddedAgent.mock.calls[0]?.[0]?.sessionFile;
    const secondPath = mocks.runEmbeddedAgent.mock.calls[1]?.[0]?.sessionFile;
    expect(firstPath).toContain(`${first.sessionId}.jsonl`);
    expect(secondPath).toContain(`${second.sessionId}.jsonl`);
    expect(firstPath).not.toBe(secondPath);

    await fs.promises.writeFile(firstPath, "transcript");
    await cleanupCrestodianAgentSession(first);
    await expect(fs.promises.access(firstPath)).rejects.toThrow();
  });

  it.each(["codex", "openclaw"] as const)(
    "inherits the default agent's %s runtime pin for configured turns",
    async (runtimeId) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "crestodian-turn-runtime-"));
      tempDirs.push(stateDir);
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const runEmbeddedAgent = vi.fn(async () => ({
        meta: { finalAssistantVisibleText: "ready" },
      }));
      const config = {
        agents: {
          defaults: { model: { primary: "openai/gpt-5.4" } },
          list: [
            {
              id: "main",
              default: true,
              agentDir: "/tmp/default-agent",
              model: { primary: "openai/gpt-5.5" },
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: runtimeId } },
              },
            },
          ],
        },
      };

      await runCrestodianAgentTurnWithDeps(
        {
          input: "hello",
          overview: { defaultModel: "openai/gpt-5.5" } as never,
          surface: "gateway",
          approvalArmed: false,
          session: createCrestodianAgentSession(),
        },
        {
          readConfigFileSnapshot: vi.fn(async () => ({
            exists: true,
            valid: true,
            path: "/tmp/openclaw.json",
            hash: "hash",
            config,
            runtimeConfig: config,
            sourceConfig: config,
            issues: [],
          })) as never,
          runEmbeddedAgent: runEmbeddedAgent as never,
        },
      );

      expect(runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "crestodian",
          provider: "openai",
          model: "gpt-5.5",
          agentDir: "/tmp/default-agent",
          agentHarnessRuntimeOverride: runtimeId,
          config,
        }),
      );
    },
  );
});
