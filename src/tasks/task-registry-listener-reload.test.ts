import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resetTaskRegistryForTests } from "./task-runtime.test-helpers.js";

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
let stateDir = "";

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-task-listener-reload-"));
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  resetTaskRegistryForTests();
  resetAgentEventsForTest();
});

afterEach(async () => {
  resetTaskRegistryForTests();
  resetAgentEventsForTest();
  envSnapshot.restore();
  await fs.rm(stateDir, { recursive: true, force: true });
});

function createToolActivityTask(registry: typeof import("./task-registry.js"), runId: string) {
  return expectDefined(
    registry.createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:activity",
      runId,
      task: "Track tool activity",
      status: "running",
      deliveryStatus: "not_applicable",
    }),
    "task registry reload fixture",
  );
}

describe("task registry listener reload", () => {
  it("keeps one agent-event listener across module reloads", async () => {
    const firstRegistry = await import("./task-registry.js");
    const firstTask = createToolActivityTask(firstRegistry, "run-before-reload");
    emitAgentEvent({
      runId: "run-before-reload",
      stream: "tool",
      data: { phase: "start", name: "read", toolCallId: "call-before" },
    });
    expect(firstRegistry.getTaskById(firstTask.taskId)?.toolUseCount).toBe(1);

    // The module cache reset intentionally abandons the first store module;
    // close its native handle without stopping the listener under test.
    closeOpenClawStateDatabaseForTest();
    vi.resetModules();
    const reloadedRegistry = await import("./task-registry.js");
    resetTaskRegistryForTests();
    const task = createToolActivityTask(reloadedRegistry, "run-after-reload");

    emitAgentEvent({
      runId: "run-after-reload",
      stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "call-after" },
    });

    expect(reloadedRegistry.getTaskById(task.taskId)?.toolUseCount).toBe(1);
    expect(reloadedRegistry.getTaskById(task.taskId)?.lastToolName).toBe("exec");
  });
});
