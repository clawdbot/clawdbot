// Codex tests cover native hook relay plugin behavior.
import type { NativeHookRelayRegistrationHandle } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCodexNativeHookRelayAllowed,
  buildCodexNativeHookRelayConfig,
  buildCodexNativeHookRelayDisabledConfig,
  emitCodexNativePreToolUseFailureDiagnostic,
} from "./native-hook-relay.js";

afterEach(() => resetDiagnosticEventsForTest());

function flushDiagnosticEvents(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("Codex native hook relay managed policy", () => {
  it.each([
    { name: "absent requirements", response: { requirements: null } },
    { name: "ordinary hooks", response: { requirements: { allowManagedHooksOnly: false } } },
  ])("accepts $name and caches the authoritative process policy", async ({ response }) => {
    const request = vi.fn(async () => response);
    const client = { request };

    await assertCodexNativeHookRelayAllowed(client as never);
    await assertCodexNativeHookRelayAllowed(client as never);

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("configRequirements/read", undefined, {
      signal: undefined,
    });
  });

  it.each([
    { name: "missing response", response: {} },
    { name: "invalid requirements", response: { requirements: [] } },
    { name: "invalid managed hook flag", response: { requirements: { allowManagedHooksOnly: 1 } } },
  ])("fails closed on $name and allows a corrected retry", async ({ response }) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce({ requirements: null });
    const client = { request };

    await expect(assertCodexNativeHookRelayAllowed(client as never)).rejects.toThrow(/invalid/i);
    await expect(assertCodexNativeHookRelayAllowed(client as never)).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("Codex native hook relay config", () => {
  it("builds deterministic Codex config overrides with command hooks", () => {
    const config = buildCodexNativeHookRelayConfig({
      relay: createRelay(),
      hookTimeoutSec: 7,
    });

    expect(config).toEqual({
      "features.hooks": true,
      "hooks.PreToolUse": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event pre_tool_use --timeout 6000",
              timeout: 7,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.PostToolUse": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event post_tool_use --timeout 6000",
              timeout: 7,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.PermissionRequest": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event permission_request --timeout 6000",
              timeout: 7,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.Stop": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event before_agent_finalize --timeout 6000",
              timeout: 7,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.SubagentStop": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event before_agent_finalize --timeout 6000",
              timeout: 7,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.state": {
        "/<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "/<session-flags>/config.toml:post_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:post_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "/<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "/<session-flags>/config.toml:stop:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:stop:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "/<session-flags>/config.toml:subagent_stop:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:subagent_stop:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain("timeoutSec");
    expect(JSON.stringify(config)).not.toContain('"matcher":null');
    expect(config["hooks.SubagentStop"]).toEqual(config["hooks.Stop"]);
    const hookState = config["hooks.state"] as Record<string, { trusted_hash?: string }>;
    const stopTrustedHash = hookState["/<session-flags>/config.toml:stop:0:0"]?.trusted_hash;
    const subagentStopTrustedHash =
      hookState["/<session-flags>/config.toml:subagent_stop:0:0"]?.trusted_hash;
    expect(stopTrustedHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(subagentStopTrustedHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(subagentStopTrustedHash).not.toBe(stopTrustedHash);
    expect(config).not.toHaveProperty("hooks.SessionStart");
    expect(config).not.toHaveProperty("hooks.UserPromptSubmit");
  });

  it("includes only requested hook events", () => {
    expect(
      buildCodexNativeHookRelayConfig({
        relay: createRelay(),
        events: ["permission_request"],
      }),
    ).toEqual({
      "features.hooks": true,
      "hooks.PermissionRequest": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event permission_request --timeout 9000",
              timeout: 10,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.state": {
        "/<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("clears requested hook events when the relay reports no local work", () => {
    expect(
      buildCodexNativeHookRelayConfig({
        relay: createRelay({ inactiveEvents: ["post_tool_use", "before_agent_finalize"] }),
        events: ["pre_tool_use", "post_tool_use", "before_agent_finalize"],
      }),
    ).toEqual({
      "features.hooks": true,
      "hooks.PreToolUse": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event pre_tool_use --timeout 9000",
              timeout: 10,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.PostToolUse": [],
      "hooks.Stop": [],
      "hooks.SubagentStop": [],
      "hooks.state": {
        "/<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("clears selected PreToolUse when the relay has no local work", () => {
    const config = buildCodexNativeHookRelayConfig({
      relay: createRelay({ inactiveEvents: ["pre_tool_use"] }),
      events: ["pre_tool_use"],
    });

    expect(config).toEqual({
      "features.hooks": true,
      "hooks.PreToolUse": [],
      "hooks.state": {},
    });
  });

  it("clears omitted hook events when requested", () => {
    expect(
      buildCodexNativeHookRelayConfig({
        relay: createRelay(),
        events: ["permission_request"],
        clearOmittedEvents: true,
      }),
    ).toEqual({
      "features.hooks": true,
      "hooks.PreToolUse": [],
      "hooks.PostToolUse": [],
      "hooks.PermissionRequest": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event permission_request --timeout 9000",
              timeout: 10,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.Stop": [],
      "hooks.SubagentStop": [],
      "hooks.state": {
        "/<session-flags>/config.toml:pre_tool_use:0:0": { enabled: false },
        "<session-flags>/config.toml:pre_tool_use:0:0": { enabled: false },
        "/<session-flags>/config.toml:post_tool_use:0:0": { enabled: false },
        "<session-flags>/config.toml:post_tool_use:0:0": { enabled: false },
        "/<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "/<session-flags>/config.toml:stop:0:0": { enabled: false },
        "<session-flags>/config.toml:stop:0:0": { enabled: false },
        "/<session-flags>/config.toml:subagent_stop:0:0": { enabled: false },
        "<session-flags>/config.toml:subagent_stop:0:0": { enabled: false },
      },
    });
  });

  it("omits matchers so Codex MCP tool names reach the relay with a stable trust hash", () => {
    const config = buildCodexNativeHookRelayConfig({
      relay: createRelay(),
      events: ["pre_tool_use", "post_tool_use"],
    });

    expect((config["hooks.PreToolUse"] as Array<{ matcher?: unknown }>)[0]).not.toHaveProperty(
      "matcher",
    );
    expect((config["hooks.PostToolUse"] as Array<{ matcher?: unknown }>)[0]).not.toHaveProperty(
      "matcher",
    );
    const hookState = config["hooks.state"] as Record<
      string,
      { enabled: boolean; trusted_hash: string }
    >;
    expect(hookState["/<session-flags>/config.toml:pre_tool_use:0:0"]?.trusted_hash).toBe(
      "sha256:00eef2fb113075f6aa238484c41e5eac82830c98c6379611019592ad93d2e56b",
    );
    expect(hookState["/<session-flags>/config.toml:post_tool_use:0:0"]?.trusted_hash).toBe(
      "sha256:64b626a7cee798d42404b892982925feda7b335a9cd0ed62be905ab2e2766c1f",
    );
  });

  it("projects canonical OpenClaw ids to Codex canonical and alias matcher names", () => {
    const config = buildCodexNativeHookRelayConfig({
      relay: createRelay({
        matchers: {
          pre_tool_use: ["exec"],
          post_tool_use: ["apply_patch", "spawn_agent"],
        },
      }),
      events: ["pre_tool_use", "post_tool_use"],
    });

    expect(config["hooks.PreToolUse"]).toEqual([
      expect.objectContaining({ matcher: "Bash|exec|exec_command" }),
    ]);
    expect(config["hooks.PostToolUse"]).toEqual([
      expect.objectContaining({ matcher: "Agent|Edit|Write|apply_patch|spawn_agent" }),
    ]);
    expect(JSON.stringify(config)).not.toContain("web_search");
  });

  it("matches custom Codex tool names case-insensitively without widening the scope", () => {
    const config = buildCodexNativeHookRelayConfig({
      relay: createRelay({ matchers: { pre_tool_use: ["deploy"] } }),
      events: ["pre_tool_use"],
    });

    expect(config["hooks.PreToolUse"]).toEqual([
      expect.objectContaining({ matcher: "(?i)^(?:deploy)$" }),
    ]);
  });

  it("rejects an empty canonical matcher scope instead of widening to match-all", () => {
    expect(() =>
      buildCodexNativeHookRelayConfig({
        relay: createRelay({ matchers: { pre_tool_use: [] } }),
        events: ["pre_tool_use"],
      }),
    ).toThrow("Codex native hook matcher requires at least one tool name");
  });

  it("builds deterministic clearing config when the relay is disabled", () => {
    expect(buildCodexNativeHookRelayDisabledConfig()).toEqual({
      "features.hooks": false,
      "hooks.PreToolUse": [],
      "hooks.PostToolUse": [],
      "hooks.PermissionRequest": [],
      "hooks.Stop": [],
      "hooks.SubagentStop": [],
    });
  });

  it.each([
    { reason: "turn_progress_idle_timeout", terminalReason: "timed_out" },
    { reason: "turn_completion_idle_timeout", terminalReason: "timed_out" },
    { reason: "turn_terminal_idle_timeout", terminalReason: "timed_out" },
    { reason: "client_closed", terminalReason: "failed" },
  ] as const)(
    "projects native pre-tool failure reason $reason without a Codex item",
    async ({ reason, terminalReason }) => {
      const controller = new AbortController();
      controller.abort(reason);
      const events: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => events.push(event));
      try {
        emitCodexNativePreToolUseFailureDiagnostic({
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          runId: "run-1",
          signal: controller.signal,
          failure: {
            toolName: "exec",
            toolCallId: "native-no-item",
            disposition: "cancelled",
            durationMs: 5,
          },
        });
        await flushDiagnosticEvents();
      } finally {
        unsubscribe();
      }

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool.execution.error",
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          runId: "run-1",
          toolName: "exec",
          toolCallId: "native-no-item",
          durationMs: 5,
          errorCategory: "before_tool_call",
          terminalReason,
        }),
      );
    },
  );
});

function createRelay(options?: {
  inactiveEvents?: readonly NativeHookRelayRegistrationHandle["allowedEvents"][number][];
  matchers?: Partial<
    Record<
      NativeHookRelayRegistrationHandle["allowedEvents"][number],
      readonly string[] | undefined
    >
  >;
}): NativeHookRelayRegistrationHandle {
  const inactiveEvents = new Set(options?.inactiveEvents ?? []);
  return {
    relayId: "relay-1",
    provider: "codex",
    generation: "generation-1",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    runId: "run-1",
    allowedEvents: ["pre_tool_use", "post_tool_use", "permission_request", "before_agent_finalize"],
    expiresAtMs: Date.now() + 1000,
    shouldRelayEvent: (event) => !inactiveEvents.has(event),
    toolMatcherForEvent: (event) => options?.matchers?.[event],
    commandForEvent: (event, commandOptions) =>
      `openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event ${event}${
        event === "pre_tool_use" && inactiveEvents.has(event)
          ? " --pre-tool-use-unavailable noop"
          : ""
      }${commandOptions?.timeoutMs ? ` --timeout ${commandOptions.timeoutMs}` : ""}`,
    renew: () => undefined,
    unregister: () => undefined,
  };
}
