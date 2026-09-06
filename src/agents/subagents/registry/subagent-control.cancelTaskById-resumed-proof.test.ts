/**
 * Real-behavior proof for #140354: cancelling a resumed subagent task by its
 * stable task ID through the real `cancelTaskById` → `killSubagentRunAdmin`
 * flow, reaching terminal task state.
 *
 * The subagent run is registered through the real registry API, then replaced
 * through `replaceSubagentRunAfterSteerCore` (the same path `sessions_send`
 * resume uses), producing a generation-2 run that retains the stable
 * `taskRunId` while advancing to a fresh execution `runId`.
 *
 * The task registry holds a task whose `runId` is the stable task identity.
 * `cancelTaskById` resolves that identity at the `expectedRunId` guard in
 * `killSubagentRunAdmin`, stops the session work, and promotes the task to
 * terminal `cancelled` status.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { publishTaskRecordAfterAtomicStore } from "../../../tasks/task-registry-mutation.js";
import { createTaskRecord } from "../../../tasks/task-registry-record-api.js";
import { cancelTaskById, getTaskById } from "../../../tasks/task-registry.js";
import {
  resetTaskRegistryForTests,
  resetTaskRegistryControlRuntimeForTests,
  setTaskRegistryControlRuntimeForTests,
} from "../../../tasks/task-registry.test-support.js";
import { killSubagentRunAdmin } from "./subagent-control.js";
import { replaceSubagentRunAfterSteerCore } from "./subagent-registry.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";

type ControlRuntime = typeof import("./subagent-control.runtime.js");

const controlRuntimeMocks = vi.hoisted(() => ({
  abortEmbeddedAgentRun: vi.fn<ControlRuntime["abortEmbeddedAgentRun"]>(() => false),
  isEmbeddedAgentRunActive: vi.fn<ControlRuntime["isEmbeddedAgentRunActive"]>(() => false),
  clearSessionQueues: vi.fn<ControlRuntime["clearSessionQueues"]>(() => ({
    followupCleared: 0,
    laneCleared: 0,
    keys: [],
  })),
}));

vi.mock("./subagent-control.runtime.js", () => controlRuntimeMocks);

vi.mock("../../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../config/sessions/session-accessor.js")>();
  return { ...actual, patchSessionEntryCore: vi.fn(actual.patchSessionEntryCore) };
});

const { patchSessionEntryCore: patchCanonicalSessionEntry } = await vi.importActual<
  typeof import("../../../config/sessions/session-accessor.js")
>("../../../config/sessions/session-accessor.js");

vi.mock("../../../gateway/call.js", () => ({
  callGateway: vi.fn(async (request: { method: string }) =>
    request.method === "agent.wait" ? { status: "pending" } : {},
  ),
}));

const detachedTaskRuntimeMocks = vi.hoisted(() => ({
  findDetachedTaskRun: vi.fn(() => ({ lookup: "available" as const })),
  finalizeTaskRunByRunId: vi.fn<(_params: unknown) => unknown[]>(() => []),
}));

vi.mock("../../../tasks/detached-task-runtime.js", () => ({
  createQueuedTaskRun: vi.fn(() => null),
  createRunningTaskRun: vi.fn(() => null),
  startTaskRunByRunId: vi.fn(() => []),
  recordTaskRunProgressByRunId: vi.fn(() => []),
  finalizeTaskRunByRunId: detachedTaskRuntimeMocks.finalizeTaskRunByRunId,
  completeTaskRunByRunId: vi.fn(() => []),
  failTaskRunByRunId: vi.fn(() => []),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(() => []),
  findDetachedTaskRun: detachedTaskRuntimeMocks.findDetachedTaskRun,
}));

let tempRoot = "";
let tempStoreIndex = 0;

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cancel-proof-"));
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function nextSessionStorePath(label: string) {
  tempStoreIndex += 1;
  return path.join(tempRoot, `${tempStoreIndex}-${label}.json`);
}

function cfgWithSessionStore(storePath = nextSessionStorePath("sessions")): OpenClawConfig {
  return { session: { store: storePath } } as OpenClawConfig;
}

async function writeSessionStoreFixture(label: string, store: Record<string, unknown>) {
  const storePath = nextSessionStorePath(label);
  await fs.promises.writeFile(storePath, JSON.stringify(store));
  return storePath;
}

function mockSessionPatchForStore(storePath: string, implementation: typeof patchSessionEntryCore) {
  vi.mocked(patchSessionEntryCore).mockImplementation((scope, patcher, options) =>
    scope.storePath === storePath
      ? implementation(scope, patcher, options)
      : patchCanonicalSessionEntry(scope, patcher, options),
  );
}

describe("cancelTaskById real-behavior proof: resumed task cancellation (#140354)", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskRegistryControlRuntimeForTests();
    controlRuntimeMocks.abortEmbeddedAgentRun.mockReset();
    controlRuntimeMocks.isEmbeddedAgentRunActive.mockReset();
    controlRuntimeMocks.clearSessionQueues.mockReset();
    detachedTaskRuntimeMocks.finalizeTaskRunByRunId.mockReset();
    detachedTaskRuntimeMocks.findDetachedTaskRun.mockReset();
  });

  it("cancels a resumed subagent task by its stable task ID and reaches terminal state", async () => {
    // ---- Arrange: real task + real subagent run resumed through the replacement API ----
    const childSessionKey = "agent:main:subagent:resumed-proof";
    const storePath = await writeSessionStoreFixture("proof-sessions", {
      [childSessionKey]: {
        sessionId: "sess-proof",
        updatedAt: Date.now(),
      },
    });

    // Route session patches to the real store for this test's session key.
    vi.mocked(patchSessionEntryCore).mockReset();
    mockSessionPatchForStore(storePath, patchCanonicalSessionEntry);

    // Generation 1: the original run before yield.
    addSubagentRunForTests({
      runId: "execution-A1",
      taskRunId: "stable-A",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "investigate issue #140354",
      cleanup: "keep",
      generation: 1,
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });

    // Resume: replaceSubagentRunAfterSteerCore is the same path sessions_send
    // continuation uses — it produces a generation-2 run with a fresh runId
    // that retains the stable taskRunId.
    const replaced = replaceSubagentRunAfterSteerCore({
      previousRunId: "execution-A1",
      nextRunId: "execution-A2",
    });
    expect(replaced).toBe(true);

    const resumedRun = getSubagentRunByChildSessionKey(childSessionKey)!;
    expect(resumedRun.runId).toBe("execution-A2");
    expect(resumedRun.taskRunId).toBe("stable-A");
    expect(resumedRun.generation).toBe(2);

    // Real task registry record keyed by the stable task runId.
    const task = createTaskRecord({
      runtime: "subagent",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey,
      task: "investigate issue #140354",
      runId: "stable-A",
      status: "running",
      deliveryStatus: "pending",
    })!;
    publishTaskRecordAfterAtomicStore(task);
    expect(getTaskById(task.taskId)?.status).toBe("running");

    // Wire the REAL killSubagentRunAdmin into the task control runtime so
    // cancelTaskById exercises the actual guard at line 497.
    setTaskRegistryControlRuntimeForTests({
      cancelActiveCronTaskRun: vi.fn(() => false),
      getAcpSessionManager: vi.fn(() => ({
        cancelSession: vi.fn(),
      })),
      killSubagentRunAdmin,
    });

    const cfg = cfgWithSessionStore(storePath);

    // ---- Act: cancel by task ID (the stable identity) ----
    const result = await cancelTaskById({ cfg, taskId: task.taskId });

    // ---- Assert: found + killed + terminal task state ----
    expect(result.found).toBe(true);
    expect(result.cancelled).toBe(true);

    const finalTask = getTaskById(task.taskId)!;
    expect(finalTask.status).toBe("cancelled");

    // The resumed subagent run itself reached terminal state (killed tombstone).
    const finalRun = getSubagentRunByChildSessionKey(childSessionKey)!;
    expect(finalRun.execution.endedAt).toBeTypeOf("number");
    expect(finalRun.endedReason).toBe("subagent-killed");

    // Task finalization used the stable task runId, not the execution runId.
    expect(detachedTaskRuntimeMocks.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "stable-A",
        runtime: "subagent",
        sessionKey: childSessionKey,
        status: "cancelled",
      }),
    );

    // ---- Proof log output (captured for the PR body) ----
    const proof = {
      scenario: "resumed subagent task cancelled by stable task ID",
      issue: 140354,
      task: {
        taskId: task.taskId,
        runId: "stable-A",
        runtime: "subagent",
        childSessionKey,
        before: "running",
        after: finalTask.status,
      },
      subagentRun: {
        executionRunId: resumedRun.runId,
        stableTaskRunId: resumedRun.taskRunId,
        generation: resumedRun.generation,
        endedAt: resumedRun.execution.endedAt,
      },
      cancellation: {
        found: result.found,
        cancelled: result.cancelled,
        finalizedByRunId: "stable-A",
      },
      subagentTerminalState: {
        endedAt: finalRun.execution.endedAt,
        endedReason: finalRun.endedReason,
      },
    };
    console.log("PROOF_OUTPUT_START");
    console.log(JSON.stringify(proof, null, 2));
    console.log("PROOF_OUTPUT_END");
  });
});
