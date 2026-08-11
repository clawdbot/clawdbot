// Subagent registry persistence-resume tests cover restoring SQLite-backed child runs.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import { closeOpenClawStateDatabaseForTest as closeSeedStateDatabase } from "../../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import {
  createSubagentRegistryTestDeps,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const { announceSpy } = vi.hoisted(() => ({
  announceSpy: vi.fn(async () => true),
}));
vi.mock("../announce/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));
let mod: typeof import("./subagent-registry.test-helpers.js");
let callGatewayModule: typeof import("../../../gateway/call.js");
let agentEventsModule: typeof import("../../../infra/agent-events.js");
let registryStateDbModule: typeof import("../../../state/openclaw-state-db.js");

describe("subagent registry persistence resume", () => {
  let tempStateDir: string | null = null;

  beforeAll(async () => {
    vi.resetModules();
    mod = await import("./subagent-registry.test-helpers.js");
    callGatewayModule = await import("../../../gateway/call.js");
    agentEventsModule = await import("../../../infra/agent-events.js");
    registryStateDbModule = await import("../../../state/openclaw-state-db.js");
  });

  beforeEach(() => {
    announceSpy.mockClear();
    vi.mocked(callGatewayModule.callGateway).mockReset().mockResolvedValue({
      status: "ok",
      startedAt: 111,
      endedAt: 222,
    });
    mod.testing.setDepsForTest({
      ...createSubagentRegistryTestDeps({
        callGateway: vi.mocked(callGatewayModule.callGateway),
        captureSubagentCompletionReply: vi.fn(async () => undefined),
      }),
    });
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.mocked(agentEventsModule.onAgentEvent)
      .mockReset()
      .mockReturnValue(() => undefined);
  });

  afterEach(async () => {
    closeSeedStateDatabase();
    registryStateDbModule.closeOpenClawStateDatabaseForTest();
    mod.testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
    await cleanupSessionStateForTest();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
  });

  it("resumes a persisted run from canonical SQLite state", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    const stateDir = tempStateDir;
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const run: SubagentRunRecord = {
        runId: "run-1",
        childSessionKey: "agent:main:subagent:test",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: { channel: "whatsapp", accountId: "acct-main" },
        requesterDisplayKey: "main",
        task: "do the thing",
        cleanup: "keep",
        createdAt: Date.now(),
        execution: { status: "running" },
        completion: { required: false },
        delivery: { status: "not_required" },
      };
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      await writeSubagentSessionEntry({
        stateDir,
        agentId: "main",
        sessionKey: run.childSessionKey,
        sessionId: "sess-test",
        defaultSessionId: "sess-test",
      });

      mod.initSubagentRegistry();

      await vi.waitFor(() => expect(announceSpy).toHaveBeenCalled(), {
        timeout: 1_000,
        interval: 10,
      });
      const announce = (announceSpy.mock.calls as unknown as Array<[unknown]>).at(-1)?.[0] as
        | {
            childRunId?: string;
            requesterOrigin?: { channel?: string; accountId?: string };
            outcome?: { status?: string };
          }
        | undefined;
      expect(announce).toMatchObject({
        childRunId: "run-1",
        requesterOrigin: { channel: "whatsapp", accountId: "acct-main" },
        outcome: { status: "ok" },
      });
      expect(mod.listSubagentRunsForRequester("agent:main:main")[0]).toMatchObject({
        childSessionKey: run.childSessionKey,
        requesterOrigin: { channel: "whatsapp", accountId: "acct-main" },
      });
    });
  });

  it("retries pending child delivery before a recovered requester-turn wake", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    const stateDir = tempStateDir;
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const run: SubagentRunRecord = {
        runId: "run-pending-delivery",
        requesterTurnRunId: "run-requester",
        childSessionKey: "agent:main:subagent:pending-delivery",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "deliver before waking requester",
        cleanup: "keep",
        createdAt: 100,
        endedReason: "subagent-complete",
        execution: {
          status: "terminal",
          startedAt: 110,
          endedAt: 200,
          outcome: { status: "ok" },
        },
        expectsCompletionMessage: true,
        completion: { required: true, resultText: "done", capturedAt: 200 },
        delivery: {
          status: "pending",
          payload: {
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            childSessionKey: "agent:main:subagent:pending-delivery",
            childRunId: "run-pending-delivery",
            task: "deliver before waking requester",
            startedAt: 110,
            endedAt: 200,
            outcome: { status: "ok" },
            expectsCompletionMessage: true,
          },
        },
        cleanupHandled: false,
      };
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      await writeSubagentSessionEntry({
        stateDir,
        agentId: "main",
        sessionKey: run.childSessionKey,
        sessionId: "sess-pending-delivery",
        defaultSessionId: "sess-pending-delivery",
      });

      mod.initSubagentRegistry();

      await vi.waitFor(() => expect(announceSpy).toHaveBeenCalled(), {
        timeout: 1_000,
        interval: 10,
      });
      expect(announceSpy).toHaveBeenCalledWith(
        expect.objectContaining({ childRunId: "run-pending-delivery" }),
      );
    });
  });

  it.each([false, true])(
    "settles a restored steered requester turn (yielded: %s)",
    async (requesterYielded) => {
      tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
      const stateDir = tempStateDir;
      const wakeRequester = vi.fn(async () => false);
      mod.testing.setDepsForTest({
        ...createSubagentRegistryTestDeps({
          callGateway: vi.mocked(callGatewayModule.callGateway),
          maybeWakeRequesterAfterAllChildrenSettled: wakeRequester,
        }),
      });

      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const endedAt = Date.now();
        const run: SubagentRunRecord = {
          runId: "run-steered",
          taskRunId: "run-original",
          requesterTurnRunId: "run-requester",
          ...(requesterYielded ? { requesterTurnYielded: true } : {}),
          childSessionKey: "agent:main:subagent:steered",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "deliver the steered result",
          cleanup: "keep",
          createdAt: endedAt - 1_000,
          endedReason: "subagent-complete",
          execution: {
            status: "terminal",
            startedAt: endedAt - 500,
            endedAt,
            outcome: { status: "ok" },
          },
          expectsCompletionMessage: true,
          completion: { required: true, resultText: "done", capturedAt: endedAt },
          delivery: { status: "delivered", deliveredAt: endedAt },
          cleanupHandled: true,
          cleanupCompletedAt: endedAt,
        };
        saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
        await writeSubagentSessionEntry({
          stateDir,
          agentId: "main",
          sessionKey: run.childSessionKey,
          sessionId: "sess-steered",
          defaultSessionId: "sess-steered",
        });

        mod.initSubagentRegistry();

        const restored = mod.getSubagentRunByRunId(run.runId);
        expect(restored).toMatchObject({ runId: run.runId, taskRunId: run.taskRunId });
        expect(restored?.requesterTurnRunId).toBeUndefined();
        expect(loadSubagentRegistryFromSqlite().get(run.runId)?.requesterTurnRunId).toBeUndefined();

        if (requesterYielded) {
          expect(restored?.requesterSettleWake).toMatchObject({
            batchRunIds: [run.runId],
            requesterYieldBatch: true,
            afterRequesterYield: true,
          });
          await vi.waitFor(() => expect(wakeRequester).toHaveBeenCalledOnce(), {
            timeout: 1_000,
            interval: 10,
          });
        } else {
          expect(restored?.requesterSettleWake).toBeUndefined();
          expect(wakeRequester).not.toHaveBeenCalled();
        }
      });
    },
  );
});
