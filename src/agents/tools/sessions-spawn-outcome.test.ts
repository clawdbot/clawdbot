import { realpath } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { buildPayloads } from "../embedded-agent-runner/run/payloads.test-helpers.js";
import { isToolResultError, registerTrustedToolNoStartError } from "../tool-result-error.js";
import { snapshotToolSearchTargetTranscriptResult } from "../tool-search-transcript.js";
import { createToolTerminalObserver } from "../tool-terminal-outcome.js";
import * as inProcessGateway from "./in-process-gateway.js";
import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";

const report = "Seven blue boxes remain. Thursday delivery is confirmed.";
const backendId = "spawn-effects-fixture";
const config: OpenClawConfig = {
  agents: { defaults: { subagents: { allowAgents: ["main"] } }, list: [{ id: "main" }] },
};

async function withSpawnConfig(cfg: OpenClawConfig, run: () => Promise<void>) {
  const previous = getRuntimeConfigSnapshot();
  const previousSource = getRuntimeConfigSourceSnapshot();
  const env = captureEnv(["OPENCLAW_STATE_DIR"]);
  registerAcpRuntimeBackend({
    id: backendId,
    runtime: {
      async ensureSession() {
        throw new Error("Fixture runtime initialization failed");
      },
      runTurn() {
        throw new Error("No turn can run before initialization");
      },
      async cancel() {},
      async close() {},
    },
  });
  try {
    await withTestDir({ prefix: "spawn-effects-" }, async (dir) => {
      const stateDir = await realpath(dir);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      setRuntimeConfigSnapshot(cfg);
      try {
        await run();
      } finally {
        await cleanupSessionStateForTest({ stateDir });
      }
    });
  } finally {
    unregisterAcpRuntimeBackend(backendId);
    env.restore();
    if (previous) {
      setRuntimeConfigSnapshot(previous, previousSource ?? undefined);
    } else {
      clearRuntimeConfigSnapshot();
    }
  }
}

function observeRecoveredSpawn(result: unknown, mutatingAction: boolean) {
  const observe = createToolTerminalObserver("recovered-spawn");
  const terminal = observe({
    toolCallId: "spawn",
    toolName: "sessions_spawn",
    arguments: { task: "Prepare report", visible: true },
    result,
    executionStarted: true,
    outcome: "failure",
    failure: { error: "spawn rejected" },
  });
  expect(terminal.lastToolError).toMatchObject({ mutatingAction });
  expect(terminal.sideEffectEvidence).toBe(mutatingAction);
  expect(terminal.effectReceipt.state).toBe(mutatingAction ? "uncertain" : "not_started");
  const recovered = observe({ toolName: "read", outcome: "success" });
  const payloads = buildPayloads({
    assistantTexts: [report],
    isHeartbeatTrigger: true,
    lastToolError: recovered.lastToolError,
  });
  expect(payloads.some((payload) => payload.text === report)).toBe(true);
  expect(
    payloads.some((payload) => getReplyPayloadMetadata(payload)?.heartbeatTerminalToolFailure),
  ).toBe(mutatingAction);
}

