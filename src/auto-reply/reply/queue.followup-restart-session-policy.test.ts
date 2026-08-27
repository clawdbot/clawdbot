import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveAttemptWorkspaceSandbox } from "../../agents/embedded-agent-runner/run/attempt-setup.js";
import {
  resolveSessionPermissionCoreToolPolicy,
  resolveSessionPermissionExecMode,
} from "../../agents/session-permission-exec-mode.js";
import {
  followupQueueEntryContainsPrompt,
  loadFollowupQueueEntries,
} from "../../infra/followup-queue-sqlite.js";
import { buildEmbeddedRunBaseParams } from "./agent-runner-run-params.js";
import type { QueueSettings } from "./queue.js";
import { enqueueFollowupRun } from "./queue.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
  clearRestoredPendingDrainKeysForTest,
  restoreFollowupQueues,
} from "./queue/persist.js";
import { FOLLOWUP_QUEUES } from "./queue/state.js";

installQueueRuntimeErrorSilencer();

describe("followup queue restart session permission policy", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("restores the queued session permission pair into the embedded execution policy", async () => {
    const tmpDir = tempDirs.make("openclaw-followup-session-policy-");
    const sessionRoot = path.join(tmpDir, "session-root");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = "agent:main:telegram:direct:6300969793";
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

    const simulateGatewayRestart = () => {
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
    };

    try {
      simulateGatewayRestart();

      const queued = createRun({
        prompt: "stay inside the workspace",
        messageId: "tg-session-policy",
        originatingChannel: "telegram",
        originatingTo: "6300969793",
        originatingAccountId: "default",
      });
      queued.run.permissionMode = "workspace";
      queued.run.sessionRoot = sessionRoot;
      queued.run.workspaceDir = sessionRoot;

      enqueueFollowupRun(key, queued, settings, "message-id", undefined, false);

      expect(followupQueueEntryContainsPrompt(key, "stay inside the workspace")).toBe(true);

      simulateGatewayRestart();
      restoreFollowupQueues();

      const restored = FOLLOWUP_QUEUES.get(key)?.items[0];
      expect(restored?.prompt).toBe("stay inside the workspace");
      expect(restored?.run.permissionMode).toBe("workspace");
      expect(restored?.run.sessionRoot).toBe(sessionRoot);

      const runParams = buildEmbeddedRunBaseParams({
        run: restored!.run,
        provider: restored!.run.provider,
        model: restored!.run.model,
        runId: "restored-session-policy",
        authProfile: {},
      });
      expect(runParams.permissionMode).toBe("workspace");
      expect(runParams.sessionRoot).toBe(sessionRoot);

      const setup = await resolveAttemptWorkspaceSandbox({
        agentId: restored!.run.agentId,
        config: restored!.run.config,
        cwd: restored!.run.cwd,
        permissionMode: runParams.permissionMode,
        sessionId: restored!.run.sessionId,
        sessionKey: restored!.run.sessionKey,
        sessionRoot: runParams.sessionRoot,
        workspaceDir: restored!.run.workspaceDir,
      });

      expect(setup.sessionPermissionPolicy).toEqual({
        root: sessionRoot,
        mode: "workspace",
      });
      expect(resolveSessionPermissionExecMode(setup.sessionPermissionPolicy!)).toBe("auto");
      expect(resolveSessionPermissionCoreToolPolicy(setup.sessionPermissionPolicy!)).toMatchObject({
        workspaceOnly: true,
        execMode: "auto",
        bypassHostApprovalFloors: false,
      });
    } finally {
      simulateGatewayRestart();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("fail-closes a live root-only session policy after persist+restore", () => {
    const tmpDir = tempDirs.make("openclaw-followup-session-policy-root-only-");
    const sessionRoot = path.join(tmpDir, "session-root");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = "agent:main:telegram:direct:6300969793";
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

    const simulateGatewayRestart = () => {
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
    };

    try {
      simulateGatewayRestart();

      const queued = createRun({
        prompt: "root-only live policy",
        messageId: "tg-session-policy-root-only",
        originatingChannel: "telegram",
        originatingTo: "6300969793",
        originatingAccountId: "default",
      });
      queued.run.sessionRoot = sessionRoot;
      queued.run.workspaceDir = sessionRoot;

      enqueueFollowupRun(key, queued, settings, "message-id", undefined, false);

      const persisted = loadFollowupQueueEntries().find(([entryKey]) => entryKey === key)?.[1] as {
        items?: Array<{ run?: { permissionMode?: unknown; sessionRoot?: unknown } }>;
      };
      expect(persisted?.items?.[0]?.run?.permissionMode).toBeUndefined();
      expect(persisted?.items?.[0]?.run?.sessionRoot).toBe(sessionRoot);
      expect(followupQueueEntryContainsPrompt(key, "root-only live policy")).toBe(true);

      simulateGatewayRestart();
      restoreFollowupQueues();

      expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toEqual([]);
      expect(followupQueueEntryContainsPrompt(key, "root-only live policy")).toBe(false);
    } finally {
      simulateGatewayRestart();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });
});
