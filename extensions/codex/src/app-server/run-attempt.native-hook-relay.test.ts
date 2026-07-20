// Codex tests cover run attempt.native hook relay plugin behavior.
import path from "node:path";
import {
  abortAgentHarnessRun,
  invokeNativeHookRelay,
  nativeHookRelayTesting,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as approvalBridge from "./approval-bridge.js";
import { CodexAppServerRpcError } from "./client.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import {
  createParams,
  createResumeHarness,
  createStartedThreadHarness,
  extractGenerationFromThreadRequest,
  extractRelayIdFromThreadRequest,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding as writeRawCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

const testing = {
  flushPendingCodexNativeHookRelayUnregistersForTests(): void {
    nativeHookRelayUnregisterQueue.flush();
  },
};

const DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "disabled",
});

function writeCodexAppServerBinding(...args: Parameters<typeof writeRawCodexAppServerBinding>) {
  const [sessionFile, binding, lookup] = args;
  return writeRawCodexAppServerBinding(
    sessionFile,
    {
      webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
      ...binding,
    },
    lookup,
  );
}

describe("runCodexAppServerAttempt native hook relay", () => {
  it("relays native tool results through Codex result middleware", async () => {
    const middleware = vi.fn(async () => undefined);
    const registry = createEmptyPluginRegistry();
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: middleware,
      handler: middleware,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["post_tool_use"],
      },
    });
    await harness.waitForMethod("turn/start");
    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const startConfig = (startRequest?.params as { config?: Record<string, unknown> } | undefined)
      ?.config;
    expect(startConfig?.["hooks.PostToolUse"]).not.toEqual([]);
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);

    await invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "post_tool_use",
      rawPayload: {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "native-call-1",
        tool_input: { command: "pnpm test" },
        tool_response: { output: "ok", exit_code: 0 },
      },
    });

    expect(middleware).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "native-call-1",
        toolName: "exec",
        args: { command: "pnpm test" },
        result: {
          content: [
            {
              type: "text",
              text: '{\n  "output": "ok",\n  "exit_code": 0\n}',
            },
          ],
          details: { output: "ok", exit_code: 0 },
        },
      }),
      expect.objectContaining({ runtime: "codex" }),
    );

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });

  it("registers native hook relay config for an enabled Codex turn and cleans it up", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
        gatewayTimeoutMs: 4321,
        hookTimeoutSec: 9,
      },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const startConfig = (startRequest?.params as { config?: Record<string, unknown> } | undefined)
      ?.config;
    expect(startConfig?.["features.hooks"]).toBe(true);
    const preToolUseHooks = startConfig?.["hooks.PreToolUse"] as
      | Array<{ hooks?: Array<{ command?: string; timeout?: number; type?: string }> }>
      | undefined;
    const preToolUseCommand = preToolUseHooks?.[0]?.hooks?.[0];
    expect(preToolUseCommand?.type).toBe("command");
    expect(preToolUseCommand?.timeout).toBe(9);
    expect(preToolUseCommand?.command).toContain("--event pre_tool_use --timeout 4321");
    const hookState = startConfig?.["hooks.state"] as Record<
      string,
      { enabled?: unknown; trusted_hash?: unknown }
    >;
    const preToolUseState = hookState?.["/<session-flags>/config.toml:pre_tool_use:0:0"];
    expect(preToolUseState?.enabled).toBe(true);
    expect(preToolUseState?.trusted_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeDefined();
    nativeHookRelayUnregisterQueue.flush();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("omits the loop-detection PreToolUse subprocess when Codex config disables it", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.config = { tools: { loopDetection: { enabled: true } } } as never;

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { loopDetectionPreToolUseRelay: false },
      },
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
      },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const startConfig = (startRequest?.params as { config?: Record<string, unknown> } | undefined)
      ?.config;
    expect(startConfig?.["features.hooks"]).toBe(true);
    expect(startConfig?.["hooks.PreToolUse"]).toEqual([]);
  });

  it("forwards command approval requests through the active native hook relay", async () => {
    const approvalSpy = vi
      .spyOn(approvalBridge, "handleCodexAppServerApprovalRequest")
      .mockResolvedValue({ decision: "decline" });
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.messageChannel = "discord";
    params.agentAccountId = "operations";
    params.currentChannelId = "channel:target";
    params.memberRoleIds = ["maintainer-role"];
    params.senderId = "maintainer-user";
    params.senderIsOwner = false;

    const run = runCodexAppServerAttempt(params, {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
      },
    });
    await harness.waitForMethod("turn/start");
    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeDefined();

    const response = await harness.handleServerRequest({
      id: "request-command-approval",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-1",
        command: "/bin/bash -lc 'node -v'",
        cwd: workspaceDir,
      },
    });

    expect(response).toEqual({ decision: "decline" });
    expect(approvalSpy).toHaveBeenCalledTimes(1);
    const approvalArgs = approvalSpy.mock.calls[0]?.[0];
    expect(approvalArgs).toMatchObject({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-1",
        command: "/bin/bash -lc 'node -v'",
        cwd: workspaceDir,
      },
      threadId: "thread-1",
      turnId: "turn-1",
      autoApprove: true,
    });
    expect(approvalArgs?.nativeHookRelay).toMatchObject({
      relayId,
      allowedEvents: expect.arrayContaining(["pre_tool_use"]),
    });
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toMatchObject({
      channelId: "target",
      requester: {
        channel: "discord",
        accountId: "operations",
        senderId: "maintainer-user",
        senderIsOwner: false,
        roleIds: ["maintainer-role"],
      },
    });

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    testing.flushPendingCodexNativeHookRelayUnregistersForTests();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("keeps the native hook relay default floor for short Codex turns", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const relayFloorMs = 30 * 60_000;

    const startedAtMs = Date.now();
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
      },
    });
    await harness.waitForMethod("turn/start");

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    const registration = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId);
    if (!registration) {
      throw new Error("Expected native hook relay registration");
    }
    expect(registration.expiresAtMs - startedAtMs).toBeGreaterThanOrEqual(relayFloorMs);
    expect(registration.expiresAtMs - startedAtMs).toBeLessThan(relayFloorMs + 10_000);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    testing.flushPendingCodexNativeHookRelayUnregistersForTests();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("throttles default native hook relay renewal on current-turn progress", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
      },
    });
    await harness.waitForMethod("turn/start");

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    const registration = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId);
    if (!registration) {
      throw new Error("Expected native hook relay registration");
    }
    const firstExpiresAtMs = registration.expiresAtMs;

    for (const id of ["raw-progress-1", "raw-progress-2"]) {
      await harness.notify({
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "message",
            id,
            role: "assistant",
            content: [{ type: "output_text", text: "Still working." }],
          },
        },
      });
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)?.expiresAtMs,
      ).toBe(firstExpiresAtMs);
    }

    await harness.notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "foreign-thread",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "foreign-progress",
          role: "assistant",
          content: [{ type: "output_text", text: "Wrong thread." }],
        },
      },
    });
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)?.expiresAtMs,
    ).toBe(firstExpiresAtMs);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    testing.flushPendingCodexNativeHookRelayUnregistersForTests();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("preserves an explicit native hook relay ttl", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const explicitTtlMs = 123_456;

    const startedAtMs = Date.now();
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
        ttlMs: explicitTtlMs,
      },
    });
    await harness.waitForMethod("turn/start");

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    const registration = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId);
    if (!registration) {
      throw new Error("Expected native hook relay registration");
    }
    expect(registration.expiresAtMs - startedAtMs).toBeGreaterThanOrEqual(explicitTtlMs);
    expect(registration.expiresAtMs - startedAtMs).toBeLessThan(explicitTtlMs + 10_000);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    testing.flushPendingCodexNativeHookRelayUnregistersForTests();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("lets Codex app-server approval modes own native permission requests by default", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      pluginConfig: {
        appServer: {
          mode: "guardian",
        },
      },
    });
    await harness.waitForMethod("turn/start");

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const startConfig = (startRequest?.params as { config?: Record<string, unknown> } | undefined)
      ?.config;
    expect(startConfig?.["features.hooks"]).toBe(true);
    expect(Array.isArray(startConfig?.["hooks.PreToolUse"])).toBe(true);
    expect(startConfig?.["hooks.PostToolUse"]).toEqual([]);
    expect(startConfig?.["hooks.Stop"]).toEqual([]);
    expect(startConfig).not.toHaveProperty("hooks.PermissionRequest");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)?.allowedEvents,
    ).toEqual(["pre_tool_use", "post_tool_use", "before_agent_finalize"]);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    testing.flushPendingCodexNativeHookRelayUnregistersForTests();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("preserves explicit native permission request relay events in app-server approval modes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      pluginConfig: {
        appServer: {
          mode: "guardian",
        },
      },
      nativeHookRelay: {
        enabled: true,
        events: ["permission_request"],
      },
    });
    await harness.waitForMethod("turn/start");

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const startConfig = (startRequest?.params as { config?: Record<string, unknown> } | undefined)
      ?.config;
    expect(startConfig?.["features.hooks"]).toBe(true);
    expect(Array.isArray(startConfig?.["hooks.PermissionRequest"])).toBe(true);
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)?.allowedEvents,
    ).toEqual(["permission_request"]);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    testing.flushPendingCodexNativeHookRelayUnregistersForTests();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("keeps native hook relays alive across startup and long Codex turn timeouts", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    const abortController = new AbortController();
    const attemptTimeoutMs = 45 * 60_000;
    const startupTimeoutMs = attemptTimeoutMs;
    const turnStartTimeoutMs = attemptTimeoutMs;
    const cleanupGraceMs = 5 * 60_000;
    const expectedRelayTtlMs =
      attemptTimeoutMs + startupTimeoutMs + turnStartTimeoutMs + cleanupGraceMs;
    params.timeoutMs = attemptTimeoutMs;
    params.abortSignal = abortController.signal;

    const startedAtMs = Date.now();
    const run = runCodexAppServerAttempt(params, {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
      },
    });
    let completed = false;
    let relayId: string | undefined;
    try {
      await harness.waitForMethod("turn/start");

      const startRequest = harness.requests.find((request) => request.method === "thread/start");
      relayId = extractRelayIdFromThreadRequest(startRequest?.params);
      const registration = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId);
      if (!registration) {
        throw new Error("Expected native hook relay registration");
      }
      expect(registration.expiresAtMs - startedAtMs).toBeGreaterThanOrEqual(expectedRelayTtlMs);

      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      completed = true;
      await run;
      testing.flushPendingCodexNativeHookRelayUnregistersForTests();
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId),
      ).toBeUndefined();
    } finally {
      if (!completed) {
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" }).catch(() => {});
        abortController.abort(new Error("test cleanup"));
        await run.catch(() => {});
      }
    }
  });

  it("keeps a replacement Codex native hook relay registered when prior cleanup is pending", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const firstHarness = createStartedThreadHarness();

    const firstRun = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
      },
    });
    await firstHarness.waitForMethod("turn/start");
    await firstHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await firstRun;

    const firstStartRequest = firstHarness.requests.find(
      (request) => request.method === "thread/start",
    );
    const firstRelayId = extractRelayIdFromThreadRequest(firstStartRequest?.params);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRelayId)?.runId).toBe(
      "run-1",
    );
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: firstRelayId,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "late-call-1",
          tool_input: { command: "python3 -c 'print(\"x\")'" },
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    const secondHarness = createResumeHarness();
    const secondParams = createParams(sessionFile, workspaceDir);
    secondParams.runId = "run-2";
    const secondRun = runCodexAppServerAttempt(secondParams, {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
      },
    });
    await secondHarness.waitForMethod("turn/start");

    const resumeRequest = secondHarness.requests.find(
      (request) => request.method === "thread/resume",
    );
    const secondRelayId = extractRelayIdFromThreadRequest(resumeRequest?.params);
    expect(secondRelayId).toBe(firstRelayId);
    const resumedRegistration =
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRelayId);
    expect(resumedRegistration?.runId).toBe("run-2");
    expect(resumedRegistration?.allowedEvents).toEqual(["pre_tool_use"]);

    testing.flushPendingCodexNativeHookRelayUnregistersForTests();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRelayId)?.runId).toBe(
      "run-2",
    );

    await secondHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await secondRun;
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRelayId)?.runId).toBe(
      "run-2",
    );
    testing.flushPendingCodexNativeHookRelayUnregistersForTests();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRelayId),
    ).toBeUndefined();
  });

  it("persists and reuses Codex native hook relay generations for resumed threads", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const firstHarness = createStartedThreadHarness();

    const firstRun = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
      },
    });
    await firstHarness.waitForMethod("turn/start");
    const firstStartRequest = firstHarness.requests.find(
      (request) => request.method === "thread/start",
    );
    const firstRelayId = extractRelayIdFromThreadRequest(firstStartRequest?.params);
    const firstGeneration = extractGenerationFromThreadRequest(firstStartRequest?.params);

    await firstHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await firstRun;
    expect((await readCodexAppServerBinding(sessionFile))?.nativeHookRelayGeneration).toBe(
      firstGeneration,
    );

    const secondHarness = createResumeHarness();
    const secondParams = createParams(sessionFile, workspaceDir);
    secondParams.runId = "run-2";
    const secondRun = runCodexAppServerAttempt(secondParams, {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
      },
    });
    await secondHarness.waitForMethod("turn/start");

    const resumeRequest = secondHarness.requests.find(
      (request) => request.method === "thread/resume",
    );
    expect(extractRelayIdFromThreadRequest(resumeRequest?.params)).toBe(firstRelayId);
    expect(extractGenerationFromThreadRequest(resumeRequest?.params)).toBe(firstGeneration);

    await secondHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await secondRun;
    testing.flushPendingCodexNativeHookRelayUnregistersForTests();
  });

  it("accepts a stale first hook generation when resuming a pre-generation binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const harness = createResumeHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
      },
    });
    await harness.waitForMethod("turn/start");

    const resumeRequest = harness.requests.find((request) => request.method === "thread/resume");
    const relayId = extractRelayIdFromThreadRequest(resumeRequest?.params);
    const currentGeneration = extractGenerationFromThreadRequest(resumeRequest?.params);
    expect(currentGeneration).not.toBe("legacy-generation-from-running-thread");
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId,
        generation: "legacy-generation-from-running-thread",
        event: "pre_tool_use",
        requireGeneration: true,
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "first-tool-after-restart",
          tool_input: { command: "pwd" },
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId,
        generation: "different-legacy-generation",
        event: "pre_tool_use",
        requireGeneration: true,
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "unexpected-stale-generation",
          tool_input: { command: "pwd" },
        },
      }),
    ).rejects.toThrow("native hook relay bridge stale registration");

    await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;
    expect((await readCodexAppServerBinding(sessionFile))?.nativeHookRelayGeneration).toBe(
      currentGeneration,
    );
    testing.flushPendingCodexNativeHookRelayUnregistersForTests();
  });

  it("rotates native hook relay generations when an existing binding starts a fresh thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      userMcpServersFingerprint: "stale-user-mcp-fingerprint",
      nativeHookRelayGeneration: "generation-from-stale-thread",
    });
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
      },
    });
    await harness.waitForMethod("turn/start");

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    const currentGeneration = extractGenerationFromThreadRequest(startRequest?.params);
    expect(currentGeneration).not.toBe("generation-from-stale-thread");
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId,
        generation: "generation-from-stale-thread",
        event: "pre_tool_use",
        requireGeneration: true,
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "stale-thread-tool",
          tool_input: { command: "pwd" },
        },
      }),
    ).rejects.toThrow("native hook relay bridge stale registration");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    expect((await readCodexAppServerBinding(sessionFile))?.nativeHookRelayGeneration).toBe(
      currentGeneration,
    );
    testing.flushPendingCodexNativeHookRelayUnregistersForTests();
  });

  it("rotates native hook relay generations when resume fails over to a fresh thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      nativeHookRelayGeneration: "generation-from-failed-resume",
    });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/resume") {
        // Only a structured RPC rejection proves Codex holds no resume
        // subscription, so the run may fall back to a fresh thread.
        throw new CodexAppServerRpcError({ code: -32_000, message: "resume failed" }, method);
      }
      return undefined;
    });

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
      },
    });
    await harness.waitForMethod("turn/start");

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    const currentGeneration = extractGenerationFromThreadRequest(startRequest?.params);
    expect(currentGeneration).not.toBe("generation-from-failed-resume");
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId,
        generation: "generation-from-failed-resume",
        event: "pre_tool_use",
        requireGeneration: true,
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "failed-resume-stale-tool",
          tool_input: { command: "pwd" },
        },
      }),
    ).rejects.toThrow("native hook relay bridge stale registration");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    expect((await readCodexAppServerBinding(sessionFile))?.nativeHookRelayGeneration).toBe(
      currentGeneration,
    );
    testing.flushPendingCodexNativeHookRelayUnregistersForTests();
  });

  it("sends clearing Codex native hook config when the relay is disabled", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: { enabled: false },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const startConfig = (startRequest?.params as { config?: Record<string, unknown> } | undefined)
      ?.config;
    expect(startConfig?.["features.hooks"]).toBe(false);
    expect(startConfig?.["hooks.PreToolUse"]).toEqual([]);
    expect(startConfig?.["hooks.PostToolUse"]).toEqual([]);
    expect(startConfig?.["hooks.PermissionRequest"]).toEqual([]);
    expect(startConfig?.["hooks.Stop"]).toEqual([]);
  });

  it("cleans up native hook relay state when turn/start fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    let reportPreToolUseFailure:
      | NonNullable<NativeHookRelayRegistrationHandle["onPreToolUseFailure"]>
      | undefined;
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        const startRequest = harness.requests.find((request) => request.method === "thread/start");
        const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
        const registration = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId);
        reportPreToolUseFailure = registration?.onPreToolUseFailure;
        throw new Error("turn start exploded");
      }
      return undefined;
    });

    try {
      await expect(
        runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
          nativeHookRelay: { enabled: true },
        }),
      ).rejects.toThrow("turn start exploded");
      await reportPreToolUseFailure?.({
        toolName: "exec",
        toolCallId: "turn-start-failure-tool",
        disposition: "failed",
        durationMs: 5,
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      unsubscribeDiagnostics();
    }

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
    expect(diagnosticEvents).toContainEqual(
      expect.objectContaining({
        type: "tool.execution.error",
        toolCallId: "turn-start-failure-tool",
        terminalReason: "failed",
      }),
    );
  });

  it("cleans up native hook relay state when the Codex turn aborts", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: { enabled: true },
    });
    await harness.waitForMethod("turn/start");
    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    expect(abortAgentHarnessRun("session-1")).toBe(true);

    const result = await run;

    expect(result.aborted).toBe(true);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).rejects.toThrow("native hook relay not found");
    testing.flushPendingCodexNativeHookRelayUnregistersForTests();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });
});
