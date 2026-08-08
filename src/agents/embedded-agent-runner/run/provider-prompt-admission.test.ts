import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import type { ToolResultPromptProjectionState } from "../session-prompt-state.js";
import { estimateLlmBoundaryTokenPressure } from "./preemptive-compaction.js";
import { admitProviderPrompt } from "./provider-prompt-admission.js";

type ProviderContext = Parameters<StreamFn>[1];

function makeProjectionState(): ToolResultPromptProjectionState {
  return {
    replacements: new Map(),
    frozen: new Set(),
    ambiguousBaseKeys: new Set(),
    sourceTextByKey: new Map(),
  };
}

function makeToolResult(index: number, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call-${index}`,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: index + 1,
  } as AgentMessage;
}

function admit(
  context: ProviderContext,
  projectionState = makeProjectionState(),
  overrides: Partial<Parameters<typeof admitProviderPrompt>[0]> = {},
) {
  return admitProviderPrompt({
    context,
    contextTokenBudget: 20_000,
    midTurnPrecheckEnabled: true,
    reserveTokens: 4_000,
    toolResultAggregateMaxChars: 1_000_000,
    toolResultMaxChars: 64_000,
    projectionState,
    ...overrides,
  });
}

describe("provider prompt admission", () => {
  it("measures provider tool schemas alongside compactable history", () => {
    const context = {
      messages: [
        { role: "user", content: "earlier prompt", timestamp: 1 },
        { role: "assistant", content: "h".repeat(8_000), timestamp: 2 },
        { role: "user", content: "small prompt", timestamp: 3 },
      ],
      tools: [
        {
          name: "large_tool",
          description: "x".repeat(5_000),
          parameters: { type: "object", properties: {} },
        },
      ],
    } as ProviderContext;

    const result = admit(context, undefined, {
      contextTokenBudget: 4_000,
      reserveTokens: 1_000,
    });

    expect(result.status).toBe("recovery_required");
    if (result.status === "recovery_required") {
      expect(result.request.route).toBe("compact_only");
      expect(result.request).not.toHaveProperty("toolResultAggregateBudgetChars");
      expect(result.request.estimatedPromptTokens).toBeGreaterThan(
        result.request.promptBudgetBeforeReserve,
      );
    }
  });

  it("includes a managed provider cache prefix in admission accounting", () => {
    const context = {
      messages: [{ role: "user", content: "m".repeat(4_000), timestamp: 1 }],
    } as ProviderContext;
    const limits = {
      contextTokenBudget: 4_000,
      reserveTokens: 1_000,
    };

    expect(admit(context, undefined, limits).status).toBe("ready");

    const result = admit(context, undefined, {
      ...limits,
      accountingContext: {
        systemPrompt: "cached system prompt ".repeat(400),
        tools: [],
      },
    });

    expect(result.status).toBe("recovery_required");
    if (result.status === "recovery_required") {
      expect(result.request.estimatedPromptTokens).toBeGreaterThan(
        result.request.promptBudgetBeforeReserve,
      );
    }
  });

  it("routes a near-budget prompt after a provider-native tool is added", () => {
    const context = {
      messages: [{ role: "user", content: "m".repeat(4_000), timestamp: 1 }],
      tools: [],
    } as ProviderContext;
    const baseEstimate = estimateLlmBoundaryTokenPressure({
      messages: context.messages as AgentMessage[],
      prompt: "",
      tools: [],
    });
    const limits = {
      contextTokenBudget: baseEstimate + 1,
      reserveTokens: 0,
    };

    expect(admit(context, undefined, limits).status).toBe("ready");

    const result = admit(context, undefined, {
      ...limits,
      accountingContext: {
        tools: [{ type: "web_search", external_web_access: false }],
      },
    });

    expect(result.status).toBe("recovery_required");
  });

  it("defers tool-schema-only pressure to the provider", () => {
    const context = {
      messages: [{ role: "user", content: "small prompt", timestamp: 1 }],
      tools: [
        {
          name: "large_tool",
          description: "x".repeat(30_000),
          parameters: { type: "object", properties: {} },
        },
      ],
    } as ProviderContext;

    const result = admit(context, undefined, {
      contextTokenBudget: 4_000,
      reserveTokens: 1_000,
    });

    expect(result.status).toBe("ready");
  });

  it("does not recover for large runtime-only tool metadata", () => {
    const context = {
      messages: [{ role: "user", content: "small prompt", timestamp: 1 }],
      tools: [
        {
          name: "small_tool",
          description: "small description",
          parameters: { type: "object", properties: {} },
          label: "x".repeat(30_000),
          outputSchema: { description: "y".repeat(30_000) },
        },
      ],
    } as unknown as ProviderContext;

    const result = admit(context, undefined, {
      contextTokenBudget: 4_000,
      reserveTokens: 1_000,
    });

    expect(result.status).toBe("ready");
  });

  it("admits a tighter provider-only tool-result projection in the same attempt", () => {
    const messages = [
      { role: "user", content: "inspect the results", timestamp: 1 } as AgentMessage,
      ...Array.from({ length: 12 }, (_, index) => makeToolResult(index, "x".repeat(3_000))),
    ];
    const context = {
      systemPrompt: "system",
      messages,
      tools: [],
    } as ProviderContext;

    const result = admit(context);

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.context).not.toBe(context);
      expect(result.context.systemPrompt).toBe(context.systemPrompt);
      expect(result.context.tools).toBe(context.tools);
      expect(result.context.messages).not.toBe(messages);
      expect(result.projectionState.replacements.size).toBeGreaterThan(0);
    }
    expect(
      messages.slice(1).every((message) => {
        const block = message.role === "toolResult" ? message.content[0] : undefined;
        return block?.type === "text" && block.text.length === 3_000;
      }),
    ).toBe(true);
  });

  it("does not mutate projection state when a candidate still needs recovery", () => {
    const projectionState = makeProjectionState();
    projectionState.frozen.add("existing");
    const before = {
      replacements: new Map(projectionState.replacements),
      frozen: new Set(projectionState.frozen),
      ambiguousBaseKeys: new Set(projectionState.ambiguousBaseKeys),
      sourceTextByKey: new Map(projectionState.sourceTextByKey),
    };
    const context = {
      messages: [
        { role: "user", content: "u".repeat(100_000), timestamp: 1 },
        makeToolResult(1, "small result"),
      ],
    } as ProviderContext;

    const result = admit(context, projectionState, {
      contextTokenBudget: 4_000,
      reserveTokens: 1_000,
    });

    expect(result.status).toBe("recovery_required");
    expect(projectionState).toEqual(before);
  });
});
