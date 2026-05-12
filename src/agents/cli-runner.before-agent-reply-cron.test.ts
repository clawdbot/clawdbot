import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";

// vi.mock factories are hoisted above imports, so any references inside them
// must come from vi.hoisted() so they exist at hoist time (otherwise they'd
// be TDZ-undefined and the mocks would silently misbehave). This test only
// exercises the hook-gate decision at the runCliAgent entry point — we mock
// the prepareCliRunContext + executePreparedCliRun seams so no broader CLI
// runtime needs to load.
type BeforeAgentReplyResult =
  | undefined
  | {
      handled?: boolean;
      reply?: { text?: string };
    };

const {
  hasHooksMock,
  runBeforeAgentReplyMock,
  executePreparedCliRunMock,
  prepareCliRunContextMock,
  closeClaudeLiveSessionForContextMock,
  closeMcpLoopbackServerMock,
} = vi.hoisted(() => ({
  hasHooksMock: vi.fn<(hookName: string) => boolean>(() => false),
  runBeforeAgentReplyMock: vi.fn<(event: unknown, ctx: unknown) => Promise<BeforeAgentReplyResult>>(
    async () => undefined,
  ),
  executePreparedCliRunMock: vi.fn(async (_context: unknown, _cliSessionIdToUse?: string) => ({
    text: "",
  })),
  prepareCliRunContextMock: vi.fn(),
  closeClaudeLiveSessionForContextMock: vi.fn(),
  closeMcpLoopbackServerMock: vi.fn(),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: hasHooksMock,
    runBeforeAgentReply: runBeforeAgentReplyMock,
  })),
}));

vi.mock("./cli-runner/prepare.runtime.js", () => ({
  prepareCliRunContext: prepareCliRunContextMock,
}));

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executePreparedCliRunMock,
}));

vi.mock("./cli-runner/claude-live-session.js", () => ({
  closeClaudeLiveSessionForContext: closeClaudeLiveSessionForContextMock,
}));

vi.mock("../gateway/mcp-http.js", () => ({
  closeMcpLoopbackServer: closeMcpLoopbackServerMock,
}));

const baseRunParams = {
  sessionId: "test-session",
  sessionKey: "test-session-key",
  agentId: "main",
  sessionFile: "/tmp/test-session.jsonl",
  workspaceDir: "/tmp/test-workspace",
  prompt: "__openclaw_memory_core_short_term_promotion_dream__",
  provider: "codex-cli",
  model: "gpt-5.5",
  timeoutMs: 30_000,
  runId: "test-run-id",
} as const;

function makeStubContext(params: typeof baseRunParams & { trigger?: string }) {
  return {
    params,
    started: Date.now(),
    workspaceDir: params.workspaceDir,
    modelId: params.model,
    normalizedModel: params.model,
    systemPrompt: "",
    systemPromptReport: {},
    bootstrapPromptWarningLines: [],
    authEpochVersion: 0,
    backendResolved: {},
    preparedBackend: {},
    reusableCliSession: {},
  } as unknown;
}

