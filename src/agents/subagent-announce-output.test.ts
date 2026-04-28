import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, readSubagentOutput } from "./subagent-announce-output.js";

type CallGateway = typeof import("../gateway/call.js").callGateway;
type ReadLatestAssistantReply = typeof import("./tools/agent-step.js").readLatestAssistantReply;

function installOutputDeps(params: { messages: Array<unknown>; latestAssistantReply?: string }) {
  const callGateway = vi.fn(async () => ({ messages: params.messages }));
  const readLatestAssistantReply = vi.fn(async () => params.latestAssistantReply);
  __testing.setDepsForTest({
    callGateway: callGateway as unknown as CallGateway,
    readLatestAssistantReply: readLatestAssistantReply as unknown as ReadLatestAssistantReply,
  });
  return { callGateway, readLatestAssistantReply };
}

function sessionsYieldTurn(message = "Waiting for subagent completion.") {
  return [
    {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "text", text: message },
        {
          type: "toolCall",
          id: "call-yield",
          name: "sessions_yield",
          arguments: { message },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-yield",
      toolName: "sessions_yield",
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "yielded", message }, null, 2),
        },
      ],
      details: { status: "yielded", message },
    },
  ];
}

describe("readSubagentOutput", () => {
  afterEach(() => {
    __testing.setDepsForTest();
  });

  it("does not treat a sessions_yield wait turn as subagent completion output", async () => {
    const deps = installOutputDeps({
      messages: sessionsYieldTurn(),
      latestAssistantReply: "Waiting for subagent completion.",
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBeUndefined();
    expect(deps.readLatestAssistantReply).not.toHaveBeenCalled();
  });

  it("returns final assistant output that arrives after a sessions_yield wait turn", async () => {
    installOutputDeps({
      messages: [
        ...sessionsYieldTurn(),
        {
          role: "system",
          content: [{ type: "text", text: "Compaction" }],
          __openclaw: { kind: "compaction" },
        },
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Created /tmp/final-deck.pptx" }],
        },
      ],
      latestAssistantReply: "Waiting for subagent completion.",
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBe(
      "Created /tmp/final-deck.pptx",
    );
  });

  it("keeps normal tool-use assistant output when the tool is not sessions_yield", async () => {
    installOutputDeps({
      messages: [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "text", text: "Mapped the code path." },
            { type: "toolCall", id: "call-read", name: "read", arguments: {} },
          ],
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBe(
      "Mapped the code path.",
    );
  });
});
