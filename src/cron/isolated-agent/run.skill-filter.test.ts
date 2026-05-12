import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  buildWorkspaceSkillSnapshotMock,
  dispatchCronDeliveryMock,
  getCliSessionIdMock,
  isCliProviderMock,
  lookupContextTokensMock,
  loadRunCronIsolatedAgentTurn,
  logWarnMock,
  makeCronSession,
  makeCronSessionEntry,
  resolveAgentConfigMock,
  resolveAgentSkillsFilterMock,
  resolveAllowedModelRefMock,
  resolveCronSessionMock,
  runCliAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const makeSkillJob = makeIsolatedAgentTurnJob;
const makeSkillParams = makeIsolatedAgentTurnParams;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function getMockCallArg(
  mock: { mock: { calls: readonly unknown[][] } },
  callIndex: number,
  argIndex: number,
  label: string,
): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  return call[argIndex];
}

function getFirstMockArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
): Record<string, unknown> {
  return requireRecord(getMockCallArg(mock, 0, 0, label), `${label} params`);
}

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — skill filter", () => {
  setupRunCronIsolatedAgentTurnSuite();

  async function runSkillFilterCase(overrides?: Record<string, unknown>) {
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams(overrides));
    expect(result.status).toBe("ok");
    return result;
  }

  function expectDefaultModelCall(params: { primary: string; fallbacks: string[] }) {
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    const callCfg = getFirstMockArg(runWithModelFallbackMock, "model fallback").cfg as
      | { agents?: { defaults?: { model?: { primary?: string; fallbacks?: string[] } } } }
      | undefined;
    const model = callCfg?.agents?.defaults?.model;
    expect(model?.primary).toBe(params.primary);
    expect(model?.fallbacks).toEqual(params.fallbacks);
  }

  function mockCliFallbackInvocation() {
    runWithModelFallbackMock.mockImplementationOnce(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        const result = await params.run("claude-cli", "claude-opus-4-6");
        return { result, provider: "claude-cli", model: "claude-opus-4-6", attempts: [] };
      },
    );
  }

  it("passes agent-level skillFilter to buildWorkspaceSkillSnapshot", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue(["meme-factory", "weather"]);

    await runSkillFilterCase({
      cfg: { agents: { list: [{ id: "scout", skills: ["meme-factory", "weather"] }] } },
      agentId: "scout",
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    expect(getMockCallArg(buildWorkspaceSkillSnapshotMock, 0, 1, "skill snapshot")).toHaveProperty(
      "skillFilter",
      ["meme-factory", "weather"],
    );
  });

  it("omits skillFilter when agent has no skills config", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue(undefined);

    await runSkillFilterCase({
      cfg: { agents: { list: [{ id: "general" }] } },
      agentId: "general",
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    // When no skills config, skillFilter should be undefined (no filtering applied)
    expect(
      requireRecord(
        getMockCallArg(buildWorkspaceSkillSnapshotMock, 0, 1, "skill snapshot"),
        "skill snapshot options",
      ).skillFilter,
    ).toBeUndefined();
  });

  it("passes empty skillFilter when agent explicitly disables all skills", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue([]);

    await runSkillFilterCase({
      cfg: { agents: { list: [{ id: "silent", skills: [] }] } },
      agentId: "silent",
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    // Explicit empty skills list should forward [] to filter out all skills
    expect(getMockCallArg(buildWorkspaceSkillSnapshotMock, 0, 1, "skill snapshot")).toHaveProperty(
      "skillFilter",
      [],
    );
  });

  it("refreshes cached snapshot when skillFilter changes without version bump", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue(["weather"]);
    resolveCronSessionMock.mockReturnValue({
      storePath: "/tmp/store.json",
      store: {},
      sessionEntry: {
        sessionId: "test-session-id",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: {
          prompt: "<available_skills><skill>meme-factory</skill></available_skills>",
          skills: [{ name: "meme-factory" }],
          version: 42,
        },
      },
      systemSent: false,
      isNewSession: true,
    });

    await runSkillFilterCase({
      cfg: { agents: { list: [{ id: "weather-bot", skills: ["weather"] }] } },
      agentId: "weather-bot",
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    expect(getMockCallArg(buildWorkspaceSkillSnapshotMock, 0, 1, "skill snapshot")).toHaveProperty(
      "skillFilter",
      ["weather"],
    );
  });

  it("forces a fresh session for isolated cron runs", async () => {
    await runSkillFilterCase();
    expect(resolveCronSessionMock).toHaveBeenCalledOnce();
    expect(getFirstMockArg(resolveCronSessionMock, "cron session").forceNew).toBe(true);
  });

  it("reuses cached snapshot when version and normalized skillFilter are unchanged", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue([" weather ", "meme-factory", "weather"]);
    resolveCronSessionMock.mockReturnValue({
      storePath: "/tmp/store.json",
      store: {},
      sessionEntry: {
        sessionId: "test-session-id",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: {
          prompt: "<available_skills><skill>weather</skill></available_skills>",
          skills: [{ name: "weather" }],
          skillFilter: ["meme-factory", "weather"],
          version: 42,
        },
      },
      systemSent: false,
      isNewSession: true,
    });

    await runSkillFilterCase({
      cfg: { agents: { list: [{ id: "weather-bot", skills: ["weather", "meme-factory"] }] } },
      agentId: "weather-bot",
    });
    expect(buildWorkspaceSkillSnapshotMock).not.toHaveBeenCalled();
  });

  describe("model fallbacks", () => {
    const defaultFallbacks = [
      "anthropic/claude-opus-4-6",
      "google-gemini-cli/gemini-3.1-pro-preview",
      "nvidia/deepseek-ai/deepseek-v3.2",
    ];

    async function expectPrimaryOverridePreservesDefaults(modelOverride: unknown) {
      resolveAgentConfigMock.mockReturnValue({ model: modelOverride });
      await runSkillFilterCase({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai-codex/gpt-5.4", fallbacks: defaultFallbacks },
            },
          },
        },
        agentId: "scout",
      });

      expectDefaultModelCall({
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: defaultFallbacks,
      });
    }

    it("preserves defaults when agent overrides primary as string", async () => {
      await expectPrimaryOverridePreservesDefaults("anthropic/claude-sonnet-4-6");
    });

    it("preserves defaults when agent overrides primary in object form", async () => {
      await expectPrimaryOverridePreservesDefaults({ primary: "anthropic/claude-sonnet-4-6" });
    });

    it("applies payload.model override when model is allowed", async () => {
      resolveAllowedModelRefMock.mockReturnValueOnce({
        ref: { provider: "anthropic", model: "claude-sonnet-4-6" },
      });

      const result = await runCronIsolatedAgentTurn(
        makeSkillParams({
          job: makeSkillJob({
            payload: { kind: "agentTurn", message: "test", model: "anthropic/claude-sonnet-4-6" },
          }),
        }),
      );

      expect(result.status).toBe("ok");
      expect(logWarnMock).not.toHaveBeenCalled();
      expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
      const runParams = getFirstMockArg(runWithModelFallbackMock, "model fallback");
      expect(runParams.provider).toBe("anthropic");
      expect(runParams.model).toBe("claude-sonnet-4-6");
    });

    it("fails closed when payload.model is not allowed", async () => {
      resolveAllowedModelRefMock.mockReturnValueOnce({
        error: "model not allowed: anthropic/claude-sonnet-4-6",
      });

      const result = await runCronIsolatedAgentTurn(
        makeSkillParams({
          cfg: {
            agents: {
              defaults: {
                model: { primary: "openai-codex/gpt-5.4", fallbacks: defaultFallbacks },
                models: { "openai-codex/gpt-5.4": {} },
              },
            },
          },
          job: makeSkillJob({
            payload: {
              kind: "agentTurn",
              message: "test",
              model: "anthropic/claude-sonnet-4-6",
            },
          }),
        }),
      );

      expect(result.status).toBe("error");
      expect(result.error).toBe(
        "cron payload.model 'anthropic/claude-sonnet-4-6' rejected by agents.defaults.models allowlist: anthropic/claude-sonnet-4-6 is not in [openai-codex/gpt-5.4]",
      );
      expect(logWarnMock).not.toHaveBeenCalled();
      expect(runWithModelFallbackMock).not.toHaveBeenCalled();
    });

    it("returns an error when payload.model is invalid", async () => {
      resolveAllowedModelRefMock.mockReturnValueOnce({
        error: "invalid model: openai/",
      });

      const result = await runCronIsolatedAgentTurn(
        makeSkillParams({
          job: makeSkillJob({
            payload: { kind: "agentTurn", message: "test", model: "openai/" },
          }),
        }),
      );

      expect(result.status).toBe("error");
      expect(result.error).toBe("cron payload.model 'openai/' rejected: invalid model: openai/");
      expect(logWarnMock).not.toHaveBeenCalled();
      expect(runWithModelFallbackMock).not.toHaveBeenCalled();
    });
  });

  describe("CLI session handoff (issue #29774)", () => {
    it("passes the cron abort signal to CLI runs and drops late CLI results", async () => {
      const abortController = new AbortController();
      let markCliStarted: (() => void) | undefined;
      const cliStarted = new Promise<void>((resolve) => {
        markCliStarted = resolve;
      });

      isCliProviderMock.mockReturnValue(true);
      runCliAgentMock.mockImplementationOnce(async (params: { abortSignal?: AbortSignal }) => {
        expect(params.abortSignal).toBe(abortController.signal);
        if (!markCliStarted) {
          throw new Error("Expected CLI start marker callback to be initialized");
        }
        markCliStarted();
        await new Promise<void>((resolve) => {
          params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          payloads: [{ text: "late cli output" }],
          meta: { agentMeta: { sessionId: "late-cli-session", usage: { input: 5, output: 10 } } },
        };
      });
      mockCliFallbackInvocation();

      const runPromise = runCronIsolatedAgentTurn(
        makeSkillParams({ abortSignal: abortController.signal }),
      );
      await cliStarted;
      abortController.abort("cron: job execution timed out");

      const result = await runPromise;

      expect(result.status).toBe("error");
      expect(result.error).toBe("cron: job execution timed out");
      expect(dispatchCronDeliveryMock).not.toHaveBeenCalled();
    });

    it("does not pass stored cliSessionId on fresh isolated runs (isNewSession=true)", async () => {
      // Simulate a persisted CLI session ID from a previous run.
      getCliSessionIdMock.mockReturnValue("prev-cli-session-abc");
      isCliProviderMock.mockReturnValue(true);
      runCliAgentMock.mockResolvedValue({
        payloads: [{ text: "output" }],
        meta: { agentMeta: { sessionId: "new-cli-session-xyz", usage: { input: 5, output: 10 } } },
      });
      // Make runWithModelFallback invoke the run callback so the CLI path executes.
      mockCliFallbackInvocation();
      resolveCronSessionMock.mockReturnValue({
        storePath: "/tmp/store.json",
        store: {},
        sessionEntry: {
          sessionId: "test-session-fresh",
          updatedAt: 0,
          systemSent: false,
          skillsSnapshot: undefined,
          // A stored CLI session ID that should NOT be reused on fresh runs.
          cliSessionIds: { "claude-cli": "prev-cli-session-abc" },
        },
        systemSent: false,
        isNewSession: true,
      });

      await runCronIsolatedAgentTurn(makeSkillParams());

      expect(runCliAgentMock).toHaveBeenCalledOnce();
      // Fresh session: cliSessionId must be undefined, not the stored value.
      expect(getFirstMockArg(runCliAgentMock, "CLI run")).toHaveProperty("cliSessionId", undefined);
    });

    it("reuses stored cliSessionId on continuation runs (isNewSession=false)", async () => {
      getCliSessionIdMock.mockReturnValue("existing-cli-session-def");
      isCliProviderMock.mockReturnValue(true);
      runCliAgentMock.mockResolvedValue({
        payloads: [{ text: "output" }],
        meta: {
          agentMeta: { sessionId: "existing-cli-session-def", usage: { input: 5, output: 10 } },
        },
      });
      mockCliFallbackInvocation();
      resolveCronSessionMock.mockReturnValue({
        storePath: "/tmp/store.json",
        store: {},
        sessionEntry: {
          sessionId: "test-session-continuation",
          updatedAt: 0,
          systemSent: false,
          skillsSnapshot: undefined,
          cliSessionIds: { "claude-cli": "existing-cli-session-def" },
        },
        systemSent: false,
        isNewSession: false,
      });

      await runCronIsolatedAgentTurn(makeSkillParams());

      expect(runCliAgentMock).toHaveBeenCalledOnce();
      // Continuation: cliSessionId should be passed through for session resume.
      expect(getFirstMockArg(runCliAgentMock, "CLI run")).toHaveProperty(
        "cliSessionId",
        "existing-cli-session-def",
      );
    });
  });

  describe("context token fallback", () => {
    it("preserves existing session contextTokens when no configured or cached model window is loaded", async () => {
      const session = makeCronSession({
        sessionEntry: makeCronSessionEntry({
          contextTokens: 222_000,
        }),
      });
      resolveCronSessionMock.mockReturnValue(session);
      lookupContextTokensMock.mockReturnValue(undefined);

      const result = await runSkillFilterCase();

      expect(result.status).toBe("ok");
      expect(session.sessionEntry.contextTokens).toBe(222_000);
    });

    it("prefers sync-configured model contextTokens over the previous session value", async () => {
      const session = makeCronSession({
        sessionEntry: makeCronSessionEntry({
          contextTokens: 222_000,
        }),
      });
      resolveCronSessionMock.mockReturnValue(session);
      lookupContextTokensMock.mockReturnValue(512_000);

      const result = await runSkillFilterCase();

      expect(result.status).toBe("ok");
      expect(session.sessionEntry.contextTokens).toBe(512_000);
      expect(lookupContextTokensMock).toHaveBeenCalledWith("gpt-5.4", {
        allowAsyncLoad: false,
      });
    });
  });
});
