import { describe, expect, it, vi } from "vitest";
import type { AfterToolOutcomeContext, Agent, AgentToolResult } from "../../runtime/index.js";
import { installCodeModeRepairHook } from "./code-mode-repair.js";

function outcome(params: {
  assistantMessage?: AfterToolOutcomeContext["assistantMessage"];
  toolName?: string;
  result: AgentToolResult<unknown>;
  isError?: boolean;
  executionStarted?: boolean;
  errorKind?: "argument-validation";
}): AfterToolOutcomeContext {
  return {
    assistantMessage:
      params.assistantMessage ??
      ({
        role: "assistant",
        content: [],
        timestamp: 1,
      } as unknown as AfterToolOutcomeContext["assistantMessage"]),
    toolCall: {
      type: "toolCall",
      id: "call-1",
      name: params.toolName ?? "exec",
      arguments: {},
    },
    args: {},
    result: params.result,
    isError: params.isError ?? false,
    executionStarted: params.executionStarted ?? true,
    ...(params.errorKind ? { errorKind: params.errorKind } : {}),
    context: { systemPrompt: "", messages: [], tools: [] },
  } as unknown as AfterToolOutcomeContext;
}

function failedResult(params?: {
  code?: string;
  failurePhase?: "input" | "guest" | "bridge" | "host";
  bridgeDispatchStarted?: boolean;
  output?: unknown[];
}): AgentToolResult<unknown> {
  const details = {
    status: "failed",
    code: params?.code ?? "internal_error",
    error: "guest failed",
    failurePhase: params?.failurePhase ?? "guest",
    bridgeDispatchStarted: params?.bridgeDispatchStarted ?? false,
    ...(params?.output ? { output: params.output } : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

function completedResult(): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: '{"status":"completed","value":42}' }],
    details: { status: "completed", value: 42 },
  };
}

function createAgent(previous?: Agent["afterToolOutcome"]): Agent {
  const agent = { afterToolOutcome: previous } as Agent;
  installCodeModeRepairHook({ agent });
  return agent;
}

