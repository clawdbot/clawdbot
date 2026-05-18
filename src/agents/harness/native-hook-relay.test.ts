import { statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateSessionStore, type SessionEntry } from "../../config/sessions.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { patchPluginSessionExtension } from "../../plugins/host-hook-state.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  __testing,
  buildNativeHookRelayCommand,
  hasNativeHookRelayInvocation,
  invokeNativeHookRelay,
  invokeNativeHookRelayBridge,
  registerNativeHookRelay,
} from "./native-hook-relay.js";

afterEach(() => {
  vi.useRealTimers();
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  __testing.clearNativeHookRelaysForTests();
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

function readRecordField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function getMockCallArg(
  mock: { mock: { calls: readonly (readonly unknown[])[] } },
  callIndex: number,
  argIndex: number,
  label: string,
) {
  return requireRecord(mock.mock.calls[callIndex]?.[argIndex], label);
}

function getOnlyNativeHookRelayInvocation() {
  const invocations = __testing.getNativeHookRelayInvocationsForTests();
  expect(invocations).toHaveLength(1);
  return requireRecord(invocations[0], "native hook relay invocation");
}

async function waitForNativeHookRelayBridgeRecord(
  relayId: string,
): Promise<Record<string, unknown>> {
  let record: Record<string, unknown> | undefined;
  await vi.waitFor(() => {
    record = __testing.getNativeHookRelayBridgeRecordForTests(relayId);
    expect(isRecord(record) ? record.relayId : undefined).toBe(relayId);
  });
  return record as Record<string, unknown>;
}

describe("native hook relay registry", () => {
  it("registers a short-lived relay and builds hidden CLI commands", () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
      ttlMs: 10_000,
      command: {
        executable: "/opt/Open Claw/openclaw.mjs",
        nodeExecutable: "/usr/local/bin/node",
        timeoutMs: 1234,
      },
    });

    expectRecordFields(
      requireRecord(
        __testing.getNativeHookRelayRegistrationForTests(relay.relayId),
        "native hook relay registration",
      ),
      {
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        allowedEvents: ["pre_tool_use"],
      },
    );
    expect(relay.commandForEvent("pre_tool_use")).toBe(
      "/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id " +
        `${relay.relayId} --event pre_tool_use --timeout 1234`,
    );
  });

  it("preserves safety relays while marking hook-only events without handlers inactive", () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      command: {
        executable: "/opt/Open Claw/openclaw.mjs",
        nodeExecutable: "/usr/local/bin/node",
        timeoutMs: 1234,
      },
    });

    expect(relay.shouldRelayEvent("pre_tool_use")).toBe(true);
    expect(relay.shouldRelayEvent("post_tool_use")).toBe(false);
    expect(relay.shouldRelayEvent("before_agent_finalize")).toBe(false);
    expect(relay.shouldRelayEvent("permission_request")).toBe(true);
  });

  it("builds relay commands only for native events with matching local hooks", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: vi.fn() }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      command: {
        executable: "/opt/Open Claw/openclaw.mjs",
        nodeExecutable: "/usr/local/bin/node",
        timeoutMs: 1234,
      },
    });

    expect(relay.shouldRelayEvent("pre_tool_use")).toBe(true);
    expect(relay.shouldRelayEvent("post_tool_use")).toBe(true);
    expect(relay.shouldRelayEvent("before_agent_finalize")).toBe(false);
    expect(relay.commandForEvent("post_tool_use")).toBe(
      "/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id " +
        `${relay.relayId} --event post_tool_use --timeout 1234`,
    );
  });

  it("builds relay commands for before-agent-finalize hooks", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_finalize", handler: vi.fn() }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      command: {
        executable: "/opt/Open Claw/openclaw.mjs",
        nodeExecutable: "/usr/local/bin/node",
        timeoutMs: 1234,
      },
    });

    expect(relay.shouldRelayEvent("before_agent_finalize")).toBe(true);
    expect(relay.commandForEvent("before_agent_finalize")).toBe(
      "/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id " +
        `${relay.relayId} --event before_agent_finalize --timeout 1234`,
    );
  });

  it("allows callers to replace a relay at a stable id", () => {
    const first = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-stable-session",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });

    const second = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-stable-session",
      sessionId: "session-1",
      runId: "run-2",
      allowedEvents: ["post_tool_use"],
    });

    expect(second.relayId).toBe(first.relayId);
    expectRecordFields(
      requireRecord(
        __testing.getNativeHookRelayRegistrationForTests(first.relayId),
        "native hook relay registration",
      ),
      {
        runId: "run-2",
        allowedEvents: ["post_tool_use"],
      },
    );
  });

  it("exposes registered relays through the direct hook bridge", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-bridge-session",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });

    const response = await invokeNativeHookRelayBridge({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      timeoutMs: 2_000,
      rawPayload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
      },
    });

    expect(response).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expectRecordFields(getOnlyNativeHookRelayInvocation(), {
      relayId: relay.relayId,
      event: "pre_tool_use",
      runId: "run-1",
    });
  });

  it("renews relay ttl without rotating the direct hook bridge", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-renewed-bridge-session",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
      ttlMs: 10_000,
    });
    const before = await waitForNativeHookRelayBridgeRecord(relay.relayId);

    await new Promise((resolve) => setTimeout(resolve, 5));
    relay.renew(20_000);

    const after = await waitForNativeHookRelayBridgeRecord(relay.relayId);
    expect(after.port).toBe(before.port);
    expect(after.token).toBe(before.token);
    expect(after.expiresAtMs).toBeGreaterThan(before.expiresAtMs as number);

    const response = await invokeNativeHookRelayBridge({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      timeoutMs: 2_000,
      rawPayload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
      },
    });

    expect(response).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("keeps direct bridge registry files private and loopback-only", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-private-bridge-session",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });

    const record = await waitForNativeHookRelayBridgeRecord(relay.relayId);
    const bridgeDir = __testing.getNativeHookRelayBridgeDirForTests();
    const registryPath = __testing.getNativeHookRelayBridgeRegistryPathForTests(relay.relayId);
    expect(statSync(bridgeDir).mode & 0o077).toBe(0);
    expect(statSync(registryPath).mode & 0o077).toBe(0);

    writeFileSync(
      registryPath,
      `${JSON.stringify({
        ...record,
        hostname: "192.0.2.1",
        expiresAtMs: Date.now() + 10_000,
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        registrationTimeoutMs: 1,
        timeoutMs: 50,
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).rejects.toThrow("native hook relay bridge not found");
  });

  it("binds direct bridge tokens to the relay they were issued for", async () => {
    const first = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-first-bridge-session",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });
    const second = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-second-bridge-session",
      sessionId: "session-2",
      runId: "run-2",
      allowedEvents: ["pre_tool_use"],
    });

    const firstRecord = await waitForNativeHookRelayBridgeRecord(first.relayId);
    await waitForNativeHookRelayBridgeRecord(second.relayId);
    writeFileSync(
      __testing.getNativeHookRelayBridgeRegistryPathForTests(second.relayId),
      `${JSON.stringify({
        ...firstRecord,
        relayId: second.relayId,
        expiresAtMs: Date.now() + 10_000,
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId: second.relayId,
        event: "pre_tool_use",
        timeoutMs: 500,
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).rejects.toThrow("native hook relay bridge target mismatch");
    expect(__testing.getNativeHookRelayInvocationsForTests()).toStrictEqual([]);
  });

  it("rejects oversized direct bridge responses", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-oversized-bridge-response",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });
    const record = await waitForNativeHookRelayBridgeRecord(relay.relayId);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("x".repeat(5_000_001));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test bridge server address unavailable");
      }
      writeFileSync(
        __testing.getNativeHookRelayBridgeRegistryPathForTests(relay.relayId),
        `${JSON.stringify({
          ...record,
          port: address.port,
          token: "test-token",
          expiresAtMs: Date.now() + 10_000,
        })}\n`,
        { mode: 0o600 },
      );

      await expect(
        invokeNativeHookRelayBridge({
          provider: "codex",
          relayId: relay.relayId,
          event: "pre_tool_use",
          timeoutMs: 500,
          rawPayload: {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "pnpm test" },
          },
        }),
      ).rejects.toThrow("native hook relay bridge response too large");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("accepts an allowed Codex invocation and preserves raw payload", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        cwd: "/repo",
        model: "gpt-5.4",
        tool_name: "Bash",
        tool_use_id: "call-1",
        tool_input: { command: "pnpm test" },
      },
    });

    expect(response).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    const invocation = getOnlyNativeHookRelayInvocation();
    expectRecordFields(invocation, {
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      nativeEventName: "PreToolUse",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      cwd: "/repo",
      model: "gpt-5.4",
      toolName: "Bash",
      toolUseId: "call-1",
    });
    expect(readRecordField(invocation, "rawPayload", "invocation raw payload").tool_input).toEqual({
      command: "pnpm test",
    });
  });

  it("reports whether a relay already observed a tool use invocation", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use", "post_tool_use"],
    });

    expect(
      hasNativeHookRelayInvocation({
        relayId: relay.relayId,
        event: "pre_tool_use",
        toolUseId: "call-1",
      }),
    ).toBe(false);

    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "call-1",
        tool_input: { command: "pnpm test" },
      },
    });

    expect(
      hasNativeHookRelayInvocation({
        relayId: relay.relayId,
        event: "pre_tool_use",
        toolUseId: "call-1",
      }),
    ).toBe(true);
    expect(
      hasNativeHookRelayInvocation({
        relayId: relay.relayId,
        event: "post_tool_use",
        toolUseId: "call-1",
      }),
    ).toBe(false);
    expect(
      hasNativeHookRelayInvocation({
        relayId: relay.relayId,
        event: "pre_tool_use",
      }),
    ).toBe(false);
  });

  it("retains bounded payload snapshots in invocation history", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });

    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "post_tool_use",
      rawPayload: {
        hook_event_name: "PostToolUse",
        tool_name: "mcp__filesystem__read_file",
        tool_use_id: "large-payload-call",
        tool_input: { path: "/repo/large.txt" },
        tool_response: "x".repeat(50_000),
      },
    });

    const [recorded] = __testing.getNativeHookRelayInvocationsForTests();
    expect(JSON.stringify(recorded?.rawPayload).length).toBeLessThan(25_000);
    const rawPayload = readRecordField(
      requireRecord(recorded, "native hook relay invocation"),
      "rawPayload",
      "invocation raw payload",
    );
    expect(String(rawPayload.tool_response)).toContain("[truncated]");
  });

  it("removes retained invocations when a relay is unregistered", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });

    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "call-1",
        tool_input: { command: "pnpm test" },
      },
    });

    expect(__testing.getNativeHookRelayInvocationsForTests()).toHaveLength(1);

    relay.unregister();

    expect(__testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeUndefined();
    expect(__testing.getNativeHookRelayInvocationsForTests()).toStrictEqual([]);
  });

  it("keeps only a bounded history of retained invocations", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });

    for (let index = 0; index < 210; index += 1) {
      await invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: `call-${index}`,
          tool_input: { command: `echo ${index}` },
        },
      });
    }

    const invocations = __testing.getNativeHookRelayInvocationsForTests();
    expect(invocations).toHaveLength(200);
    expect(invocations.map((invocation) => invocation.toolUseId)).not.toContain("call-0");
    expect(invocations.at(-1)?.toolUseId).toBe("call-209");
  });

  it("rejects missing, wrong-provider, and disallowed-event invocations", async () => {
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: "missing",
        event: "pre_tool_use",
        rawPayload: {},
      }),
    ).rejects.toThrow("not found");

    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });

    await expect(
      invokeNativeHookRelay({
        provider: "claude-code",
        relayId: relay.relayId,
        event: "post_tool_use",
        rawPayload: {},
      }),
    ).rejects.toThrow("unsupported");

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {},
      }),
    ).rejects.toThrow("not allowed");
  });

  it("rejects payloads beyond the relay JSON budget without recursive traversal", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });
    let rawPayload: Record<string, unknown> = {};
    for (let index = 0; index < 80; index += 1) {
      rawPayload = { child: rawPayload };
    }

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload,
      }),
    ).rejects.toThrow("JSON-compatible");
  });

  it("rejects broad object payloads before reading children beyond the JSON node budget", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });
    const rawPayload: Record<string, unknown> = {};
    for (let index = 0; index < 19_999; index += 1) {
      rawPayload[`k${index}`] = index;
    }
    let overBudgetValueRead = false;
    Object.defineProperty(rawPayload, "overBudget", {
      enumerable: true,
      get() {
        overBudgetValueRead = true;
        return "should not be read";
      },
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "post_tool_use",
        rawPayload,
      }),
    ).rejects.toThrow("JSON-compatible");
    expect(overBudgetValueRead).toBe(false);
  });

  it("rejects payloads beyond the relay string budget", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "post_tool_use",
        rawPayload: {
          tool_response: "x".repeat(1_000_001),
        },
      }),
    ).rejects.toThrow("JSON-compatible");
  });

  it("rejects payloads beyond the relay aggregate string budget", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "post_tool_use",
        rawPayload: Array.from({ length: 5 }, () => "x".repeat(900_000)),
      }),
    ).rejects.toThrow("JSON-compatible");
  });

  it("rejects payloads beyond the relay object key budget", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["permission_request"],
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          tool_name: "mcp__shell__run_command",
          tool_input: {
            ["x".repeat(1_000_001)]: "value",
          },
        },
      }),
    ).rejects.toThrow("JSON-compatible");
  });

  it("rejects expired relay ids", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T12:00:00Z"));
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      ttlMs: 1,
    });

    vi.setSystemTime(new Date("2026-04-24T12:00:01Z"));

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {},
      }),
    ).rejects.toThrow("expired");
    expect(__testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeUndefined();
  });

  it("uses the Codex no-op output when no OpenClaw hook decides", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });

    for (const event of ["pre_tool_use", "post_tool_use", "before_agent_finalize"] as const) {
      await expect(
        invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          event,
          rawPayload: { hook_event_name: event },
        }),
      ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    }
  });

  it("maps Codex PreToolUse to OpenClaw before_tool_call and blocks before execution", async () => {
    const beforeToolCall = vi.fn(async () => ({
      block: true,
      blockReason: "repo policy blocks this command",
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      channelId: "telegram",
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        cwd: "/repo",
        model: "gpt-5.4",
        tool_name: "Bash",
        tool_use_id: "native-call-1",
        tool_input: { command: "rm -rf dist" },
      },
    });

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "repo policy blocks this command",
      },
    });
    expect(response.exitCode).toBe(0);
    const event = getMockCallArg(beforeToolCall, 0, 0, "before tool call event");
    expectRecordFields(event, {
      toolName: "exec",
      params: { command: "rm -rf dist" },
      runId: "run-1",
      toolCallId: "native-call-1",
    });
    const context = getMockCallArg(beforeToolCall, 0, 1, "before tool call context");
    expectRecordFields(context, {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      channelId: "telegram",
      toolName: "exec",
      toolCallId: "native-call-1",
    });
  });

  it("normalizes Codex exec_command cmd input before running OpenClaw policy", async () => {
    const beforeToolCall = vi.fn(async () => ({
      block: true,
      blockReason: "shell command blocked",
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      channelId: "telegram",
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        cwd: "/repo",
        tool_name: "exec_command",
        tool_use_id: "native-exec-command-1",
        tool_input: { cmd: "cat /tmp/private_key", yield_time_ms: 1000 },
      },
    });

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "shell command blocked",
      },
    });
    const event = getMockCallArg(beforeToolCall, 0, 0, "before tool call event");
    expectRecordFields(event, {
      toolName: "exec",
      params: {
        cmd: "cat /tmp/private_key",
        command: "cat /tmp/private_key",
        yield_time_ms: 1000,
      },
      runId: "run-1",
      toolCallId: "native-exec-command-1",
    });
  });

  it("prefers Codex exec_command cmd over a stale command field", async () => {
    const beforeToolCall = vi.fn(async (event: unknown) => {
      const command = (event as { params?: { command?: string } }).params?.command;
      return command === "rm -rf dist"
        ? { block: true, blockReason: "destructive command blocked" }
        : undefined;
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      channelId: "telegram",
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        tool_name: "exec_command",
        tool_use_id: "native-exec-command-stale-command",
        tool_input: { command: "echo safe", cmd: "rm -rf dist" },
      },
    });

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "destructive command blocked",
      },
    });
    const event = getMockCallArg(beforeToolCall, 0, 0, "before tool call event");
    expectRecordFields(event, {
      toolName: "exec",
      params: {
        cmd: "rm -rf dist",
        command: "rm -rf dist",
      },
      toolCallId: "native-exec-command-stale-command",
    });
  });

  it("normalizes Codex exec_command argv cmd input before running OpenClaw policy", async () => {
    const beforeToolCall = vi.fn(async () => ({
      block: true,
      blockReason: "argv command blocked",
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        cwd: "/repo",
        tool_name: "exec_command",
        tool_use_id: "native-exec-command-array-1",
        tool_input: { cmd: ["cat", "/tmp/private key"] },
      },
    });

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "argv command blocked",
      },
    });
    const event = getMockCallArg(beforeToolCall, 0, 0, "before tool call event");
    expectRecordFields(event, {
      toolName: "exec",
      params: {
        cmd: ["cat", "/tmp/private key"],
        command: "cat '/tmp/private key'",
      },
      runId: "run-1",
      toolCallId: "native-exec-command-array-1",
    });
  });

  it("blocks Codex app-server report-mode pre-tool calls when policy rewrites params", async () => {
    const beforeToolCall = vi.fn(async () => ({
      params: { command: "echo rewritten" },
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        openclaw_approval_mode: "report",
        cwd: "/repo",
        tool_name: "exec_command",
        tool_use_id: "native-report-rewrite-1",
        tool_input: { cmd: "cat /tmp/private_key" },
      },
    });

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "OpenClaw tool policy rewrote Codex app-server approval params; refusing original request.",
      },
    });
    expect(beforeToolCall).toHaveBeenCalledTimes(1);
  });

  it("blocks ordinary Codex native pre-tool calls when policy rewrites params", async () => {
    const beforeToolCall = vi.fn(async () => ({
      params: { command: "echo rewritten" },
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        cwd: "/repo",
        tool_name: "exec_command",
        tool_use_id: "native-rewrite-1",
        tool_input: { cmd: "cat /tmp/private_key" },
      },
    });

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "OpenClaw tool policy rewrote Codex app-server approval params; refusing original request.",
      },
    });
    expect(beforeToolCall).toHaveBeenCalledTimes(1);
  });

  it("blocks Codex native pre-tool calls when policy mutates params in place", async () => {
    const beforeToolCall = vi.fn(async (event: unknown) => {
      const params = requireRecord(
        requireRecord(event, "before tool call event").params,
        "before tool call params",
      );
      params.command = "echo rewritten";
      return { params };
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        cwd: "/repo",
        tool_name: "exec_command",
        tool_use_id: "native-in-place-rewrite-1",
        tool_input: { cmd: "cat /tmp/private_key" },
      },
    });

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "OpenClaw tool policy rewrote Codex app-server approval params; refusing original request.",
      },
    });
    expect(beforeToolCall).toHaveBeenCalledTimes(1);
  });

  it("reports synthetic app-server PreToolUse approval requirements without opening plugin approvals", async () => {
    const beforeToolCall = vi.fn(async () => ({
      requireApproval: {
        title: "Needs approval",
        description: "native command needs approval",
      },
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        openclaw_approval_mode: "report",
        cwd: "/repo",
        tool_name: "exec_command",
        tool_use_id: "native-approval-report-1",
        tool_input: { cmd: "cat /tmp/private_key" },
      },
    });

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "native command needs approval",
      },
    });
    expect(beforeToolCall).toHaveBeenCalledTimes(1);
  });

  it("passes config to trusted policies for native pre-tool session extension reads", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-native-relay-policy-"));
    const storePath = path.join(stateDir, "sessions.json");
    const config = { session: { store: storePath } };
    const seen: unknown[] = [];
    const registry = createEmptyPluginRegistry();
    registry.sessionExtensions = [
      {
        pluginId: "policy-plugin",
        pluginName: "Policy Plugin",
        source: "test",
        extension: {
          namespace: "policy",
          description: "policy state",
        },
      },
    ];
    registry.trustedToolPolicies = [
      {
        pluginId: "policy-plugin",
        pluginName: "Policy Plugin",
        source: "test",
        policy: {
          id: "session-extension-policy",
          description: "session extension policy",
          evaluate(_event, ctx) {
            const policyState = ctx.getSessionExtension?.("policy");
            seen.push(policyState);
            if ((policyState as { block?: boolean } | undefined)?.block) {
              return { block: true, blockReason: "blocked by session extension" };
            }
            return undefined;
          },
        },
      },
    ];
    setActivePluginRegistry(registry);
    try {
      await updateSessionStore(storePath, (store) => {
        store["agent:main:session-1"] = {
          sessionId: "session-1",
          updatedAt: Date.now(),
        } as SessionEntry;
      });
      const patchResult = await patchPluginSessionExtension({
        cfg: config as never,
        sessionKey: "agent:main:session-1",
        pluginId: "policy-plugin",
        namespace: "policy",
        value: { block: true },
      });
      expect(patchResult.ok).toBe(true);

      const relay = registerNativeHookRelay({
        provider: "codex",
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        config: config as never,
        runId: "run-1",
        allowedEvents: ["pre_tool_use"],
      });

      const response = await invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "native-policy-call-1",
          tool_input: { command: "rm -rf dist" },
        },
      });

      expect(JSON.parse(response.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "blocked by session extension",
        },
      });
      expect(seen).toEqual([{ block: true }]);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("uses the Codex cwd when deriving apply_patch paths for PreToolUse", async () => {
    const beforeToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
    });
    const cwd = path.join("/tmp", "openclaw-native-hook-cwd");
    const patch = ["*** Begin Patch", "*** Add File: src/new.ts", "+x", "*** End Patch"].join("\n");

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        cwd,
        tool_name: "apply_patch",
        tool_use_id: "native-patch-1",
        tool_input: { input: patch },
      },
    });

    expect(response).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    const event = getMockCallArg(beforeToolCall, 0, 0, "before tool call event");
    expectRecordFields(event, {
      toolName: "apply_patch",
      params: { input: patch },
      derivedPaths: [path.join(cwd, "src/new.ts")],
    });
    const context = getMockCallArg(beforeToolCall, 0, 1, "before tool call context");
    expectRecordFields(context, {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      toolName: "apply_patch",
      toolCallId: "native-patch-1",
    });
  });

  it("blocks Codex native Bash pre-tool calls when policy rewrites params", async () => {
    const beforeToolCall = vi.fn(async () => ({
      params: { command: "echo replaced" },
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "native-call-1",
        tool_input: { command: "echo original" },
      },
    });

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "OpenClaw tool policy rewrote Codex app-server approval params; refusing original request.",
      },
    });
    expect(response.stderr).toBe("");
    expect(response.exitCode).toBe(0);
    expect(beforeToolCall).toHaveBeenCalledTimes(1);
  });

  it("maps Codex PostToolUse to OpenClaw after_tool_call observation", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      channelId: "telegram",
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "post_tool_use",
      rawPayload: {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "native-call-1",
        tool_input: { command: "pnpm test" },
        tool_response: { output: "ok", exit_code: 0 },
      },
    });

    expect(response).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    const event = getMockCallArg(afterToolCall, 0, 0, "after tool call event");
    expectRecordFields(event, {
      toolName: "exec",
      params: { command: "pnpm test" },
      runId: "run-1",
      toolCallId: "native-call-1",
      result: { output: "ok", exit_code: 0 },
    });
    const context = getMockCallArg(afterToolCall, 0, 1, "after tool call context");
    expectRecordFields(context, {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      channelId: "telegram",
      toolName: "exec",
      toolCallId: "native-call-1",
    });
  });

  it("maps Codex MCP PreToolUse to OpenClaw before_tool_call and can block", async () => {
    const beforeToolCall = vi.fn(async () => ({
      block: true,
      blockReason: "MCP writes require review",
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        cwd: "/repo",
        model: "gpt-5.4",
        tool_name: "mcp__memory__create_entities",
        tool_use_id: "mcp-call-1",
        tool_input: {
          entities: [{ name: "OpenClaw", entityType: "project", observations: ["test"] }],
        },
      },
    });

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "MCP writes require review",
      },
    });
    const event = getMockCallArg(beforeToolCall, 0, 0, "before tool call event");
    expectRecordFields(event, {
      toolName: "mcp__memory__create_entities",
      params: {
        entities: [{ name: "OpenClaw", entityType: "project", observations: ["test"] }],
      },
      runId: "run-1",
      toolCallId: "mcp-call-1",
    });
    const context = getMockCallArg(beforeToolCall, 0, 1, "before tool call context");
    expectRecordFields(context, {
      toolName: "mcp__memory__create_entities",
      toolCallId: "mcp-call-1",
    });
  });

  it("lets security-style plugins block native MCP calls by scanning tool params", async () => {
    const beforeToolCall = vi.fn(async (event: unknown) => {
      const hookEvent = event as { params?: unknown; toolName?: string };
      const serializedParams = JSON.stringify(hookEvent.params ?? {});
      if (hookEvent.toolName?.startsWith("mcp__") && serializedParams.includes("rm -rf")) {
        return {
          block: true,
          blockReason: "Blocked by security policy: destructive MCP command detected",
        };
      }
      return undefined;
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__shell__run_command",
        tool_use_id: "mcp-call-security",
        tool_input: {
          command: "rm -rf /tmp/openclaw-important-state",
        },
      },
    });

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Blocked by security policy: destructive MCP command detected",
      },
    });
    const event = getMockCallArg(beforeToolCall, 0, 0, "before tool call event");
    expectRecordFields(event, {
      toolName: "mcp__shell__run_command",
      params: {
        command: "rm -rf /tmp/openclaw-important-state",
      },
      toolCallId: "mcp-call-security",
    });
    const context = getMockCallArg(beforeToolCall, 0, 1, "before tool call context");
    expectRecordFields(context, {
      toolName: "mcp__shell__run_command",
      toolCallId: "mcp-call-security",
    });
  });

  it("maps Codex MCP PostToolUse to OpenClaw after_tool_call observation", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "post_tool_use",
      rawPayload: {
        hook_event_name: "PostToolUse",
        tool_name: "mcp__filesystem__read_file",
        tool_use_id: "mcp-call-2",
        tool_input: { path: "/repo/package.json" },
        tool_response: {
          content: [{ type: "text", text: '{ "name": "openclaw" }' }],
          structuredContent: { bytes: 22 },
        },
      },
    });

    expect(response).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    const event = getMockCallArg(afterToolCall, 0, 0, "after tool call event");
    expectRecordFields(event, {
      toolName: "mcp__filesystem__read_file",
      params: { path: "/repo/package.json" },
      runId: "run-1",
      toolCallId: "mcp-call-2",
      result: {
        content: [{ type: "text", text: '{ "name": "openclaw" }' }],
        structuredContent: { bytes: 22 },
      },
    });
    const context = getMockCallArg(afterToolCall, 0, 1, "after tool call context");
    expectRecordFields(context, {
      toolName: "mcp__filesystem__read_file",
      toolCallId: "mcp-call-2",
    });
  });

  it("routes Codex MCP PermissionRequest payloads through OpenClaw approval policy", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
    });
    const approvalRequester = vi.fn(async () => "allow" as const);
    __testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        model: "gpt-5.4",
        tool_name: "mcp__github__create_issue",
        tool_use_id: "mcp-call-3",
        tool_input: {
          owner: "openclaw",
          repo: "openclaw",
          title: "Test issue",
        },
      },
    });

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    const request = getMockCallArg(approvalRequester, 0, 0, "approval request");
    expectRecordFields(request, {
      provider: "codex",
      toolName: "mcp__github__create_issue",
      toolCallId: "mcp-call-3",
      toolInput: {
        owner: "openclaw",
        repo: "openclaw",
        title: "Test issue",
      },
    });
  });

  it("maps Codex Stop to before_agent_finalize revision output", async () => {
    const beforeAgentFinalize = vi.fn(async () => ({
      action: "revise",
      reason: "please run the focused tests before finalizing",
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_finalize", handler: beforeAgentFinalize },
      ]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      channelId: "telegram",
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "before_agent_finalize",
      rawPayload: {
        hook_event_name: "Stop",
        session_id: "codex-session-1",
        turn_id: "turn-1",
        cwd: "/repo",
        transcript_path: "/tmp/session.jsonl",
        model: "gpt-5.4",
        permission_mode: "workspace-write",
        stop_hook_active: true,
        last_assistant_message: "done",
      },
    });

    expect(response).toEqual({
      stdout: `${JSON.stringify({
        decision: "block",
        reason: "please run the focused tests before finalizing",
      })}\n`,
      stderr: "",
      exitCode: 0,
    });
    const event = getMockCallArg(beforeAgentFinalize, 0, 0, "before finalize event");
    expectRecordFields(event, {
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      turnId: "turn-1",
      provider: "codex",
      model: "gpt-5.4",
      cwd: "/repo",
      transcriptPath: "/tmp/session.jsonl",
      stopHookActive: true,
      lastAssistantMessage: "done",
    });
    const context = getMockCallArg(beforeAgentFinalize, 0, 1, "before finalize context");
    expectRecordFields(context, {
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      channelId: "telegram",
      workspaceDir: "/repo",
      modelId: "gpt-5.4",
    });
  });

  it("maps before_agent_finalize finalize output to Codex continue false", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_agent_finalize",
          handler: vi.fn(async () => ({ action: "finalize", reason: "already checked" })),
        },
      ]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "before_agent_finalize",
      rawPayload: {
        hook_event_name: "Stop",
        stop_hook_active: false,
      },
    });

    expect(response).toEqual({
      stdout: `${JSON.stringify({
        continue: false,
        stopReason: "already checked",
      })}\n`,
      stderr: "",
      exitCode: 0,
    });
  });

  it("maps PermissionRequest approval allow and deny decisions to Codex hook output", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
    });
    const approvalRequester = vi
      .fn()
      .mockResolvedValueOnce("allow" as const)
      .mockResolvedValueOnce("deny" as const);
    __testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const allow = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        model: "gpt-5.4",
        tool_name: "Bash",
        tool_input: { command: "git push" },
      },
    });
    const deny = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "curl https://example.com" },
      },
    });

    expect(JSON.parse(allow.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    expect(JSON.parse(deny.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Denied by user" },
      },
    });
    const request = getMockCallArg(approvalRequester, 0, 0, "approval request");
    expectRecordFields(request, {
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      toolName: "exec",
      cwd: "/repo",
      model: "gpt-5.4",
      toolInput: { command: "git push" },
    });
  });

  it("reuses allow-always PermissionRequest approvals for identical relay content", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-stable-permission-cache",
      sessionId: "session-1",
      runId: "run-1",
    });
    const approvalRequester = vi.fn(async () => "allow-always" as const);
    __testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const first = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-1",
        tool_input: { command: "browserforce tabs" },
      },
    });
    relay.unregister();
    registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-stable-permission-cache",
      sessionId: "session-1",
      runId: "run-2",
    });
    const second = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-2",
        tool_input: { command: "browserforce tabs" },
      },
    });

    expect(approvalRequester).toHaveBeenCalledTimes(1);
    expect([first, second].map((response) => JSON.parse(response.stdout))).toEqual([
      {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      },
      {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      },
    ]);
  });

  it("does not reuse allow-always PermissionRequest approvals across sessions with the same relay id", async () => {
    const relayId = "codex-stable-permission-cache-cross-session";
    const first = registerNativeHookRelay({
      provider: "codex",
      relayId,
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
    });
    const approvalRequester = vi.fn(async () => "allow-always" as const);
    __testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    await invokeNativeHookRelay({
      provider: "codex",
      relayId: first.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-1",
        tool_input: { command: "browserforce tabs" },
      },
    });
    first.unregister();
    const second = registerNativeHookRelay({
      provider: "codex",
      relayId,
      agentId: "agent-1",
      sessionId: "session-2",
      sessionKey: "agent:main:session-2",
      runId: "run-2",
    });
    await invokeNativeHookRelay({
      provider: "codex",
      relayId: second.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-2",
        tool_input: { command: "browserforce tabs" },
      },
    });

    expect(approvalRequester).toHaveBeenCalledTimes(2);
    const request = getMockCallArg(approvalRequester, 1, 0, "second approval request");
    expectRecordFields(request, {
      agentId: "agent-1",
      sessionId: "session-2",
      sessionKey: "agent:main:session-2",
      toolInput: { command: "browserforce tabs" },
    });
  });

  it("keeps allow-always PermissionRequest reuse scoped to matching cwd and input", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });
    const approvalRequester = vi.fn(async () => "allow-always" as const);
    __testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo-a",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      },
    });
    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo-b",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      },
    });
    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo-a",
        tool_name: "Bash",
        tool_input: { command: "npm test -- --changed" },
      },
    });

    expect(approvalRequester).toHaveBeenCalledTimes(3);
  });

  it("defers PermissionRequest when OpenClaw approval does not decide", async () => {
    __testing.setNativeHookRelayPermissionApprovalRequesterForTests(
      vi.fn(async () => "defer" as const),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "cargo test" },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("deduplicates pending PermissionRequest approvals by relay, run, and tool call", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });
    let resolveDecision: ((decision: "allow") => void) | undefined;
    const pendingDecision = new Promise<"allow">((resolve) => {
      resolveDecision = resolve;
    });
    const approvalRequester = vi.fn(() => pendingDecision);
    __testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const payload = {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_use_id: "native-call-1",
      tool_input: { command: "git push" },
    };
    const first = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: payload,
    });
    const second = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: payload,
    });

    await Promise.resolve();
    expect(approvalRequester).toHaveBeenCalledTimes(1);
    resolveDecision?.("allow");
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => JSON.parse(response.stdout))).toEqual([
      {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      },
      {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      },
    ]);
  });

  it("does not reuse pending PermissionRequest approvals when a tool call id is reused with different input", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });
    let resolveDecision: ((decision: "allow") => void) | undefined;
    const pendingDecision = new Promise<"allow">((resolve) => {
      resolveDecision = resolve;
    });
    const approvalRequester = vi.fn(async (request: { toolInput?: Record<string, unknown> }) => {
      return request.toolInput?.command === "git status" ? pendingDecision : "deny";
    });
    __testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const first = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_use_id: "reused-call-id",
        tool_input: { command: "git status" },
      },
    });
    const second = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_use_id: "reused-call-id",
        tool_input: { command: "rm -rf /tmp/openclaw-important-state" },
      },
    });

    await Promise.resolve();
    expect(approvalRequester).toHaveBeenCalledTimes(2);
    const secondResponse = await second;
    expect(JSON.parse(secondResponse.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Denied by user" },
      },
    });
    resolveDecision?.("allow");
    const firstResponse = await first;
    expect(JSON.parse(firstResponse.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("defers PermissionRequest approvals after the per-relay approval budget is exhausted", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });
    const approvalRequester = vi.fn(async () => "allow" as const);
    __testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const responses = [];
    for (let index = 0; index < 13; index += 1) {
      responses.push(
        await invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          event: "permission_request",
          rawPayload: {
            hook_event_name: "PermissionRequest",
            tool_name: "Bash",
            tool_use_id: `native-call-${index}`,
            tool_input: { command: `echo ${index}` },
          },
        }),
      );
    }

    expect(approvalRequester).toHaveBeenCalledTimes(12);
    expect(responses.at(-1)).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("deduplicates pending PermissionRequest approvals before consuming approval budget", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });
    const resolvers: Array<(decision: "allow") => void> = [];
    const approvalRequester = vi.fn(
      () =>
        new Promise<"allow">((resolve) => {
          resolvers.push(resolve);
        }),
    );
    __testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const duplicatePayload = {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_use_id: "native-call-1",
      tool_input: { command: "git push" },
    };
    const duplicateRequests = Array.from({ length: 12 }, () =>
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: duplicatePayload,
      }),
    );
    await Promise.resolve();
    expect(approvalRequester).toHaveBeenCalledTimes(1);

    const newRequest = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        ...duplicatePayload,
        tool_use_id: "native-call-2",
        tool_input: { command: "curl https://example.com" },
      },
    });
    await Promise.resolve();
    expect(approvalRequester).toHaveBeenCalledTimes(2);

    for (const resolve of resolvers) {
      resolve("allow");
    }
    await expect(Promise.all([...duplicateRequests, newRequest])).resolves.toHaveLength(13);
  });

  it("uses canonical PermissionRequest content fingerprints for ordinary objects", () => {
    const first = __testing.permissionRequestContentFingerprintForTests({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      toolName: "exec",
      toolInput: { a: 1, b: { x: 2, y: 3 } },
    });
    const second = __testing.permissionRequestContentFingerprintForTests({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      toolName: "exec",
      toolInput: { b: { y: 3, x: 2 }, a: 1 },
    });

    expect(second).toBe(first);
  });

  it("keeps broad PermissionRequest content fingerprints sensitive to tail changes", () => {
    const firstToolInput = Object.fromEntries(
      Array.from({ length: 205 }, (_, index) => [`key-${index}`, `value-${index}`]),
    );
    const secondToolInput = {
      ...firstToolInput,
      "key-204": "changed",
    };

    expect(
      __testing.permissionRequestContentFingerprintForTests({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        toolName: "exec",
        toolInput: firstToolInput,
      }),
    ).not.toBe(
      __testing.permissionRequestContentFingerprintForTests({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        toolName: "exec",
        toolInput: secondToolInput,
      }),
    );
  });

  it("fingerprints broad PermissionRequest inputs without Object.keys enumeration", () => {
    const toolInput = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`key-${index}`, `value-${index}`]),
    );
    const objectKeys = vi.spyOn(Object, "keys").mockImplementation(() => {
      throw new Error("Object.keys should not be used for permission fingerprints");
    });

    try {
      expect(__testing.permissionRequestToolInputKeyFingerprintForTests(toolInput)).toContain(
        "key-",
      );
      expect(
        __testing.permissionRequestContentFingerprintForTests({
          provider: "codex",
          sessionId: "session-1",
          runId: "run-1",
          toolName: "exec",
          toolInput,
        }),
      ).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      objectKeys.mockRestore();
    }
  });

  it("sanitizes PermissionRequest approval previews and reports omitted keys", () => {
    expect(
      __testing.formatPermissionApprovalDescriptionForTests({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        toolName: "exec",
        cwd: "/repo\u001b[31m/red\u001b[0m",
        model: "gpt-5.4\u202edenied",
        toolInput: {
          command: "printf 'ok'\r\n\u001b[31mred\u001b[0m",
        },
      }),
    ).toBe("Tool: exec\nCwd: /repo/red\nModel: gpt-5.4 denied\nCommand: printf 'ok' red");

    expect(
      __testing.formatPermissionApprovalDescriptionForTests({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        toolName: "exec",
        toolInput: Object.fromEntries(
          Array.from({ length: 13 }, (_, index) => [`key-${index}`, index]),
        ),
      }),
    ).toContain("(1 omitted)");
  });
});

describe("native hook relay command builder", () => {
  it("uses the Codex hook relay command shape", () => {
    expect(
      buildNativeHookRelayCommand({
        provider: "codex",
        relayId: "relay-1",
        event: "permission_request",
        executable: "openclaw",
      }),
    ).toBe(
      "openclaw hooks relay --provider codex --relay-id relay-1 --event permission_request --timeout 5000",
    );
  });
});
