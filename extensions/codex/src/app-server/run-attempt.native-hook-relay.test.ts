// Codex tests cover run attempt.native hook relay plugin behavior.
import fs from "node:fs/promises";
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
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createEmptyPluginRegistry,
  createMockPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as approvalBridge from "./approval-bridge.js";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { CodexAppServerRpcError } from "./client.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
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

const DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "disabled",
});

function createLoopRelayParams(sessionFile: string, workspaceDir: string) {
  const params = createParams(sessionFile, workspaceDir);
  params.config = { tools: { loopDetection: { enabled: true } } };
  return params;
}

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
  it("refuses to run when managed-only hooks would silently discard its enforcing relay", async () => {
    const sessionFile = path.join(tempDir, "managed-hooks-only.jsonl");
    const workspaceDir = path.join(tempDir, "managed-hooks-only-workspace");
    const harness = createStartedThreadHarness(async (method) =>
      method === "configRequirements/read"
        ? { requirements: { allowManagedHooksOnly: true } }
        : undefined,
    );

    await expect(
      runCodexAppServerAttempt(createLoopRelayParams(sessionFile, workspaceDir), {
        nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
      }),
    ).rejects.toThrow(/managed-only hooks.*OpenClaw native hook relay/i);
    expect(harness.requests.some((request) => request.method === "thread/start")).toBe(false);
  });

  it("does not read managed hook policy when no enforcing native relay is installed", async () => {
    const sessionFile = path.join(tempDir, "observational-hooks-only.jsonl");
    const workspaceDir = path.join(tempDir, "observational-hooks-only-workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: { enabled: true, events: ["post_tool_use"] },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(harness.requests.some((request) => request.method === "configRequirements/read")).toBe(
      false,
    );
  });

  it("rejects Guardian review when the running server resolves an untrusted managed endpoint", async () => {
    const sessionFile = path.join(tempDir, "managed-review-endpoint.jsonl");
    const workspaceDir = path.join(tempDir, "managed-review-endpoint-workspace");
    const params = createParams(sessionFile, workspaceDir, { provider: "openai" });
    const harness = createStartedThreadHarness(async (method) =>
      method === "config/read"
        ? { config: { openai_base_url: "https://review-proxy.example.invalid/v1" }, origins: {} }
        : undefined,
    );

    await expect(
      runCodexAppServerAttempt(params, {
        pluginConfig: { appServer: { mode: "guardian" } },
      }),
    ).rejects.toThrow(/model-backed approval reviewer.*trusted OpenAI/i);
    expect(harness.requests.some((request) => request.method === "thread/start")).toBe(false);
  });

  it("relays native tool results through Codex result middleware", async () => {
    const middleware = vi.fn(async () => undefined);
    const afterToolCall = vi.fn();
    const beforeAgentFinalize = vi.fn();
    const registry = createMockPluginRegistry([
      { hookName: "after_tool_call", handler: afterToolCall },
      { hookName: "before_agent_finalize", handler: beforeAgentFinalize },
    ]);
    registry.agentToolResultMiddlewares.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawHandler: middleware,
      handler: middleware,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.sandboxSessionKey = "agent:main:policy";
    const run = runCodexAppServerAttempt(params, {
      nativeHookRelay: {
        enabled: true,
        events: ["post_tool_use", "before_agent_finalize"],
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
      expect.objectContaining({
        runtime: "codex",
        agentId: "main",
        sessionKey: params.sessionKey,
      }),
    );
    await invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "before_agent_finalize",
      rawPayload: { hook_event_name: "Stop", session_id: "thread-1", turn_id: "turn-1" },
    });
    for (const hook of [afterToolCall, beforeAgentFinalize]) {
      expect(hook).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ agentId: "main", sessionKey: params.sessionKey }),
      );
    }

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });

  it("registers native hook relay config for an enabled Codex turn and cleans it up", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createLoopRelayParams(sessionFile, workspaceDir), {
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
    const params = createLoopRelayParams(sessionFile, workspaceDir);

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
    const params = createLoopRelayParams(sessionFile, workspaceDir);
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
    nativeHookRelayUnregisterQueue.flush();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("auto-answers defensive yolo command and workspace file approvals at their safe scopes", async () => {
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
      expect.objectContaining({ toolName: "apply_patch" }),
      expect.any(Object),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    closeHostCapabilities();
    nativeHookRelayUnregisterQueue.flush();
  });

  it("fails a defensive unattended yolo approval immediately when the hook requires review", async () => {
    const onResolution = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: vi.fn(() => ({
            requireApproval: {
              title: "Operator review required",
              description: "Command needs an interactive approver",
              onResolution,
            },
          })),
        },
      ]),
    );
    const sessionFile = path.join(tempDir, "policy-unattended.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-policy-unattended");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.trigger = "cron";
    params.onAgentEvent = vi.fn();
    const closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);

    const run = runCodexAppServerAttempt(params, {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    await harness.waitForMethod("turn/start");
    const startedAtMs = Date.now();
    const response = await harness.handleServerRequest({
      id: "request-command-policy-unattended",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-policy-unattended",
        command: "gh run view 1",
        cwd: workspaceDir,
      },
    });

    expect(response).toEqual({ decision: "decline" });
    expect(Date.now() - startedAtMs).toBeLessThan(1_000);
    expect(onResolution).toHaveBeenCalledWith("cancelled");
    expect(params.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "approval",
        data: expect.objectContaining({
          status: "denied",
          message:
            "Plugin approval unavailable: cron runs have no approval-capable initiating surface.",
        }),
      }),
    );

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    closeHostCapabilities();
    nativeHookRelayUnregisterQueue.flush();
  });

  it.each([
    {
      name: "keeps the native hook relay default floor for short Codex turns",
      ttlMs: undefined,
      expectedTtlMs: 30 * 60_000,
    },
    {
      name: "preserves an explicit native hook relay ttl",
      ttlMs: 123_456,
      expectedTtlMs: 123_456,
    },
  ])("$name", async ({ ttlMs, expectedTtlMs }) => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const startedAtMs = Date.now();
    const run = runCodexAppServerAttempt(createLoopRelayParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
        ttlMs,
      },
    });
    await harness.waitForMethod("turn/start");

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    const registration = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId);
    if (!registration) {
      throw new Error("Expected native hook relay registration");
    }
    expect(registration.expiresAtMs - startedAtMs).toBeGreaterThanOrEqual(expectedTtlMs);
    expect(registration.expiresAtMs - startedAtMs).toBeLessThan(expectedTtlMs + 10_000);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    nativeHookRelayUnregisterQueue.flush();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("throttles default native hook relay renewal on current-turn progress", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createLoopRelayParams(sessionFile, workspaceDir), {
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
    nativeHookRelayUnregisterQueue.flush();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("lets Codex app-server approval modes own native permission requests by default", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createLoopRelayParams(sessionFile, workspaceDir), {
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
    nativeHookRelayUnregisterQueue.flush();
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
    nativeHookRelayUnregisterQueue.flush();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("keeps native hook relays alive across startup and long Codex turn timeouts", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const params = createLoopRelayParams(sessionFile, workspaceDir);
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
      nativeHookRelayUnregisterQueue.flush();
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

  it.each(["replacement", "independent"])(
    "keeps the %s execution relay registered when prior cleanup is pending",
    async (kind) => {
      const sameExecutionSession = kind === "replacement";
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const firstHarness = createStartedThreadHarness(undefined, { persistedThreads: [] });
      const firstParams = createLoopRelayParams(sessionFile, workspaceDir);
      firstParams.sandboxSessionKey = "agent:main:policy";
      const firstRun = runCodexAppServerAttempt(firstParams, {
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
      const firstGeneration = extractGenerationFromThreadRequest(firstStartRequest?.params);
      expect((await readCodexAppServerBinding(sessionFile))?.nativeHookRelayGeneration).toBe(
        firstGeneration,
      );
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRelayId)?.runId,
      ).toBe("run-1");
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

      firstHarness.close();
      const secondHarness = sameExecutionSession
        ? createResumeHarness("thread-1")
        : createStartedThreadHarness();
      const secondParams = createLoopRelayParams(
        sameExecutionSession ? sessionFile : path.join(tempDir, "independent-session.jsonl"),
        workspaceDir,
      );
      secondParams.runId = "run-2";
      secondParams.sandboxSessionKey = firstParams.sandboxSessionKey;
      if (!sameExecutionSession) {
        secondParams.sessionId = "session-2";
        secondParams.sessionKey = "agent:main:session-2";
      }
      const secondRun = runCodexAppServerAttempt(secondParams, {
        nativeHookRelay: {
          enabled: true,
          events: ["pre_tool_use"],
        },
      });
      await secondHarness.waitForMethod("turn/start");

      const secondThreadRequest = secondHarness.requests.find(
        (request) => request.method === (sameExecutionSession ? "thread/resume" : "thread/start"),
      );
      const secondRelayId = extractRelayIdFromThreadRequest(secondThreadRequest?.params);
      expect(secondRelayId === firstRelayId).toBe(sameExecutionSession);
      const secondGeneration = extractGenerationFromThreadRequest(secondThreadRequest?.params);
      expect(secondGeneration === firstGeneration).toBe(sameExecutionSession);
      const resumedRegistration =
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(secondRelayId);
      expect(resumedRegistration?.runId).toBe("run-2");
      expect(resumedRegistration?.sessionKey).toBe(secondParams.sessionKey);
      expect(resumedRegistration?.allowedEvents).toEqual(["pre_tool_use"]);
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRelayId)?.runId,
      ).toBe(sameExecutionSession ? "run-2" : "run-1");

      nativeHookRelayUnregisterQueue.flush();
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(secondRelayId)?.runId,
      ).toBe("run-2");

      await secondHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await secondRun;
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(secondRelayId)?.runId,
      ).toBe("run-2");
      nativeHookRelayUnregisterQueue.flush();
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(secondRelayId),
      ).toBeUndefined();
    },
  );

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

    const run = runCodexAppServerAttempt(createLoopRelayParams(sessionFile, workspaceDir), {
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
    nativeHookRelayUnregisterQueue.flush();
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

    const run = runCodexAppServerAttempt(createLoopRelayParams(sessionFile, workspaceDir), {
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
    nativeHookRelayUnregisterQueue.flush();
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
    const harness = createStartedThreadHarness(
      async (method) => {
        if (method === "thread/resume") {
          // Exact unsubscribe after the structured RPC failure proves the resume
          // subscription is released before falling back to a fresh thread.
          throw new CodexAppServerRpcError({ code: -32_000, message: "resume failed" }, method);
        }
        return undefined;
      },
      { persistedThreads: ["thread-existing"] },
    );

    const run = runCodexAppServerAttempt(createLoopRelayParams(sessionFile, workspaceDir), {
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
    nativeHookRelayUnregisterQueue.flush();
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
    const params = createParams(sessionFile, workspaceDir);
    params.sandboxSessionKey = "agent:main:policy";

    try {
      await expect(
        runCodexAppServerAttempt(params, {
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
        agentId: "main",
        sessionKey: params.sessionKey,
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

    expect(readAttemptTerminal(result).aborted).toBe(true);
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
    nativeHookRelayUnregisterQueue.flush();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });
});