describe("installCodeModeRepairHook", () => {
  it("offers one repair for a pre-execution argument validation failure", async () => {
    const agent = createAgent();

    const result = await agent.afterToolOutcome?.(
      outcome({
        result: { content: [{ type: "text", text: "code is required" }], details: {} },
        isError: true,
        executionStarted: false,
        errorKind: "argument-validation",
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      terminate: false,
      details: {
        status: "failed",
        code: "invalid_input",
        failurePhase: "input",
        bridgeDispatchStarted: false,
        repair: { allowed: true, remainingAttempts: 1 },
      },
    });
  });

  it("leaves steering skips unchanged without spending repair", async () => {
    const agent = createAgent();
    const skipped = {
      content: [{ type: "text" as const, text: "Skipped due to queued user message." }],
      details: { status: "skipped", deniedReason: "steering" },
    };

    await expect(
      agent.afterToolOutcome?.(
        outcome({
          result: skipped,
          isError: true,
          executionStarted: false,
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      agent.afterToolOutcome?.(outcome({ result: failedResult() })),
    ).resolves.toMatchObject({
      terminate: false,
      details: { repair: { allowed: true, remainingAttempts: 1 } },
    });
  });

  it("does not spend the repair token on successful pure computation", async () => {
    const agent = createAgent();

    expect(await agent.afterToolOutcome?.(outcome({ result: completedResult() }))).toBeUndefined();
    const result = await agent.afterToolOutcome?.(outcome({ result: failedResult() }));

    expect(result).toMatchObject({
      terminate: false,
      details: { repair: { allowed: true, remainingAttempts: 1 } },
    });
  });

  it("leaves critical tool-loop recovery to agent core without spending repair", async () => {
    const agent = createAgent();

    await expect(
      agent.afterToolOutcome?.(
        outcome({
          result: {
            content: [{ type: "text", text: "choose a different action" }],
            details: { status: "blocked", deniedReason: "tool-loop" },
          },
          isError: true,
          executionStarted: false,
        }),
      ),
    ).resolves.toBeUndefined();

    await expect(
      agent.afterToolOutcome?.(outcome({ result: failedResult() })),
    ).resolves.toMatchObject({
      terminate: false,
      details: { repair: { allowed: true, remainingAttempts: 1 } },
    });
  });

  it("terminates when the single repair attempt also fails", async () => {
    const agent = createAgent();

    await agent.afterToolOutcome?.(outcome({ result: failedResult() }));
    const result = await agent.afterToolOutcome?.(outcome({ result: failedResult() }));

    expect(result).toMatchObject({
      isError: true,
      terminate: true,
      details: { repair: { allowed: false, remainingAttempts: 0 } },
    });
  });

  it("does not consume the repair on sibling execs from the originating turn", async () => {
    const agent = createAgent();
    const assistantMessage = {
      role: "assistant",
      content: [],
      timestamp: 1,
    } as unknown as AfterToolOutcomeContext["assistantMessage"];

    await agent.afterToolOutcome?.(outcome({ assistantMessage, result: failedResult() }));
    expect(
      await agent.afterToolOutcome?.(outcome({ assistantMessage, result: completedResult() })),
    ).toBeUndefined();
    const siblingFailure = await agent.afterToolOutcome?.(
      outcome({ assistantMessage, result: failedResult() }),
    );
    const correctionFailure = await agent.afterToolOutcome?.(outcome({ result: failedResult() }));

    expect(siblingFailure).toMatchObject({
      terminate: false,
      details: { repair: { allowed: true, remainingAttempts: 1 } },
    });
    expect(correctionFailure).toMatchObject({
      terminate: true,
      details: { repair: { allowed: false, remainingAttempts: 0 } },
    });
  });

  it("never offers a retry after bridge dispatch", async () => {
    const agent = createAgent();

    const result = await agent.afterToolOutcome?.(
      outcome({
        result: failedResult({
          failurePhase: "bridge",
          bridgeDispatchStarted: true,
          output: [{ type: "text", text: "before dispatch failure" }],
        }),
      }),
    );
    const payload = JSON.parse(
      String(result?.content?.find((entry) => entry.type === "text")?.text),
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      isError: true,
      terminate: true,
      details: {
        bridgeDispatchStarted: true,
        repair: { allowed: false, remainingAttempts: 0 },
      },
    });
    expect(payload.output).toEqual([{ type: "text", text: "before dispatch failure" }]);
  });

  it("preserves dispatch evidence replaced by an earlier outcome hook", async () => {
    const previous = vi.fn(async () => ({
      details: {
        status: "failed",
        code: "internal_error",
        error: "rewritten failure",
      },
    }));
    const agent = createAgent(previous);

    const result = await agent.afterToolOutcome?.(
      outcome({
        result: failedResult({
          failurePhase: "bridge",
          bridgeDispatchStarted: true,
        }),
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      terminate: true,
      details: {
        bridgeDispatchStarted: true,
        repair: { allowed: false, remainingAttempts: 0 },
      },
    });
  });

  it("keeps positive dispatch evidence when an earlier hook replaces it with false", async () => {
    const previous = vi.fn(async () => ({
      details: {
        status: "failed",
        code: "internal_error",
        error: "rewritten failure",
        failurePhase: "guest",
        bridgeDispatchStarted: false,
      },
    }));
    const agent = createAgent(previous);

    const result = await agent.afterToolOutcome?.(
      outcome({
        result: failedResult({
          failurePhase: "bridge",
          bridgeDispatchStarted: true,
        }),
      }),
    );

    expect(result).toMatchObject({
      terminate: true,
      details: {
        failurePhase: "bridge",
        bridgeDispatchStarted: true,
        repair: { allowed: false },
      },
    });
  });

  it("keeps a bridge failure when an earlier hook rewrites it as success", async () => {
    const previous = vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"status":"completed"}' }],
      details: { status: "completed" },
      isError: false,
      terminate: false,
    }));
    const agent = createAgent(previous);

    const result = await agent.afterToolOutcome?.(
      outcome({
        result: failedResult({
          failurePhase: "bridge",
          bridgeDispatchStarted: true,
        }),
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      terminate: true,
      details: {
        status: "failed",
        failurePhase: "bridge",
        bridgeDispatchStarted: true,
        repair: { allowed: false },
      },
    });
  });

  it("fails closed when an earlier outcome hook throws", async () => {
    const previous = vi.fn(async () => {
      throw new Error("hook exploded");
    });
    const agent = createAgent(previous);

    const result = await agent.afterToolOutcome?.(
      outcome({
        result: failedResult({
          failurePhase: "bridge",
          bridgeDispatchStarted: true,
        }),
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      terminate: true,
      details: {
        failurePhase: "bridge",
        bridgeDispatchStarted: true,
        repair: { allowed: false },
      },
    });
    expect(result?.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("hook exploded") }),
    ]);
  });

  it("preserves bounded partial output in the repair payload", async () => {
    const agent = createAgent();

    const result = await agent.afterToolOutcome?.(
      outcome({
        result: failedResult({
          output: [{ type: "text", text: "before failure" }],
        }),
      }),
    );
    const payload = JSON.parse(
      String(result?.content?.find((entry) => entry.type === "text")?.text),
    ) as Record<string, unknown>;

    expect(payload.output).toEqual([{ type: "text", text: "before failure" }]);
    expect(payload.repair).toMatchObject({ allowed: true, remainingAttempts: 1 });
  });

  it("fails closed when an executed failure lacks dispatch evidence", async () => {
    const agent = createAgent();

    const result = await agent.afterToolOutcome?.(
      outcome({
        result: {
          content: [{ type: "text", text: "unknown execution failure" }],
          details: {},
        },
        isError: true,
        executionStarted: true,
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      terminate: true,
      details: {
        failurePhase: "bridge",
        bridgeDispatchStarted: true,
        repair: { allowed: false, remainingAttempts: 0 },
      },
    });
  });

  it("preserves a terminal decision from an earlier outcome hook", async () => {
    const previous = vi.fn(async () => ({ terminate: true }));
    const agent = createAgent(previous);

    const result = await agent.afterToolOutcome?.(outcome({ result: failedResult() }));

    expect(result).toMatchObject({
      isError: true,
      terminate: true,
      details: { repair: { allowed: false, remainingAttempts: 0 } },
    });
  });

  it("keeps an original terminal decision when an earlier hook returns false", async () => {
    const previous = vi.fn(async () => ({ terminate: false }));
    const agent = createAgent(previous);
    const terminalFailure = failedResult();
    terminalFailure.terminate = true;

    const result = await agent.afterToolOutcome?.(
      outcome({
        result: terminalFailure,
      }),
    );

    expect(result).toMatchObject({
      terminate: true,
      details: { repair: { allowed: false, remainingAttempts: 0 } },
    });
  });

  it("keeps an original terminal success when an earlier hook rewrites it", async () => {
    const previous = vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"status":"completed","value":"rewritten"}' }],
      details: { status: "completed", value: "rewritten" },
      terminate: false,
    }));
    const agent = createAgent(previous);
    const terminalSuccess = completedResult();
    terminalSuccess.terminate = true;

    const result = await agent.afterToolOutcome?.(
      outcome({
        result: terminalSuccess,
      }),
    );

    expect(result).toMatchObject({
      details: { status: "completed", value: "rewritten" },
      terminate: true,
    });
  });

  it("terminates failed waits because their bridge work already started", async () => {
    const agent = createAgent();

    const result = await agent.afterToolOutcome?.(
      outcome({
        toolName: "wait",
        result: failedResult({ failurePhase: "host" }),
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      terminate: true,
      details: { repair: { allowed: false } },
    });
  });

  it("preserves a wait skipped by abort without spending the repair token", async () => {
    const previous = vi.fn(async () => undefined);
    const agent = createAgent(previous);
    const controller = new AbortController();
    controller.abort();
    const context = outcome({
      toolName: "wait",
      result: { content: [{ type: "text", text: "Operation aborted" }], details: {} },
      isError: true,
      executionStarted: false,
    });

    await expect(agent.afterToolOutcome?.(context, controller.signal)).resolves.toBeUndefined();
    expect(previous).toHaveBeenCalledWith(context, controller.signal);
    await expect(
      agent.afterToolOutcome?.(outcome({ result: failedResult() })),
    ).resolves.toMatchObject({
      terminate: false,
      details: { repair: { allowed: true, remainingAttempts: 1 } },
    });
  });

  it("leaves non-Code-Mode tools with the previously installed outcome hook", async () => {
    const previous = vi.fn(async () => ({ details: { previous: true } }));
    const agent = createAgent(previous);
    const context = outcome({ toolName: "read", result: completedResult() });

    await expect(agent.afterToolOutcome?.(context)).resolves.toEqual({
      details: { previous: true },
    });
    expect(previous).toHaveBeenCalledWith(context, undefined);
  });
});
