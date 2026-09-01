import path from "node:path";
import { invokeNativeHookRelay } from "openclaw/plugin-sdk/agent-harness-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createParams,
  createStartedThreadHarness,
  extractRelayIdFromThreadRequest,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

type ObservedAfterToolCall = {
  params?: unknown;
  result?: unknown;
  toolCallId?: string;
  toolName?: string;
};

function afterToolCallsFor(
  afterToolCall: ReturnType<typeof vi.fn>,
  toolName: string,
): ObservedAfterToolCall[] {
  return afterToolCall.mock.calls
    .map((call) => call[0] as ObservedAfterToolCall)
    .filter((event) => event?.toolName === toolName);
}

async function notifyFileChange(
  harness: ReturnType<typeof createStartedThreadHarness>,
  params: {
    id: string;
    path: string;
  },
): Promise<void> {
  await harness.notify({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "fileChange",
        id: params.id,
        changes: [
          {
            path: params.path,
            kind: { type: "add" },
          },
        ],
        status: "completed",
      },
    },
  });
}

async function notifyPostToolUseCompleted(
  harness: ReturnType<typeof createStartedThreadHarness>,
  id: string,
): Promise<void> {
  await harness.notify({
    method: "hook/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      run: {
        id,
        eventName: "postToolUse",
        handlerType: "command",
        executionMode: "sync",
        scope: "turn",
        source: "project",
        sourcePath: "/repo/.codex/hooks.json",
        status: "completed",
        statusMessage: null,
        durationMs: 1,
        entries: [],
      },
    },
  });
}

describe("runCodexAppServerAttempt FileChange relay ownership", () => {
  it("uses retained native relay records to emit exactly one apply_patch AFTER per path", async () => {
    const beforeToolCall = vi.fn(() => undefined);
    const afterToolCall = vi.fn(async () => undefined);

    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: beforeToolCall,
        },
        {
          hookName: "after_tool_call",
          handler: afterToolCall,
        },
      ]),
    );

    const sessionFile = path.join(tempDir, "file-change-relay-ownership.jsonl");
    const workspaceDir = path.join(tempDir, "file-change-relay-ownership-workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use", "post_tool_use"],
      },
    });

    await harness.waitForMethod("turn/start");

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);

    const directPatch = "*** Begin Patch\n*** Add File: direct.txt\n+direct\n*** End Patch\n";

    await invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_use_id: "patch-direct",
        tool_input: { command: directPatch },
      },
    });

    await notifyFileChange(harness, {
      id: "patch-direct",
      path: "direct.txt",
    });

    expect(afterToolCallsFor(afterToolCall, "apply_patch")).toHaveLength(0);

    await invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "post_tool_use",
      rawPayload: {
        hook_event_name: "PostToolUse",
        tool_name: "apply_patch",
        tool_use_id: "patch-direct",
        tool_input: { command: directPatch },
        tool_response: "Done!",
      },
    });

    await vi.waitFor(() => {
      expect(afterToolCallsFor(afterToolCall, "apply_patch")).toHaveLength(1);
    });

    await notifyPostToolUseCompleted(harness, "hook-direct-post");

    expect(afterToolCallsFor(afterToolCall, "apply_patch")).toHaveLength(1);

    const interceptedPatch =
      "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: intercepted.txt\n+intercepted\n*** End Patch\nPATCH\n";

    await invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "patch-intercepted",
        tool_input: { cmd: interceptedPatch },
      },
    });

    await notifyFileChange(harness, {
      id: "patch-intercepted",
      path: "intercepted.txt",
    });

    await vi.waitFor(() => {
      expect(afterToolCallsFor(afterToolCall, "apply_patch")).toHaveLength(2);
    });

    await invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "post_tool_use",
      rawPayload: {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "patch-intercepted",
        tool_input: { cmd: interceptedPatch },
        tool_response: { output: "Done!", exit_code: 0 },
      },
    });

    await notifyPostToolUseCompleted(harness, "hook-intercepted-post");

    await harness.completeTurn({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await run;

    const applyPatchEvents = afterToolCallsFor(afterToolCall, "apply_patch");
    const directEvents = applyPatchEvents.filter((event) => event.toolCallId === "patch-direct");
    const interceptedEvents = applyPatchEvents.filter(
      (event) => event.toolCallId === "patch-intercepted",
    );

    expect(directEvents).toHaveLength(1);
    expect(interceptedEvents).toHaveLength(1);
    expect(interceptedEvents[0]?.params).toEqual({
      changes: [
        {
          path: "intercepted.txt",
          kind: { type: "add" },
        },
      ],
    });
    expect(interceptedEvents[0]?.result).toEqual({
      status: "completed",
      changes: [
        {
          path: "intercepted.txt",
          kind: { type: "add" },
        },
      ],
    });

    const execEvents = afterToolCallsFor(afterToolCall, "exec").filter(
      (event) => event.toolCallId === "patch-intercepted",
    );
    expect(execEvents).toHaveLength(1);
    expect(beforeToolCall).toHaveBeenCalled();
  });

  it("finalizes a pending intercepted fileChange when the client closes before turn completion", async () => {
    const afterToolCall = vi.fn(async () => undefined);

    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "after_tool_call",
          handler: afterToolCall,
        },
      ]),
    );

    const sessionFile = path.join(tempDir, "file-change-client-close.jsonl");
    const workspaceDir = path.join(tempDir, "file-change-client-close-workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use", "post_tool_use"],
      },
    });

    await harness.waitForMethod("turn/start");

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);

    const interceptedPatch =
      "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: client-close.txt\n+client-close\n*** End Patch\nPATCH\n";

    await invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "post_tool_use",
      rawPayload: {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "patch-client-close",
        tool_input: {
          cmd: interceptedPatch,
        },
        tool_response: {
          output: "Done!",
          exit_code: 0,
        },
      },
    });

    await notifyFileChange(harness, {
      id: "patch-client-close",
      path: "client-close.txt",
    });

    expect(afterToolCallsFor(afterToolCall, "apply_patch")).toHaveLength(0);

    harness.close(
      new Error('codex app-server exited: code=137 signal=SIGKILL stderr="worker exhausted"'),
    );

    const result = await run;

    await vi.waitFor(() => {
      expect(afterToolCallsFor(afterToolCall, "apply_patch")).toHaveLength(1);
    });

    expect(result.codexAppServerFailure?.kind).toBe("client_closed_before_turn_completed");

    const applyPatchEvent = afterToolCallsFor(afterToolCall, "apply_patch")[0];

    expect(applyPatchEvent?.toolCallId).toBe("patch-client-close");

    expect(applyPatchEvent?.params).toEqual({
      changes: [
        {
          path: "client-close.txt",
          kind: {
            type: "add",
          },
        },
      ],
    });

    expect(applyPatchEvent?.result).toEqual({
      status: "completed",
      changes: [
        {
          path: "client-close.txt",
          kind: {
            type: "add",
          },
        },
      ],
    });
  });
});
