import path from "node:path";
import { invokeNativeHookRelay } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createParams,
  createStartedThreadHarness,
  extractRelayIdFromThreadRequest,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { shouldEnableCodexTurnLocalFinalization } from "./turn-local-finalization.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

// Immutable provenance for the Codex Stop contract inspected by this bridge.
// Any managed Codex version bump must re-verify these source blobs before this
// pin is updated; the behavioral tests below cover the OpenClaw side of the
// same boundary.
const VERIFIED_CODEX_STOP_CONTRACT = {
  packageVersion: "0.150.1",
  tag: "rust-v0.150.1",
  commit: "90854393966b21e9ebfd21b122334eb09a20c93d",
  blobs: {
    turnLoop: "850166360d3a8e6d61e3b4a39de9740201752dca",
    stopEvent: "89a59a65efce06de1b313b2080f08ab9cb4413a0",
    stopOutputSchema: "a2bac59cd12a7a02de5ce5b259e68263cba74b2f",
  },
} as const;

setupRunAttemptTestHooks();

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("Codex turn-local finalization", () => {
  it("keeps the inspected Codex Stop contract coupled to the managed runtime", () => {
    expect(CODEX_APP_SERVER_VERSION).toBe(VERIFIED_CODEX_STOP_CONTRACT.packageVersion);
  });

  it.each([false, true])(
    "routes a revision through the OpenClaw relay with disableTools=%s",
    async (disableTools) => {
      const sessionFile = path.join(tempDir, "turn-local-revise.jsonl");
      const workspaceDir = path.join(tempDir, "turn-local-revise-workspace");
      const onAccepted = vi.fn();
      const onBeforeAgentFinalize = vi.fn(async () => ({
        action: "revise" as const,
        instruction: "Use the newer room activity.",
        disableTools: true as const,
        onAccepted,
      }));
      const params = createParams(sessionFile, workspaceDir);
      params.disableTools = disableTools;
      params.onBeforeAgentFinalize = onBeforeAgentFinalize;
      params.beforeAgentFinalizeRevisionAttempts = 2;
      params.onAgentEvent = vi.fn();
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "config/read") {
          return {
            config: { mcp_servers: { inherited: { command: "example-mcp" } } },
            layers: [],
            origins: {},
          };
        }
        if (method === "mcpServerStatus/list") {
          return {
            data: [{ name: "inherited", serverInfo: null, tools: {} }],
            nextCursor: null,
          };
        }
        return undefined;
      });

      const run = runCodexAppServerAttempt(params, {
        nativeHookRelay: { enabled: false, events: ["post_tool_use"], gatewayTimeoutMs: 1_000 },
      });
      await harness.waitForMethod("turn/start");
      const startRequest = harness.requests.find((request) => request.method === "thread/start");
      const startConfig = (startRequest?.params as { config?: Record<string, unknown> } | undefined)
        ?.config;
      const stopConfig = startConfig?.["hooks.Stop"] as
        | Array<{ hooks?: Array<{ command?: string; timeout?: number }> }>
        | undefined;
      expect(stopConfig?.[0]?.hooks?.[0]?.timeout).toBe(40);
      expect(stopConfig?.[0]?.hooks?.[0]?.command).toContain("--timeout 39000");
      expect(startConfig?.["hooks.PreToolUse"]).toEqual([]);
      expect(startConfig?.["hooks.PostToolUse"]).toEqual([]);
      expect(startConfig?.["hooks.PermissionRequest"]).toEqual([]);
      const relayId = extractRelayIdFromThreadRequest(startRequest?.params);

      await harness.notify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "stale-final",
            type: "agentMessage",
            text: "KEEP",
            status: "completed",
          },
        },
      });
      const stopResponse = await invokeNativeHookRelay({
        provider: "codex",
        relayId,
        event: "before_agent_finalize",
        rawPayload: {
          hook_event_name: "Stop",
          turn_id: "turn-1",
          model: "gpt-5.4-codex",
          last_assistant_message: "KEEP",
        },
      });
      expect(stopResponse).toMatchObject({
        stdout: `${JSON.stringify({ continue: false })}\n`,
        exitCode: 0,
      });
      expect(Object.keys(JSON.parse(stopResponse.stdout) as Record<string, unknown>)).toEqual([
        "continue",
      ]);
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      const result = await run;

      expect(onBeforeAgentFinalize).toHaveBeenCalledWith({
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        provider: "codex",
        model: "gpt-5.4-codex",
        lastAssistantMessage: "KEEP",
        revisionAttempt: 2,
      });
      expect(result).toMatchObject({
        beforeAgentFinalizeRevisionReason: "Use the newer room activity.",
        beforeAgentFinalizeRevisionDisableTools: true,
        assistantTexts: ["KEEP"],
      });
      expect(result.lastAssistant).toBeDefined();
      expect(result.currentAttemptAssistant).toBeDefined();
      expect(result).not.toHaveProperty("contextEngineTerminalAnchor");
      expect(
        result.messagesSnapshot.some(
          (message) => readMirrorIdentity(message) === "turn-1:assistant",
        ),
      ).toBe(false);
      expect(JSON.stringify(result.messagesSnapshot)).not.toContain("KEEP");
      expect(
        (params.onAgentEvent as ReturnType<typeof vi.fn>).mock.calls.some(
          ([event]) => (event as { stream?: string }).stream === "assistant",
        ),
      ).toBe(false);
      expect(onAccepted).toHaveBeenCalledOnce();
      expect(startConfig?.["features.hooks"]).toBe(true);
      expect(startConfig?.["hooks.state"]).toMatchObject({
        "/<session-flags>/config.toml:stop:0:0": {
          enabled: true,
          trusted_hash: expect.any(String),
        },
      });
      if (disableTools) {
        expect(startConfig).toMatchObject({
          "tools.experimental_request_user_input.enabled": false,
          "features.skill_search": false,
          "features.multi_agent": false,
          "orchestrator.skills.enabled": false,
          mcp_servers: { inherited: { enabled: false } },
        });
        expect(startRequest?.params).toMatchObject({ dynamicTools: [], environments: [] });
        const methods = harness.requests.map(({ method }) => method);
        expect(methods.indexOf("mcpServerStatus/list")).toBeGreaterThan(
          methods.indexOf("thread/start"),
        );
        expect(methods.indexOf("mcpServerStatus/list")).toBeLessThan(methods.indexOf("turn/start"));
      }
    },
  );

  it("suppresses a discard before Codex transcript delivery", async () => {
    const sessionFile = path.join(tempDir, "turn-local-discard.jsonl");
    const workspaceDir = path.join(tempDir, "turn-local-discard-workspace");
    const onAccepted = vi.fn();
    const params = createParams(sessionFile, workspaceDir);
    params.onBeforeAgentFinalize = vi.fn(async () => ({
      action: "discard" as const,
      onAccepted,
    }));
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    await harness.notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "discarded-final",
          type: "agentMessage",
          text: "DROP",
          status: "completed",
        },
      },
    });
    await invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "before_agent_finalize",
      rawPayload: {
        hook_event_name: "Stop",
        turn_id: "turn-1",
        last_assistant_message: "DROP",
      },
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    expect(result).toMatchObject({
      beforeAgentFinalizeDiscarded: true,
      assistantTexts: [],
      lastAssistant: undefined,
      currentAttemptAssistant: undefined,
    });
    expect(
      result.messagesSnapshot.some((message) => readMirrorIdentity(message) === "turn-1:assistant"),
    ).toBe(false);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("DROP");
    expect(onAccepted).toHaveBeenCalledOnce();
  });

  it("honors the host revision limit before installing the turn-local gate", () => {
    const callback = vi.fn(async () => ({ action: "continue" as const }));

    expect(
      shouldEnableCodexTurnLocalFinalization({
        callback,
        revisionAttempt: 1,
        maxRevisionAttempts: 2,
      }),
    ).toBe(true);
    expect(
      shouldEnableCodexTurnLocalFinalization({
        callback,
        revisionAttempt: 2,
        maxRevisionAttempts: 2,
      }),
    ).toBe(false);
  });
});
