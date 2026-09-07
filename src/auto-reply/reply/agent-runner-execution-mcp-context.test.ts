import { describe, expect, it } from "vitest";
import type { SessionMcpRuntime } from "../../agents/agent-bundle-mcp-types.js";
import { buildCurrentInboundPrompt } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import { updateMcpAppModelContext } from "../../agents/mcp-app-model-context.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  initialFallbackAttemptOptions,
  setupAgentRunnerExecutionTestState,
  type EmbeddedAgentParams,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();
const { executeAgentTurn } = await import("./agent-runner-execution.js");

describe("executeAgentTurn MCP App context", () => {
  it("injects pending MCP App context exactly once without changing transcript text", async () => {
    const runtime = { sessionId: "session" } as SessionMcpRuntime;
    state.peekSessionMcpRuntimeMock.mockReturnValue(runtime);
    updateMcpAppModelContext(
      runtime,
      {},
      {
        content: [{ type: "text", text: "selected item 42" }],
      },
    );
    state.runEmbeddedAgentMock.mockImplementation(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({ phase: "model_call_started" });
      return { payloads: [{ text: "ok" }], meta: {} };
    });

    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams(),
      commandBody: "show details",
      transcriptCommandBody: "show details",
    });
    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams(),
      commandBody: "next question",
      transcriptCommandBody: "next question",
    });

    expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.prompt).toBe("show details");
    expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.currentInboundContext).toMatchObject({
      text: expect.stringContaining("selected item 42"),
      fragments: expect.arrayContaining([
        { kind: "conversation-data", text: expect.stringContaining("selected item 42") },
      ]),
    });
    expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.transcriptPrompt).toBe("show details");
    expect(state.runEmbeddedAgentMock.mock.calls[1]?.[0]?.prompt).toBe("next question");
    expect(state.runEmbeddedAgentMock.mock.calls[1]?.[0]?.transcriptPrompt).toBe("next question");
    expect(
      JSON.stringify(state.runEmbeddedAgentMock.mock.calls[1]?.[0]?.currentInboundContext ?? {}),
    ).not.toContain("selected item 42");
  });

  it("does not consume pending MCP App context when pre-start validation fails", async () => {
    const runtime = { sessionId: "session" } as SessionMcpRuntime;
    state.peekSessionMcpRuntimeMock.mockReturnValue(runtime);
    updateMcpAppModelContext(
      runtime,
      {},
      {
        content: [{ type: "text", text: "still pending" }],
      },
    );
    state.resolveCurrentTurnImagesMock.mockRejectedValueOnce(new Error("invalid image"));

    await expect(executeAgentTurn(createMinimalRunAgentTurnParams())).rejects.toThrow(
      "invalid image",
    );
    expect(runtime.pendingMcpAppModelContext?.text).toBe("still pending");
    state.resolveCurrentTurnImagesMock.mockResolvedValueOnce({});
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({ phase: "model_call_started" });
      return { payloads: [{ text: "ok" }], meta: {} };
    });
    await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]?.currentInboundContext).toMatchObject({
      text: expect.stringContaining("still pending"),
      fragments: expect.arrayContaining([
        { kind: "conversation-data", text: expect.stringContaining("still pending") },
      ]),
    });
    expect(runtime.pendingMcpAppModelContext).toBeUndefined();
  });

  it("retains pending MCP App context in full and resumable CLI prompts until process start", async () => {
    const followupRun = createFollowupRun();
    followupRun.run.provider = "codex-cli";
    followupRun.run.model = "gpt-5.4";
    const { provider, model } = followupRun.run;
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run(provider, model, initialFallbackAttemptOptions(params)),
      provider,
      model,
      attempts: [],
    }));
    const runtime = { sessionId: "session" } as SessionMcpRuntime;
    state.peekSessionMcpRuntimeMock.mockReturnValue(runtime);
    updateMcpAppModelContext(
      runtime,
      {},
      {
        content: [{ type: "text", text: "CLI selection" }],
      },
    );
    state.runCliAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({ phase: "process_spawned" });
      return { payloads: [{ text: "final" }], meta: {} };
    });
    followupRun.currentInboundContext = {
      text: "Room backlog",
      resumableText: "Current room event",
    };

    await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
      }),
    );

    const cliParams = state.runCliAgentMock.mock.calls[0]?.[0];
    expect(cliParams?.prompt).toBe("fix it");
    expect(cliParams?.transcriptPrompt ?? cliParams?.prompt).toBe("fix it");
    expect(cliParams?.currentInboundContext?.text).toContain("CLI selection");
    const resumedPrompt = buildCurrentInboundPrompt({
      context: cliParams?.currentInboundContext,
      prompt: cliParams?.prompt ?? "",
      preferResumableText: true,
    });
    expect(resumedPrompt).toContain("CLI selection");
    expect(resumedPrompt).toContain("Current room event");
    expect(resumedPrompt).not.toContain("Room backlog");
    expect(followupRun.currentInboundContext.resumableText).toBe("Current room event");
    expect(runtime.pendingMcpAppModelContext).toBeUndefined();
  });
});
