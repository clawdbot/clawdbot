// Verifies subagents list only exposes runs owned by the caller's subtree.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  callGatewayMock,
  resetSubagentsConfigOverride,
  setSubagentsConfigOverride,
} from "./openclaw-tools.subagents.test-harness.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import { createPerSenderSessionConfig } from "./test-helpers/session-config.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";

function writeStore(storePath: string, store: Record<string, unknown>) {
  // Scope tests use a real session-store file so spawnedBy lookups match runtime behavior.
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
}

describe("openclaw-tools: subagents scope isolation", () => {
  let storePath = "";

  beforeEach(() => {
    resetSubagentRegistryForTests();
    resetSubagentsConfigOverride();
    callGatewayMock.mockReset();
    storePath = path.join(
      os.tmpdir(),
      `openclaw-subagents-scope-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    setSubagentsConfigOverride({
      session: createPerSenderSessionConfig({ store: storePath }),
    });
    writeStore(storePath, {});
  });

  it("leaf subagents do not inherit parent sibling control scope", async () => {
    const leafKey = "agent:main:subagent:leaf";
    const siblingKey = "agent:main:subagent:unsandboxed";

    writeStore(storePath, {
      [leafKey]: {
        sessionId: "leaf-session",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
      },
      [siblingKey]: {
        sessionId: "sibling-session",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
      },
    });

    addSubagentRunForTests({
      runId: "run-leaf",
      childSessionKey: leafKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "sandboxed leaf",
      cleanup: "keep",
      createdAt: Date.now() - 30_000,
      startedAt: Date.now() - 30_000,
    });
    addSubagentRunForTests({
      runId: "run-sibling",
      childSessionKey: siblingKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "unsandboxed sibling",
      cleanup: "keep",
      createdAt: Date.now() - 20_000,
      startedAt: Date.now() - 20_000,
    });

    const tool = createSubagentsTool({ agentSessionKey: leafKey });
    const result = await tool.execute("call-leaf-list", { action: "list" });

    const details = result.details as {
      status?: string;
      requesterSessionKey?: string;
      callerSessionKey?: string;
      callerIsSubagent?: boolean;
      total?: number;
      active?: unknown[];
      recent?: unknown[];
    };
    expect(details.status).toBe("ok");
    expect(details.requesterSessionKey).toBe(leafKey);
    expect(details.callerSessionKey).toBe(leafKey);
    expect(details.callerIsSubagent).toBe(true);
    expect(details.total).toBe(0);
    expect(details.active).toEqual([]);
    expect(details.recent).toEqual([]);
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("orchestrator subagents still see children they spawned", async () => {
    const orchestratorKey = "agent:main:subagent:orchestrator";
    const workerKey = `${orchestratorKey}:subagent:worker`;
    const siblingKey = "agent:main:subagent:sibling";

    writeStore(storePath, {
      [orchestratorKey]: {
        sessionId: "orchestrator-session",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
      },
      [workerKey]: {
        sessionId: "worker-session",
        updatedAt: Date.now(),
        spawnedBy: orchestratorKey,
      },
      [siblingKey]: {
        sessionId: "sibling-session",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
      },
    });

    addSubagentRunForTests({
      runId: "run-worker",
      childSessionKey: workerKey,
      requesterSessionKey: orchestratorKey,
      requesterDisplayKey: orchestratorKey,
      task: "worker child",
      cleanup: "keep",
      createdAt: Date.now() - 30_000,
      startedAt: Date.now() - 30_000,
    });
    addSubagentRunForTests({
      runId: "run-sibling",
      childSessionKey: siblingKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "sibling of orchestrator",
      cleanup: "keep",
      createdAt: Date.now() - 20_000,
      startedAt: Date.now() - 20_000,
    });

    const tool = createSubagentsTool({ agentSessionKey: orchestratorKey });
    const result = await tool.execute("call-orchestrator-list", { action: "list" });
    const details = result.details as {
      status?: string;
      requesterSessionKey?: string;
      total?: number;
      active?: Array<{ sessionKey?: string }>;
    };

    expect(details.status).toBe("ok");
    expect(details.requesterSessionKey).toBe(orchestratorKey);
    expect(details.total).toBe(1);
    expect(details.active).toHaveLength(1);
    expect(details.active?.[0]?.sessionKey).toBe(workerKey);
  });
});
