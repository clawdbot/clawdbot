import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ReplyPayload } from "../types.js";
import { handleSubagentsLogAction } from "./commands-subagents/action-log.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: (params: unknown) => callGatewayMock(params),
}));

function makeRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-subagent-log",
    childSessionKey: "agent:main:subagent:log",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "inspect logs",
    cleanup: "keep",
    createdAt: Date.now() - 10_000,
    startedAt: Date.now() - 10_000,
    ...overrides,
  };
}

function buildLogContext(restTokens: string[], runs: SubagentRunRecord[]) {
  return {
    params: {
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:main",
    },
    handledPrefix: "/subagents",
    requesterKey: "agent:main:main",
    runs,
    restTokens,
  } as Parameters<typeof handleSubagentsLogAction>[0];
}

function requireReplyText(reply: ReplyPayload | undefined): string {
  if (reply?.text === undefined) {
    throw new Error("expected reply text");
  }
  return reply.text;
}

beforeEach(() => {
  callGatewayMock.mockReset();
  callGatewayMock.mockResolvedValue({
    messages: [{ role: "assistant", content: "log line" }],
  });
});

describe("subagents log", () => {
  it("does not treat a numeric target as the history limit", async () => {
    const result = await handleSubagentsLogAction(buildLogContext(["1"], [makeRun()]));

    expect(result.shouldContinue).toBe(false);
    expect(requireReplyText(result.reply)).toContain("log line");
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:subagent:log", limit: 20 },
    });
  });

  it("uses the numeric token after the target as the history limit", async () => {
    await handleSubagentsLogAction(buildLogContext(["1", "5"], [makeRun()]));

    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:subagent:log", limit: 5 },
    });
  });
});