beforeEach(() => {
  hasHooksMock.mockReset();
  hasHooksMock.mockReturnValue(false);
  runBeforeAgentReplyMock.mockReset();
  runBeforeAgentReplyMock.mockResolvedValue(undefined);
  executePreparedCliRunMock.mockReset();
  executePreparedCliRunMock.mockResolvedValue({ text: "" });
  prepareCliRunContextMock.mockReset();
  prepareCliRunContextMock.mockImplementation(async (params) =>
    makeStubContext(params as typeof baseRunParams & { trigger?: string }),
  );
  closeClaudeLiveSessionForContextMock.mockReset();
  closeMcpLoopbackServerMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runCliAgent cron before_agent_reply seam", () => {
  it("lets before_agent_reply claim cron runs before the CLI subprocess is invoked", async () => {
    const { runCliAgent } = await import("./cli-runner.js");
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({
      handled: true,
      reply: { text: "dreaming claimed via cli runner" },
    });

    const result = await runCliAgent({ ...baseRunParams, trigger: "cron", jobId: "cron-job-123" });

    expect(runBeforeAgentReplyMock).toHaveBeenCalledTimes(1);
    const [event, context] = runBeforeAgentReplyMock.mock.calls.at(0) ?? [];
    expect(event).toEqual({ cleanedBody: baseRunParams.prompt });
    const hookContext = context as Record<string, unknown> | undefined;
    expect(hookContext?.jobId).toBe("cron-job-123");
    expect(hookContext?.agentId).toBe(baseRunParams.agentId);
    expect(hookContext?.sessionId).toBe(baseRunParams.sessionId);
    expect(hookContext?.sessionKey).toBe(baseRunParams.sessionKey);
    expect(hookContext?.workspaceDir).toBe(baseRunParams.workspaceDir);
    expect(hookContext?.trigger).toBe("cron");
    expect(executePreparedCliRunMock).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe("dreaming claimed via cli runner");
  });

  it("does not run prepareCliRunContext when the cron hook claims (no resource allocation, no leak)", async () => {
    // Regression for PR #70950 review (greptile-apps, P1): the gate must fire
    // before any backend resources are allocated, otherwise preparedBackend.cleanup
    // is silently skipped on every claimed cron turn.
    const { runCliAgent } = await import("./cli-runner.js");
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({ handled: true });

    await runCliAgent({ ...baseRunParams, trigger: "cron", jobId: "cron-job-123" });

    expect(prepareCliRunContextMock).not.toHaveBeenCalled();
    expect(executePreparedCliRunMock).not.toHaveBeenCalled();
  });

  it("returns a silent payload when a cron hook claims without a reply body", async () => {
    const { runCliAgent } = await import("./cli-runner.js");
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({ handled: true });

    const result = await runCliAgent({ ...baseRunParams, trigger: "cron", jobId: "cron-job-123" });

    expect(executePreparedCliRunMock).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe(SILENT_REPLY_TOKEN);
  });

  it("does not invoke before_agent_reply for non-cron triggers", async () => {
    const { runCliAgent } = await import("./cli-runner.js");
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });

    await runCliAgent({ ...baseRunParams, trigger: "user" });

    expect(runBeforeAgentReplyMock).not.toHaveBeenCalled();
    expect(executePreparedCliRunMock).toHaveBeenCalledTimes(1);
  });

  it("falls through to the CLI subprocess when no before_agent_reply hook is registered", async () => {
    const { runCliAgent } = await import("./cli-runner.js");
    hasHooksMock.mockReturnValue(false);
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });

    await runCliAgent({ ...baseRunParams, trigger: "cron" });

    expect(runBeforeAgentReplyMock).not.toHaveBeenCalled();
    expect(executePreparedCliRunMock).toHaveBeenCalledTimes(1);
  });

  it("can close temporary CLI live sessions after a run", async () => {
    const { runCliAgent } = await import("./cli-runner.js");
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });

    await runCliAgent({ ...baseRunParams, cleanupCliLiveSessionOnRunEnd: true });

    expect(executePreparedCliRunMock).toHaveBeenCalledTimes(1);
    expect(closeClaudeLiveSessionForContextMock).toHaveBeenCalledTimes(1);
    expect(closeClaudeLiveSessionForContextMock).toHaveBeenCalledWith(
      await prepareCliRunContextMock.mock.results[0].value,
    );
  });

  it("can close temporary bundle MCP loopback resources after a run", async () => {
    const { runCliAgent } = await import("./cli-runner.js");
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });

    await runCliAgent({ ...baseRunParams, cleanupBundleMcpOnRunEnd: true });

    expect(executePreparedCliRunMock).toHaveBeenCalledTimes(1);
    expect(closeMcpLoopbackServerMock).toHaveBeenCalledTimes(1);
  });
});