describe("sessions_spawn terminal effects", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { name: "target policy", args: { agentId: "excluded" } },
    { name: "invalid agent id", args: { agentId: "bad/name" } },
    { name: "invalid task name", args: { taskName: "invalid name" } },
    { name: "sandbox requirement", args: { sandbox: "require" } },
    { name: "capacity", args: {}, activeChildren: 1 },
    {
      name: "required agent id",
      args: {},
      subagents: { requireAgentId: true },
    },
  ])("keeps recovered $name rejection out of heartbeat failure", async (testCase) => {
    const callGateway = vi.spyOn(inProcessGateway, "callInProcessGatewayTool");
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: {
        ...config,
        agents: {
          ...config.agents,
          defaults: { subagents: { maxChildrenPerAgent: 1, ...testCase.subagents } },
        },
      },
      callGateway: inProcessGateway.callInProcessGatewayTool,
      countActiveRuns: () => testCase.activeChildren ?? 0,
    });
    const result = await tool.execute("spawn", {
      task: "Prepare report",
      visible: true,
      ...testCase.args,
    });
    expect(isToolResultError(result)).toBe(true);
    expect(callGateway).not.toHaveBeenCalled();
    observeRecoveredSpawn(result, false);
    observeRecoveredSpawn(snapshotToolSearchTargetTranscriptResult(result), false);
  });

  it("keeps an internal argument exception out of heartbeat failure", async () => {
    const tool = createSessionsSpawnTool({ config, countActiveRuns: () => 0 });
    const error = await tool
      .execute("spawn", {
        task: "Prepare report",
        visible: true,
        thinking: "low",
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    observeRecoveredSpawn(error, false);
  });

  it.each([
    {
      name: "hidden target policy",
      args: { runtime: "subagent", visible: false, agentId: "excluded" },
      cfg: config,
      mutatingAction: false,
      details: { status: "forbidden" },
    },
    {
      name: "hidden sandbox rejection after admission",
      args: { runtime: "subagent", visible: false, sandbox: "require" },
      cfg: config,
      mutatingAction: true,
      details: { status: "forbidden" },
    },
    {
      name: "ACP unavailable policy",
      args: { runtime: "acp", agentId: "fixture" },
      cfg: { ...config, acp: { enabled: false } },
      mutatingAction: false,
      details: { status: "error" },
    },
    {
      name: "ACP sandbox policy",
      args: { runtime: "acp", agentId: "fixture", sandbox: "require" },
      cfg: { ...config, acp: { enabled: true, backend: backendId } },
      mutatingAction: false,
      details: { status: "forbidden", errorCode: "runtime_policy" },
    },
    {
      name: "ACP initialization failure after session creation",
      args: { runtime: "acp", agentId: "fixture" },
      cfg: {
        ...config,
        acp: { enabled: true, backend: backendId, allowedAgents: ["fixture"] },
      },
      mutatingAction: true,
      details: { status: "error", errorCode: "spawn_failed" },
    },
  ])("classifies $name at its owning effect boundary", async (testCase) => {
    await withSpawnConfig(testCase.cfg, async () => {
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        config: testCase.cfg,
      });
      const result = await tool.execute("spawn", { task: "Prepare report", ...testCase.args });
      expect(result.details).toMatchObject(testCase.details);
      observeRecoveredSpawn(result, testCase.mutatingAction);
    });
  });

  it("rejects a sandbox cwd before reserving or creating a child", async () => {
    await withTestDir({ prefix: "spawn-outcome-" }, async (dir) => {
      const workspace = await realpath(dir);
      const callGateway = vi.spyOn(inProcessGateway, "callInProcessGatewayTool");
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        config: {
          agents: {
            defaults: { sandbox: { mode: "all" } },
            list: [{ id: "main", workspace }],
          },
        },
        callGateway: inProcessGateway.callInProcessGatewayTool,
        countActiveRuns: () => 0,
      });
      const result = await tool.execute("spawn", {
        task: "Prepare report",
        visible: true,
        cwd: path.join(workspace, "..", "outside"),
      });
      expect(result.details).toMatchObject({ status: "forbidden" });
      expect(callGateway).not.toHaveBeenCalled();
      observeRecoveredSpawn(result, false);
    });
  });

  it.each([false, true])(
    "preserves dispatch failure with nested no-start proof: %s",
    async (nestedNoStart) => {
      const failure = new Error("Gateway disconnected");
      if (nestedNoStart) {
        registerTrustedToolNoStartError(failure);
      }
      const callGateway = vi
        .spyOn(inProcessGateway, "callInProcessGatewayTool")
        .mockRejectedValue(failure);
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        config,
        callGateway: inProcessGateway.callInProcessGatewayTool,
        countActiveRuns: () => 0,
      });
      const error = await tool
        .execute("spawn", { task: "Prepare report", visible: true })
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect(callGateway).toHaveBeenCalledOnce();
      observeRecoveredSpawn(error, true);
    },
  );

  it("preserves a failure after a child run was created", async () => {
    vi.spyOn(inProcessGateway, "callInProcessGatewayTool")
      .mockResolvedValueOnce({
        key: "agent:main:dashboard:child",
        sessionId: "child",
        runId: "child-run",
        runStarted: true,
      })
      .mockResolvedValue({ ok: true });
    const registerRun = vi.fn(() => {
      throw new Error("registration unavailable");
    });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config,
      callGateway: inProcessGateway.callInProcessGatewayTool,
      registerRun,
      countActiveRuns: () => 0,
    });
    const result = await tool.execute("spawn", { task: "Prepare report", visible: true });
    expect(registerRun).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({
      status: "error",
      childSessionKey: "agent:main:dashboard:child",
    });
    observeRecoveredSpawn(result, true);
  });

  it("records a successful allowed spawn as a committed mutation", async () => {
    vi.spyOn(inProcessGateway, "callInProcessGatewayTool").mockResolvedValue({
      key: "agent:main:dashboard:child",
      sessionId: "child",
      runId: "child-run",
      runStarted: true,
    });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config,
      callGateway: inProcessGateway.callInProcessGatewayTool,
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
    });
    const result = await tool.execute("spawn", { task: "Prepare report", visible: true });
    expect(result.details).toMatchObject({ status: "accepted" });
    const terminal = createToolTerminalObserver("allowed-spawn")({
      toolName: "sessions_spawn",
      result,
      outcome: "success",
      executionStarted: true,
    });
    expect(terminal).toMatchObject({
      executionStarted: true,
      sideEffectEvidence: true,
      effectReceipt: { state: "mutation_committed" },
    });
  });

  it("does not accept public no-start fields as host proof", () => {
    observeRecoveredSpawn(
      {
        content: [],
        details: { status: "error", executionStarted: false },
        effectReceipt: { state: "not_started" },
      },
      true,
    );
  });
});
