import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  callGatewayMock,
  setSubagentsConfigOverride,
} from "./openclaw-tools.subagents.test-harness.js";
import {
  addSubagentRunForTests,
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";

describe("openclaw-tools: subagents steer failure", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockClear();
    const storePath = path.join(
      os.tmpdir(),
      `openclaw-subagents-steer-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    setSubagentsConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
        store: storePath,
      },
    });
    fs.writeFileSync(storePath, "{}", "utf-8");
  });

  it("restores announce behavior when steer replacement dispatch fails", async () => {
    addSubagentRunForTests({
      runId: "run-old",
      childSessionKey: "agent:main:subagent:worker",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do work",
      cleanup: "keep",
      createdAt: Date.now(),
      startedAt: Date.now(),
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      if (request.method === "agent") {
        throw new Error("dispatch failed");
      }
      return {};
    });

    const tool = createSubagentsTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-steer", {
      action: "steer",
      target: "1",
      message: "new direction",
    });

    const details = result.details as {
      status?: string;
      action?: string;
      runId?: unknown;
      error?: string;
    };
    expect(details.status).toBe("error");
    expect(details.action).toBe("steer");
    expect(details.runId).toBeTypeOf("string");
    expect(details.error).toBe("dispatch failed");

    const runs = listSubagentRunsForRequester("agent:main:main");
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe("run-old");
    expect(runs[0].suppressAnnounceReason).toBeUndefined();
  });
});
