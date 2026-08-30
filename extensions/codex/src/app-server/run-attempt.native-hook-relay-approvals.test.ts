// Codex tests cover run attempt.native hook relay approval behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { nativeHookRelayTesting } from "openclaw/plugin-sdk/agent-harness-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createEmptyPluginRegistry,
  createMockPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as approvalBridge from "./approval-bridge.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createParams,
  createStartedThreadHarness,
  extractRelayIdFromThreadRequest,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

const testing = {
  flushPendingCodexNativeHookRelayUnregistersForTests(): void {
    nativeHookRelayUnregisterQueue.flush();
  },
};

describe("run attempt native hook relay approvals", () => {
  it("auto-answers defensive yolo command and correlated workspace file approvals", async () => {
    const approvalSpy = vi.spyOn(approvalBridge, "handleCodexAppServerApprovalRequest");
    const beforeToolCall = vi.fn(() => undefined);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const sessionFile = path.join(tempDir, "policy-allow.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-policy-allow");
    const commandFile = path.join(workspaceDir, "byte-bound-command.mjs");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(commandFile, "process.stdout.write('ok\\n');\n");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.trigger = "user";
    params.approvalReviewerDeviceId = "device-tui-reviewer";
    const closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);

    const run = runCodexAppServerAttempt(params, {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    await harness.waitForMethod("turn/start");
    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    expect((startRequest?.params as { approvalPolicy?: string })?.approvalPolicy).toBe("never");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toMatchObject({
      approvalContext: {
        trigger: "user",
        approvalReviewerDeviceId: "device-tui-reviewer",
      },
    });

    const commandResponse = await harness.handleServerRequest({
      id: "request-command-policy-allow",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-policy-allow",
        command: `node ${commandFile}`,
        cwd: workspaceDir,
      },
    });
    expect(approvalSpy).toHaveBeenCalledWith(expect.objectContaining({ autoApprove: true }));
    // Commands backed by mutable file bytes cannot receive reusable approval.
    expect(commandResponse).toEqual({ decision: "accept" });
    const changes = [
      {
        path: "memory/2026-07-29.md",
        kind: { type: "add" },
      },
    ];
    await harness.notify({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "patch-policy-allow",
          type: "fileChange",
          changes,
          status: "inProgress",
        },
      },
    });
    await expect(
      harness.handleServerRequest({
        id: "request-file-policy-allow",
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "patch-policy-allow",
          reason: "write memory/2026-07-29.md",
          grantRoot: workspaceDir,
        },
      }),
    ).resolves.toEqual({ decision: "acceptForSession" });

    expect(beforeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "apply_patch",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "patch-policy-allow",
          reason: "write memory/2026-07-29.md",
          grantRoot: workspaceDir,
          changes,
        },
      }),
      expect.any(Object),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    closeHostCapabilities();
    testing.flushPendingCodexNativeHookRelayUnregistersForTests();
  });
});
