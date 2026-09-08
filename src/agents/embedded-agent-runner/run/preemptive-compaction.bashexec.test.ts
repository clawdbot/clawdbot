import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../../../../packages/agent-core/src/harness/messages.js";
import {
  estimateLlmBoundaryTokenPressure,
  shouldPreemptivelyCompactBeforePrompt,
} from "./preemptive-compaction.js";

const BIG_OUTPUT = "build log line ".repeat(90000);

function bashExecMessage(output = BIG_OUTPUT): AgentMessage {
  return {
    role: "bashExecution",
    command: "npm run build",
    output,
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 1,
  } as unknown as AgentMessage;
}

function compactionSummaryMessage(summary: string): AgentMessage {
  return {
    role: "compactionSummary",
    summary,
    tokensBefore: 0,
    timestamp: 1,
  } as unknown as AgentMessage;
}

function providerTokenApprox(message: AgentMessage): number {
  const [llm] = convertToLlm([message]);
  const content =
    llm && Array.isArray((llm as { content?: unknown }).content)
      ? (llm as { content: { type: string; text?: string }[] }).content
      : [];
  const text = content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  return Math.ceil(text.length / 4);
}

describe("preemptive precheck counts bashExecution and summary turns", () => {
  it("estimates a large bash turn near its provider-rendered size", () => {
    const msg = bashExecMessage();
    const realProviderTokens = providerTokenApprox(msg);
    const precheckTokens = estimateLlmBoundaryTokenPressure({ messages: [msg], prompt: "" });

    expect(realProviderTokens).toBeGreaterThan(50000);
    expect(precheckTokens).toBeGreaterThanOrEqual(realProviderTokens);
  });

  it("counts compactionSummary text instead of bare boundary overhead", () => {
    const msg = compactionSummaryMessage("recap ".repeat(20000));
    const realProviderTokens = providerTokenApprox(msg);
    const precheckTokens = estimateLlmBoundaryTokenPressure({ messages: [msg], prompt: "" });

    expect(realProviderTokens).toBeGreaterThan(20000);
    expect(precheckTokens).toBeGreaterThanOrEqual(realProviderTokens);
  });

  it.each([
    {
      role: "bashExecution",
      message: { ...bashExecMessage(), excludeFromContext: true } as AgentMessage,
    },
    {
      role: "custom",
      message: {
        role: "custom",
        customType: "display-note",
        content: BIG_OUTPUT,
        display: true,
        excludeFromContext: true,
        timestamp: 1,
      } satisfies AgentMessage,
    },
  ])("drops excluded $role turns from token pressure", ({ message }) => {
    expect(estimateLlmBoundaryTokenPressure({ messages: [message], prompt: "" })).toBeLessThan(50);
    expect(
      shouldPreemptivelyCompactBeforePrompt({
        messages: [message],
        prompt: "continue",
        contextTokenBudget: 128000,
        reserveTokens: 16384,
      }).route,
    ).toBe("fits");
  });

  it("counts undisplayed custom context when it remains model-visible", () => {
    const runtimeContext = {
      role: "custom",
      customType: "openclaw-runtime-context",
      content: BIG_OUTPUT,
      display: false,
      timestamp: 1,
    } satisfies AgentMessage;

    expect(
      estimateLlmBoundaryTokenPressure({ messages: [runtimeContext], prompt: "" }),
    ).toBeGreaterThan(50000);
  });

  it("routes an oversized bash transcript to compaction", () => {
    const decision = shouldPreemptivelyCompactBeforePrompt({
      messages: [bashExecMessage()],
      prompt: "continue",
      contextTokenBudget: 128000,
      reserveTokens: 16384,
    });

    expect(decision.route).not.toBe("fits");
    expect(decision.shouldCompact).toBe(true);
    expect(decision.overflowTokens).toBeGreaterThan(0);
  });
});
