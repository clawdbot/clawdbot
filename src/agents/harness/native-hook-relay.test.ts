import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Covers native hook relay registration, bridge invocation, and approval state.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  createAgentRuntimeApprovalAuthorityValidator,
  mintAgentRuntimeIdentityToken,
} from "../../gateway/agent-runtime-identity-token.js";
import { validateAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { patchPluginSessionExtension } from "../../plugins/host-hook-state.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  closeAdmittedRunDelegatedAuthority,
  getAdmittedRunDelegatedAuthority,
} from "../admitted-run-context.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import * as nativeHookRelayBridge from "./native-hook-relay-bridge.js";
import { invokeNativeHookRelayBridge } from "./native-hook-relay-client.js";
import {
  deleteNativeHookRelayBridgeRecordIfOwned,
  readNativeHookRelayBridgeRecord,
  writeNativeHookRelayBridgeRecord,
  type NativeHookRelayBridgeRecord,
} from "./native-hook-relay-store.js";
import {
  registerRetainedNativeHookRelay,
  testing,
  buildNativeHookRelayCommand,
  hasNativeHookRelayInvocation,
  invokeNativeHookRelay,
  registerNativeHookRelay,
  resolveNativeHookRelayDeferredToolApproval,
} from "./native-hook-relay.js";

const NATIVE_HOOK_RELAY_EXEC_PREFIX = process.platform === "win32" ? "" : "exec ";

function readTestNativeAgentId(rawPayload: unknown): string | undefined {
  if (!isRecord(rawPayload) || typeof rawPayload.agent_id !== "string") {
    return undefined;
  }
  return rawPayload.agent_id.trim() || undefined;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  testing.clearNativeHookRelaysForTests();
});

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

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
  const invocations = testing.getNativeHookRelayInvocationsForTests();
  expect(invocations).toHaveLength(1);
  return requireRecord(invocations[0], "native hook relay invocation");
}

async function waitForNativeHookRelayBridgeRecord(
  relayId: string,
): Promise<NativeHookRelayBridgeRecord> {
  let record: NativeHookRelayBridgeRecord | undefined;
  await vi.waitFor(() => {
    record = readNativeHookRelayBridgeRecord({ relayId });
    expect(record?.relayId).toBe(relayId);
  });
  if (!record) {
    throw new Error(`Expected native hook relay bridge record for ${relayId}`);
  }
  return record;
}

async function writeForeignNativeHookRelayBridgeRecordForTests(
  relayId: string,
  record: {
    pid: number;
    expiresAtMs: number;
  },
): Promise<string> {
  writeNativeHookRelayBridgeRecord({
    record: {
      relayId,
      pid: record.pid,
      hostname: "127.0.0.1",
      port: 9,
      token: "test-token-placeholder",
      expiresAtMs: record.expiresAtMs,
    },
  });
  return relayId;
}

function uniqueNativeHookRelayIdForTests(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function nativeHookRelayStateDbArgForTests(): string {
  return `--state-db ${resolveOpenClawStateSqlitePath()}`;
}

function openDeferredNativeHookRelayBridgeRequest(
  record: Pick<NativeHookRelayBridgeRecord, "hostname" | "port" | "token">,
  payload: Record<string, unknown>,
): {
  connected: Promise<void>;
  response: Promise<Record<string, unknown>>;
  sendBody: () => void;
} {
  const body = JSON.stringify(payload);
  let settled = false;
  let resolveResponse!: (value: Record<string, unknown>) => void;
  let rejectResponse!: (error: unknown) => void;
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const req = httpRequest(
    {
      hostname: record.hostname,
      method: "POST",
      path: "/invoke",
      port: record.port,
      headers: {
        authorization: `Bearer ${record.token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    },
    (res) => {
      let responseText = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        responseText += typeof chunk === "string" ? chunk : String(chunk);
      });
      res.on("error", rejectResponse);
      res.on("end", () => {
        if (settled) {
          return;
        }
        settled = true;
        resolveResponse(requireRecord(JSON.parse(responseText), "bridge response"));
      });
    },
  );
  const connected = new Promise<void>((resolve, reject) => {
    req.on("socket", (socket) => {
      socket.on("error", reject);
      if (socket.connecting) {
        socket.once("connect", resolve);
        return;
      }
      resolve();
    });
  });
  req.on("error", (error) => {
    if (!settled) {
      settled = true;
      rejectResponse(error);
    }
  });
  req.flushHeaders();
  return {
    connected,
    response,
    sendBody: () => req.end(body),
  };
}

type NativeHookRelaySharedStateForTests = {
  relays: Map<string, unknown>;
  relayBridges: Map<string, unknown>;
  invocations: unknown[];
  pendingPermissionApprovals: Map<string, unknown>;
  permissionApprovalWindows: Map<string, unknown[]>;
  permissionAllowAlwaysApprovals: Map<string, unknown>;
};

function getNativeHookRelaySharedStateForTests(): NativeHookRelaySharedStateForTests {
  // Native relay state is intentionally shared on globalThis so duplicate
  // module imports in one process still see one approval/bridge registry.
  const state = (
    globalThis as typeof globalThis & {
      [key: symbol]: NativeHookRelaySharedStateForTests | undefined;
    }
  )[Symbol.for("openclaw.nativeHookRelay.state")];
  if (!state) {
    throw new Error("Expected native hook relay shared state to be initialized");
  }
  return state;
}

type NativeHookRelayModuleForTests = typeof import("./native-hook-relay.js");

async function importDuplicateNativeHookRelayModuleForTests(): Promise<NativeHookRelayModuleForTests> {
  vi.resetModules();
  return import("./native-hook-relay.js");
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
        testing.getNativeHookRelayRegistrationForTests(relay.relayId),
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
      `${NATIVE_HOOK_RELAY_EXEC_PREFIX}/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id ` +
        `${relay.relayId} ${nativeHookRelayStateDbArgForTests()} --generation ${relay.generation} --event pre_tool_use --timeout 1234`,
    );
    expect(relay.commandForEvent("pre_tool_use", { timeoutMs: 900 })).toBe(
      `${NATIVE_HOOK_RELAY_EXEC_PREFIX}/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id ` +
        `${relay.relayId} ${nativeHookRelayStateDbArgForTests()} --generation ${relay.generation} --event pre_tool_use --timeout 900`,
    );
    expect(relay.commandForEvent("pre_tool_use", { timeoutMs: 2_000 })).toBe(
      `${NATIVE_HOOK_RELAY_EXEC_PREFIX}/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id ` +
        `${relay.relayId} ${nativeHookRelayStateDbArgForTests()} --generation ${relay.generation} --event pre_tool_use --timeout 1234`,
    );
  });

  it("rejects relay registrations when expiry would exceed Date range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));

    expect(() =>
      registerNativeHookRelay({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        allowedEvents: ["pre_tool_use"],
      }),
    ).toThrow("Native hook relay expiry is outside the supported Date range");
  });

  it("stores relay registrations, bridges, and invocations in process-global state", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-global-state-session",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });
    const state = getNativeHookRelaySharedStateForTests();

    expect(state.relays.get(relay.relayId)).toMatchObject({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });
    await waitForNativeHookRelayBridgeRecord(relay.relayId);
    expect(state.relayBridges.get(relay.relayId)).toMatchObject({
      relayId: relay.relayId,
    });

    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
      },
    });

    expect(state.invocations.at(-1)).toMatchObject({
      relayId: relay.relayId,
      event: "pre_tool_use",
    });
  });

  it("rejects a bound pre-tool policy result after exact host authority closes", async () => {
    let active = true;
    let resolvePolicy:
      | ((value: { blocked: false; params: Record<string, unknown> }) => void)
      | undefined;
    const runBeforeToolCall = vi.fn(
      () =>
        new Promise<{ blocked: false; params: Record<string, unknown> }>((resolve) => {
          resolvePolicy = resolve;
        }),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-bound-authority-close",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall,
      assertActive: () => {
        if (!active) {
          throw new Error("agent harness host capability is no longer active");
        }
      },
    });
    const invocation = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        openclaw_approval_mode: "report",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-close-1",
        tool_input: { command: "git status" },
      },
    });
    await vi.waitFor(() => expect(runBeforeToolCall).toHaveBeenCalledTimes(1));
    active = false;
    resolvePolicy?.({ blocked: false, params: { command: "git status" } });

    await expect(invocation).rejects.toThrow("agent harness host capability is no longer active");
    expect(runBeforeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalMode: "defer",
        nativeOperation: { cwd: "/repo" },
      }),
    );
  });

  it("keeps flat agent ids on the ordinary foreground policy path", async () => {
    const runBeforeToolCall = vi.fn(async () => ({ blocked: false as const, params: {} }));
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: uniqueNativeHookRelayIdForTests("ordinary-foreground-agent"),
      sessionId: "session-1",
      runId: "run-ordinary-foreground-agent",
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall,
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          agent_id: "foreground-child",
          tool_name: "Bash",
          tool_input: { command: "true" },
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(runBeforeToolCall).toHaveBeenCalledOnce();
  });

  it("rejects an in-flight root policy after foreground close while a child retains the relay", async () => {
    const { admittedRunContext, hostCapabilities } = await createAdmittedHostCapabilityTestFixture({
      runId: "run-root-foreground-close",
    });
    let resolvePolicy: ((value: undefined) => void) | undefined;
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: () =>
            new Promise<undefined>((resolve) => {
              resolvePolicy = resolve;
            }),
        },
      ]),
    );
    const relay = registerRetainedNativeHookRelay({
      provider: "codex",
      relayId: "codex-root-foreground-close",
      sessionId: "session-1",
      runId: "run-root-foreground-close",
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall: hostCapabilities.runBeforeToolCall,
      assertActive: hostCapabilities.assertActive,
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => true,
        allowPreToolUse: () => false,
        onDispose: () => {},
      },
    });
    const invocation = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        openclaw_approval_mode: "report",
        tool_name: "Bash",
        tool_input: { command: "git status" },
      },
    });
    await vi.waitFor(() => {
      expect(resolvePolicy).toBeTypeOf("function");
    });
    relay.unregister();
    resolvePolicy?.(undefined);

    await expect(invocation).rejects.toThrow("foreground invocation not allowed");
    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeDefined();
    closeAdmittedRunDelegatedAuthority(admittedRunContext);
    relay.unregister();
  });

  it("keeps only a claimed flat native child after foreground cleanup", async () => {
    const { admittedRunContext, hostCapabilities } = await createAdmittedHostCapabilityTestFixture({
      runId: "run-retained-child",
    });
    const delegatedAuthority = getAdmittedRunDelegatedAuthority(admittedRunContext);
    if (!delegatedAuthority) {
      throw new Error("Expected admitted delegated authority");
    }
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const approvalRequester = vi.fn(async () => "allow" as const);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);
    let retainChild = true;
    const relay = registerRetainedNativeHookRelay({
      provider: "codex",
      relayId: "codex-retained-direct-child",
      sessionId: "session-1",
      runId: "run-retained-child",
      allowedEvents: ["pre_tool_use", "permission_request", "post_tool_use"],
      runBeforeToolCall: hostCapabilities.runBeforeToolCall,
      assertActive: hostCapabilities.assertActive,
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => retainChild,
        allowPreToolUse: (claim) => claim === "child-thread",
        onDispose: () => {},
      },
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: { tool_name: "Bash", tool_input: { command: "true" } },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    const permission = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        agent_id: "child-thread",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "true" },
      },
    });
    expect(JSON.parse(permission.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    expect(approvalRequester).toHaveBeenCalledOnce();

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "post_tool_use",
        rawPayload: {
          agent_id: "child-thread",
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "true" },
          tool_response: { output: "ok" },
          tool_use_id: "child-post-tool",
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(afterToolCall).toHaveBeenCalledOnce();

    expect(closeAdmittedRunDelegatedAuthority(admittedRunContext)).toBe(true);
    expect(validateAgentRunDelegatedAuthority(delegatedAuthority)).toBe(false);
    await expect(
      mintAgentRuntimeIdentityToken({
        agentId: "main",
        sessionKey: "agent:main:session-1",
        operationalRunInstance: admittedRunContext.operationalRunInstance,
      }),
    ).rejects.toThrow("requires active delegated run authority");
    expect(
      createAgentRuntimeApprovalAuthorityValidator()({
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:session-1",
        operationalRunInstance: admittedRunContext.operationalRunInstance,
        delegatedAuthority: { kind: "local", ...delegatedAuthority },
      }),
    ).toBe(false);
    relay.unregister();
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          agent_id: "child-thread",
          tool_name: "Bash",
          tool_input: { command: "true" },
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          agent_id: "child-thread",
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "true" },
        },
      }),
    ).rejects.toThrow("foreground invocation not allowed");
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "post_tool_use",
        rawPayload: {
          agent_id: "child-thread",
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "true" },
          tool_response: { output: "ok" },
          tool_use_id: "child-post-tool-after-close",
        },
      }),
    ).rejects.toThrow("foreground invocation not allowed");
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          agent_id: "unknown-child",
          tool_name: "Bash",
          tool_input: { command: "true" },
        },
      }),
    ).rejects.toThrow("retained invocation not allowed");
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          agent: { agent_id: "child-thread" },
          tool_name: "Bash",
          tool_input: { command: "true" },
        },
      }),
    ).rejects.toThrow("foreground invocation not allowed");

    retainChild = false;
    relay.unregister();
  });

  it.each(["abort", "expiry"] as const)(
    "physically releases active retained child authority on %s",
    async (cause) => {
      if (cause === "expiry") {
        vi.useFakeTimers();
      }
      const { admittedRunContext, hostCapabilities } =
        await createAdmittedHostCapabilityTestFixture({ runId: `run-retained-${cause}` });
      const delegatedAuthority = getAdmittedRunDelegatedAuthority(admittedRunContext);
      if (!delegatedAuthority) {
        throw new Error("Expected admitted delegated authority");
      }
      const controller = new AbortController();
      const relay = registerRetainedNativeHookRelay({
        provider: "codex",
        relayId: uniqueNativeHookRelayIdForTests(`retained-${cause}`),
        sessionId: "session-1",
        runId: `run-retained-${cause}`,
        allowedEvents: ["pre_tool_use"],
        runBeforeToolCall: hostCapabilities.runBeforeToolCall,
        assertActive: hostCapabilities.assertActive,
        retention: {
          readClaim: readTestNativeAgentId,
          shouldRetainAfterForegroundClose: () => true,
          allowPreToolUse: (claim) => claim === "child-thread",
          onDispose: () => {},
        },
        ...(cause === "abort" ? { signal: controller.signal } : { ttlMs: 5 }),
      });

      closeAdmittedRunDelegatedAuthority(admittedRunContext);
      expect(validateAgentRunDelegatedAuthority(delegatedAuthority)).toBe(false);
      relay.unregister();
      await expect(
        invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          event: "pre_tool_use",
          rawPayload: { agent_id: "child-thread", tool_name: "Bash", tool_input: {} },
        }),
      ).resolves.toMatchObject({ exitCode: 0 });

      if (cause === "abort") {
        controller.abort();
      } else {
        await vi.advanceTimersByTimeAsync(6);
      }
      expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeUndefined();
      expect(testing.getNativeHookRelayBridgeRecordForTests(relay.relayId)).toBeUndefined();
      await expect(
        invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          event: "pre_tool_use",
          rawPayload: { agent_id: "child-thread", tool_name: "Bash", tool_input: {} },
        }),
      ).rejects.toThrow("native hook relay not found");
    },
  );

  it("leaves retained host authority available after an ordinary same-host relay", async () => {
    const { admittedRunContext, hostCapabilities } = await createAdmittedHostCapabilityTestFixture({
      runId: "run-ordinary-then-retaining",
    });
    const ordinary = registerNativeHookRelay({
      provider: "codex",
      relayId: uniqueNativeHookRelayIdForTests("ordinary-same-host"),
      sessionId: "session-1",
      runId: "run-ordinary",
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall: hostCapabilities.runBeforeToolCall,
      assertActive: hostCapabilities.assertActive,
    });
    const retaining = registerRetainedNativeHookRelay({
      provider: "codex",
      relayId: uniqueNativeHookRelayIdForTests("retaining-same-host"),
      sessionId: "session-1",
      runId: "run-retaining",
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall: hostCapabilities.runBeforeToolCall,
      assertActive: hostCapabilities.assertActive,
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => true,
        allowPreToolUse: (claim) => claim === "child-thread",
        onDispose: () => {},
      },
    });

    closeAdmittedRunDelegatedAuthority(admittedRunContext);
    ordinary.unregister();
    retaining.unregister();
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: retaining.relayId,
        event: "pre_tool_use",
        rawPayload: { agent_id: "child-thread", tool_name: "Bash", tool_input: {} },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    retaining.unregister();
  });

  it("does not retain authority from a runtime-shaped public registration", async () => {
    const { admittedRunContext, hostCapabilities } = await createAdmittedHostCapabilityTestFixture({
      runId: "run-forged-public-retention",
    });
    const onDispose = vi.fn();
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: uniqueNativeHookRelayIdForTests("forged-public-retention"),
      sessionId: "session-1",
      runId: "run-forged-public-retention",
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall: hostCapabilities.runBeforeToolCall,
      assertActive: hostCapabilities.assertActive,
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => true,
        allowPreToolUse: () => true,
        onDispose,
      },
    } as unknown as Parameters<typeof registerNativeHookRelay>[0]);

    expect(closeAdmittedRunDelegatedAuthority(admittedRunContext)).toBe(true);
    relay.unregister();

    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeUndefined();
    expect(onDispose).not.toHaveBeenCalled();
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: { agent_id: "child-thread", tool_name: "Bash", tool_input: {} },
      }),
    ).rejects.toThrow("native hook relay not found");
  });

  it.each(["explicit", "abort", "expiry", "replacement"] as const)(
    "cleans relay resources when onUnregister throws during %s",
    async (mode) => {
      if (mode === "expiry") {
        vi.useFakeTimers();
      }
      const controller = new AbortController();
      const relayId = uniqueNativeHookRelayIdForTests("throwing-unregister");
      const relay = registerRetainedNativeHookRelay({
        provider: "codex",
        relayId,
        sessionId: "session-1",
        runId: "run-throwing-unregister",
        ...(mode === "abort" ? { signal: controller.signal } : {}),
        ...(mode === "expiry" ? { ttlMs: 5 } : {}),
        retention: {
          readClaim: readTestNativeAgentId,
          shouldRetainAfterForegroundClose: () => false,
          allowPreToolUse: () => false,
          onDispose: () => {
            throw new Error("teardown observer failed");
          },
        },
      });

      if (mode === "explicit") {
        expect(() => relay.unregister()).not.toThrow();
      } else if (mode === "abort") {
        expect(() => controller.abort()).not.toThrow();
      } else if (mode === "expiry") {
        await vi.advanceTimersByTimeAsync(6);
      } else {
        registerNativeHookRelay({
          provider: "codex",
          relayId,
          sessionId: "session-1",
          runId: "run-successor",
        });
      }

      if (mode === "replacement") {
        expect(testing.getNativeHookRelayRegistrationForTests(relayId)?.runId).toBe(
          "run-successor",
        );
      } else {
        expect(testing.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
      }
      if (mode !== "replacement") {
        expect(testing.getNativeHookRelayBridgeRecordForTests(relayId)).toBeUndefined();
      }
    },
  );

  it("fails closed when a retained relay predicate throws", () => {
    const relayId = uniqueNativeHookRelayIdForTests("throwing-retain-predicate");
    const relay = registerRetainedNativeHookRelay({
      provider: "codex",
      relayId,
      sessionId: "session-1",
      runId: "run-throwing-retain-predicate",
      retention: {
        readClaim: readTestNativeAgentId,
        allowPreToolUse: () => false,
        onDispose: () => {},
        shouldRetainAfterForegroundClose: () => {
          throw new Error("predicate failed");
        },
      },
    });

    expect(() => relay.unregister()).not.toThrow();
    expect(testing.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("keeps a reentrant same-id successor after old teardown completes", () => {
    const relayId = uniqueNativeHookRelayIdForTests("reentrant-successor");
    const first = registerRetainedNativeHookRelay({
      provider: "codex",
      relayId,
      sessionId: "session-1",
      runId: "run-first",
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => false,
        allowPreToolUse: () => false,
        onDispose: () => {
          registerNativeHookRelay({
            provider: "codex",
            relayId,
            sessionId: "session-1",
            runId: "run-successor",
          });
        },
      },
    });

    first.unregister();
    expect(testing.getNativeHookRelayRegistrationForTests(relayId)?.runId).toBe("run-successor");
  });

  it("keeps the callback-created successor after replacement teardown", async () => {
    const relayId = uniqueNativeHookRelayIdForTests("replacement-reentrant-successor");
    let callbackSuccessor: ReturnType<typeof registerNativeHookRelay> | undefined;
    const first = registerRetainedNativeHookRelay({
      provider: "codex",
      relayId,
      sessionId: "session-1",
      runId: "run-first",
      allowedEvents: ["post_tool_use"],
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => false,
        allowPreToolUse: () => false,
        onDispose: () => {
          callbackSuccessor = registerNativeHookRelay({
            provider: "codex",
            relayId,
            sessionId: "session-1",
            runId: "run-callback-successor",
            allowedEvents: ["post_tool_use"],
          });
        },
      },
    });
    const replacementUnregistered = vi.fn();
    registerRetainedNativeHookRelay({
      provider: "codex",
      relayId,
      sessionId: "session-1",
      runId: "run-replacement",
      allowedEvents: ["post_tool_use"],
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => false,
        allowPreToolUse: () => false,
        onDispose: replacementUnregistered,
      },
    });

    expect(callbackSuccessor).toBeDefined();
    expect(replacementUnregistered).toHaveBeenCalledOnce();
    expect(testing.getNativeHookRelayRegistrationForTests(relayId)?.runId).toBe(
      "run-callback-successor",
    );
    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId,
        generation: callbackSuccessor!.generation,
        event: "post_tool_use",
        timeoutMs: 2_000,
        rawPayload: { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: {} },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    first.unregister();
    callbackSuccessor?.unregister();
  });

  it("delivers old replacement callback when the successor signal is already aborted", () => {
    const relayId = uniqueNativeHookRelayIdForTests("replacement-preaborted");
    const oldUnregistered = vi.fn();
    registerRetainedNativeHookRelay({
      provider: "codex",
      relayId,
      sessionId: "session-1",
      runId: "run-old",
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => false,
        allowPreToolUse: () => false,
        onDispose: oldUnregistered,
      },
    });
    const controller = new AbortController();
    controller.abort();

    expect(() =>
      registerNativeHookRelay({
        provider: "codex",
        relayId,
        sessionId: "session-1",
        runId: "run-preaborted-successor",
        signal: controller.signal,
      }),
    ).toThrow("native hook relay registration aborted");

    expect(oldUnregistered).toHaveBeenCalledOnce();
    expect(testing.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
    expect(testing.getNativeHookRelayBridgeRecordForTests(relayId)).toBeUndefined();
  });

  it("cleans a partial retained relay when bridge setup throws", async () => {
    const { admittedRunContext, hostCapabilities } = await createAdmittedHostCapabilityTestFixture({
      runId: "run-bridge-setup-throws",
    });
    const relayId = uniqueNativeHookRelayIdForTests("bridge-setup-throws");
    const bridgeFailure = vi
      .spyOn(nativeHookRelayBridge, "registerNativeHookRelayBridge")
      .mockImplementation(() => {
        throw new Error("bridge setup failed");
      });

    expect(() =>
      registerRetainedNativeHookRelay({
        provider: "codex",
        relayId,
        sessionId: "session-1",
        runId: "run-bridge-setup-throws",
        runBeforeToolCall: hostCapabilities.runBeforeToolCall,
        assertActive: hostCapabilities.assertActive,
        retention: {
          readClaim: readTestNativeAgentId,
          shouldRetainAfterForegroundClose: () => true,
          allowPreToolUse: () => false,
          onDispose: () => {},
        },
      }),
    ).toThrow("bridge setup failed");
    expect(testing.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
    expect(testing.getNativeHookRelayBridgeRecordForTests(relayId)).toBeUndefined();
    expect(getAdmittedRunDelegatedAuthority(admittedRunContext)).toBeDefined();

    bridgeFailure.mockRestore();
    const successor = registerNativeHookRelay({
      provider: "codex",
      relayId,
      sessionId: "session-1",
      runId: "run-bridge-setup-successor",
    });
    expect(testing.getNativeHookRelayRegistrationForTests(relayId)?.runId).toBe(
      "run-bridge-setup-successor",
    );
    successor.unregister();
  });

  it("stores permission approval state in process-global state", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-global-permission-state",
      sessionId: "session-1",
      runId: "run-1",
    });
    let resolveDecision: ((decision: "allow-always") => void) | undefined;
    const pendingDecision = new Promise<"allow-always">((resolve) => {
      resolveDecision = resolve;
    });
    const approvalRequester = vi.fn(() => pendingDecision);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const first = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-1",
        tool_input: { command: "git status" },
      },
    });
    const state = getNativeHookRelaySharedStateForTests();
    await vi.waitFor(() => expect(state.pendingPermissionApprovals.size).toBe(1));
    expect(state.permissionApprovalWindows.get(relay.relayId)).toHaveLength(1);

    resolveDecision?.("allow-always");
    await expect(first).resolves.toMatchObject({ exitCode: 0 });
    expect(state.pendingPermissionApprovals.size).toBe(0);
    expect(state.permissionAllowAlwaysApprovals.size).toBe(1);

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          cwd: "/repo",
          tool_name: "Bash",
          tool_use_id: "native-call-2",
          tool_input: { command: "git status" },
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(approvalRequester).toHaveBeenCalledTimes(1);
  });

  it("does not remember allow-always approvals when expiry would exceed Date range", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-permission-overflow-session",
      sessionId: "session-1",
      runId: "run-1",
    });
    const approvalRequester = vi.fn(async () => "allow-always" as const);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    const state = getNativeHookRelaySharedStateForTests();
    const registration = state.relays.get(relay.relayId) as { expiresAtMs?: number } | undefined;
    if (!registration) {
      throw new Error("Expected native hook relay registration");
    }
    registration.expiresAtMs = 8_640_000_000_000_000;

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          cwd: "/repo",
          tool_name: "Bash",
          tool_use_id: "native-call-1",
          tool_input: { command: "git status" },
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(state.permissionAllowAlwaysApprovals.size).toBe(0);

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          cwd: "/repo",
          tool_name: "Bash",
          tool_use_id: "native-call-2",
          tool_input: { command: "git status" },
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(approvalRequester).toHaveBeenCalledTimes(2);
  });

  it("shares relay state across duplicate module instances", async () => {
    const duplicateModule = await importDuplicateNativeHookRelayModuleForTests();
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-duplicate-module-session",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use", "permission_request"],
    });

    await expect(
      duplicateModule.invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(getOnlyNativeHookRelayInvocation()).toMatchObject({
      relayId: relay.relayId,
      event: "pre_tool_use",
    });

    const duplicateApprovalRequester = vi.fn(async () => "allow-always" as const);
    duplicateModule.testing.setNativeHookRelayPermissionApprovalRequesterForTests(
      duplicateApprovalRequester,
    );
    const duplicateApproval = await duplicateModule.invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-1",
        tool_input: { command: "git status" },
      },
    });
    expect(JSON.parse(duplicateApproval.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });

    const primaryApprovalRequester = vi.fn(async () => "deny" as const);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(primaryApprovalRequester);
    const primaryApproval = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-2",
        tool_input: { command: "git status" },
      },
    });
    expect(JSON.parse(primaryApproval.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });

    expect(duplicateApprovalRequester).toHaveBeenCalledTimes(1);
    expect(primaryApprovalRequester).not.toHaveBeenCalled();

    const replacement = duplicateModule.registerNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      sessionId: "session-1",
      runId: "run-2",
      allowedEvents: ["post_tool_use"],
    });
    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toMatchObject({
      runId: "run-2",
      allowedEvents: ["post_tool_use"],
    });

    relay.unregister();
    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toMatchObject({
      runId: "run-2",
      allowedEvents: ["post_tool_use"],
    });
    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId: replacement.relayId,
        generation: replacement.generation,
        event: "post_tool_use",
        timeoutMs: 2_000,
        rawPayload: {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_response: { output: "ok" },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    replacement.unregister();
  });

  it("ignores stale exact-owner teardown after same-id replacement", async () => {
    const relayId = uniqueNativeHookRelayIdForTests("stale-owner-successor");
    const first = registerNativeHookRelay({
      provider: "codex",
      relayId,
      sessionId: "session-1",
      runId: "run-first",
      allowedEvents: ["post_tool_use"],
    });
    const successor = registerNativeHookRelay({
      provider: "codex",
      relayId,
      sessionId: "session-1",
      runId: "run-successor",
      allowedEvents: ["post_tool_use"],
    });
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId,
        event: "post_tool_use",
        rawPayload: { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: {} },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    first.unregister();

    expect(testing.getNativeHookRelayRegistrationForTests(relayId)?.runId).toBe("run-successor");
    expect(testing.getNativeHookRelayInvocationsForTests()).toContainEqual(
      expect.objectContaining({ relayId, event: "post_tool_use" }),
    );
    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId,
        generation: successor.generation,
        event: "post_tool_use",
        timeoutMs: 2_000,
        rawPayload: { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: {} },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    first.unregister();
    successor.unregister();
  });

  it("preserves permission relays while marking hook-only events without handlers inactive", () => {
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

    expect(relay.shouldRelayEvent("pre_tool_use")).toBe(false);
    expect(relay.shouldRelayEvent("post_tool_use")).toBe(false);
    expect(relay.shouldRelayEvent("before_agent_finalize")).toBe(false);
    expect(relay.shouldRelayEvent("permission_request")).toBe(true);
    expect(relay.commandForEvent("pre_tool_use")).toBe(
      `${NATIVE_HOOK_RELAY_EXEC_PREFIX}/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id ` +
        `${relay.relayId} ${nativeHookRelayStateDbArgForTests()} --generation ${relay.generation} --event pre_tool_use --timeout 1234`,
    );
  });

  it("builds pre-tool relay commands only when before-tool policy is active", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: vi.fn(), matcher: ["exec"] },
      ]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      preToolUseLoopDetection: false,
      command: {
        executable: "/opt/Open Claw/openclaw.mjs",
        nodeExecutable: "/usr/local/bin/node",
        timeoutMs: 1234,
      },
    });

    expect(relay.shouldRelayEvent("pre_tool_use")).toBe(true);
    expect(relay.toolMatcherForEvent("pre_tool_use")).toEqual(["exec"]);
    expect(relay.commandForEvent("pre_tool_use")).toBe(
      `${NATIVE_HOOK_RELAY_EXEC_PREFIX}/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id ` +
        `${relay.relayId} ${nativeHookRelayStateDbArgForTests()} --generation ${relay.generation} --event pre_tool_use --timeout 1234`,
    );
  });

  it("unions hook and trusted-policy matcher scopes for pre-tool relays", () => {
    const hookRegistry = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: vi.fn(), matcher: ["exec"] },
    ]);
    const policyRegistry = createMockPluginRegistry([]);
    policyRegistry.trustedToolPolicies = [
      {
        pluginId: "policy-plugin",
        pluginName: "Policy Plugin",
        source: "test",
        policy: {
          id: "patch-policy",
          description: "Protect patch tools",
          matcher: ["apply_patch"],
          evaluate: vi.fn(),
        },
      },
    ];
    setActivePluginRegistry(policyRegistry);
    initializeGlobalHookRunner(hookRegistry);

    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      preToolUseLoopDetection: false,
    });

    expect(relay.shouldRelayEvent("pre_tool_use")).toBe(true);
    expect(relay.toolMatcherForEvent("pre_tool_use")).toEqual(["apply_patch", "exec"]);
  });

  it("keeps canonical spawn_agent in the generic pre-tool relay scope", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: vi.fn(), matcher: ["spawn_agent"] },
      ]),
    );

    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      preToolUseLoopDetection: false,
    });

    expect(relay.toolMatcherForEvent("pre_tool_use")).toEqual(["spawn_agent"]);
  });

  it("omits loop-detection-only pre-tool relays by default", () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
    });

    expect(relay.shouldRelayEvent("pre_tool_use")).toBe(false);
  });

  it("installs pre-tool relays when loop detection is explicitly enabled", () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      config: { tools: { loopDetection: { enabled: true } } } as never,
      command: {
        executable: "/opt/Open Claw/openclaw.mjs",
        nodeExecutable: "/usr/local/bin/node",
        timeoutMs: 1234,
      },
    });

    expect(relay.shouldRelayEvent("pre_tool_use")).toBe(true);
    expect(relay.commandForEvent("pre_tool_use")).toBe(
      `${NATIVE_HOOK_RELAY_EXEC_PREFIX}/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id ` +
        `${relay.relayId} ${nativeHookRelayStateDbArgForTests()} --generation ${relay.generation} --event pre_tool_use --timeout 1234`,
    );
  });

  it("omits pre-tool relays when native loop detection is explicitly disabled", () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      config: { tools: { loopDetection: { enabled: false } } } as never,
    });

    expect(relay.shouldRelayEvent("pre_tool_use")).toBe(false);
  });

  it("omits loop-detection-only pre-tool relays when the harness capability is disabled", () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      config: { tools: { loopDetection: { enabled: true } } } as never,
      preToolUseLoopDetection: false,
    });

    expect(relay.shouldRelayEvent("pre_tool_use")).toBe(false);
  });

  it("builds relay commands only for native events with matching local hooks", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "after_tool_call", handler: vi.fn(), matcher: ["apply_patch"] },
      ]),
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

    expect(relay.shouldRelayEvent("pre_tool_use")).toBe(false);
    expect(relay.shouldRelayEvent("post_tool_use")).toBe(true);
    expect(relay.toolMatcherForEvent("post_tool_use")).toEqual(["apply_patch"]);
    expect(relay.shouldRelayEvent("before_agent_finalize")).toBe(false);
    expect(relay.commandForEvent("post_tool_use")).toBe(
      `${NATIVE_HOOK_RELAY_EXEC_PREFIX}/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id ` +
        `${relay.relayId} ${nativeHookRelayStateDbArgForTests()} --generation ${relay.generation} --event post_tool_use --timeout 1234`,
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
      `${NATIVE_HOOK_RELAY_EXEC_PREFIX}/usr/local/bin/node '/opt/Open Claw/openclaw.mjs' hooks relay --provider codex --relay-id ` +
        `${relay.relayId} ${nativeHookRelayStateDbArgForTests()} --generation ${relay.generation} --event before_agent_finalize --timeout 1234`,
    );
  });

  it("allows callers to replace a relay at a stable id", async () => {
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
        testing.getNativeHookRelayRegistrationForTests(first.relayId),
        "native hook relay registration",
      ),
      {
        runId: "run-2",
        allowedEvents: ["post_tool_use"],
      },
    );
    const secondExpiresAtMs = requireRecord(
      testing.getNativeHookRelayRegistrationForTests(first.relayId),
      "replacement native hook relay registration",
    ).expiresAtMs;

    first.renew(60_000);
    expect(
      requireRecord(
        testing.getNativeHookRelayRegistrationForTests(first.relayId),
        "replacement native hook relay registration",
      ).expiresAtMs,
    ).toBe(secondExpiresAtMs);

    first.unregister();
    expectRecordFields(
      requireRecord(
        testing.getNativeHookRelayRegistrationForTests(first.relayId),
        "replacement native hook relay registration",
      ),
      {
        runId: "run-2",
        allowedEvents: ["post_tool_use"],
      },
    );
    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId: second.relayId,
        generation: second.generation,
        event: "post_tool_use",
        timeoutMs: 2_000,
        rawPayload: {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_use_id: "replacement-call",
          tool_input: { command: "pnpm test" },
          tool_response: { output: "ok", exit_code: 0 },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });

    second.unregister();
    expect(testing.getNativeHookRelayRegistrationForTests(first.relayId)).toBeUndefined();
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
      generation: relay.generation,
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

  it("rejects stale direct bridge requests after stable relay id replacement", async () => {
    const first = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-stale-bridge-request",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });
    const firstRecord = await waitForNativeHookRelayBridgeRecord(first.relayId);
    const staleRequest = openDeferredNativeHookRelayBridgeRequest(firstRecord, {
      provider: "codex",
      relayId: first.relayId,
      generation: first.generation,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
      },
    });
    await staleRequest.connected;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const second = registerNativeHookRelay({
      provider: "codex",
      relayId: first.relayId,
      sessionId: "session-1",
      runId: "run-2",
      allowedEvents: ["pre_tool_use"],
    });
    staleRequest.sendBody();

    await expect(staleRequest.response).resolves.toMatchObject({
      ok: false,
      error: "native hook relay bridge stale registration",
    });
    expect(testing.getNativeHookRelayInvocationsForTests()).toStrictEqual([]);

    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId: second.relayId,
        generation: second.generation,
        event: "pre_tool_use",
        timeoutMs: 2_000,
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("rejects late stale direct bridge commands after stable relay id replacement", async () => {
    const first = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-late-stale-bridge-command",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });
    const firstCommand = first.commandForEvent("pre_tool_use");
    expect(firstCommand).toContain("--generation");
    expect(firstCommand).toContain(first.generation);
    await waitForNativeHookRelayBridgeRecord(first.relayId);

    const second = registerNativeHookRelay({
      provider: "codex",
      relayId: first.relayId,
      sessionId: "session-1",
      runId: "run-2",
      allowedEvents: ["pre_tool_use"],
    });

    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId: first.relayId,
        generation: first.generation,
        event: "pre_tool_use",
        timeoutMs: 2_000,
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).rejects.toThrow("native hook relay bridge stale registration");
    expect(testing.getNativeHookRelayInvocationsForTests()).toStrictEqual([]);

    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId: second.relayId,
        generation: second.generation,
        event: "pre_tool_use",
        timeoutMs: 2_000,
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(getOnlyNativeHookRelayInvocation()).toMatchObject({
      relayId: second.relayId,
      runId: "run-2",
      event: "pre_tool_use",
    });
  });

  it("treats stale direct bridge records as retryable during lookup", () => {
    expect(
      testing.isNativeHookRelayBridgeLookupRetryableForTests(
        new Error("native hook relay bridge stale registration"),
      ),
    ).toBe(true);
    expect(
      testing.isNativeHookRelayBridgeLookupRetryableForTests(
        new Error("native hook relay bridge stale registration"),
        300,
      ),
    ).toBe(false);
  });

  it("accepts bootstrap generation mismatches during a bounded grace window", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-bootstrap-stale-generation",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
      generationMismatchGraceMs: 60_000,
    });

    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId: relay.relayId,
        generation: "stale-generation-from-resumed-thread",
        event: "pre_tool_use",
        timeoutMs: 2_000,
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(getOnlyNativeHookRelayInvocation()).toMatchObject({
      relayId: relay.relayId,
      runId: "run-1",
      event: "pre_tool_use",
    });

    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId: relay.relayId,
        generation: "different-stale-generation",
        event: "pre_tool_use",
        timeoutMs: 2_000,
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).rejects.toThrow("native hook relay bridge stale registration");
  });

  it("rejects bootstrap generation mismatches after the grace window", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-expired-bootstrap-stale-generation",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
      generationMismatchGraceMs: 1,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId: relay.relayId,
        generation: "stale-generation-from-resumed-thread",
        event: "pre_tool_use",
        timeoutMs: 2_000,
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).rejects.toThrow("native hook relay bridge stale registration");
    expect(testing.getNativeHookRelayInvocationsForTests()).toStrictEqual([]);
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

    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    relay.renew(20_000);

    const after = await waitForNativeHookRelayBridgeRecord(relay.relayId);
    expect(after.port).toBe(before.port);
    expect(after.token).toBe(before.token);
    expect(after.expiresAtMs).toBeGreaterThan(before.expiresAtMs as number);

    const response = await invokeNativeHookRelayBridge({
      provider: "codex",
      relayId: relay.relayId,
      generation: relay.generation,
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

  it("restores a missing direct bridge record during renewal", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-restored-bridge-session",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
      ttlMs: 10_000,
    });
    const before = await waitForNativeHookRelayBridgeRecord(relay.relayId);
    expect(
      deleteNativeHookRelayBridgeRecordIfOwned({
        ...before,
        stateDbPath: resolveOpenClawStateSqlitePath(),
      }),
    ).toBe(true);
    expect(testing.getNativeHookRelayBridgeRecordForTests(relay.relayId)).toBeUndefined();

    relay.renew(20_000);

    const after = await waitForNativeHookRelayBridgeRecord(relay.relayId);
    expect(after.port).toBe(before.port);
    expect(after.token).toBe(before.token);
    expect(after.expiresAtMs).toBeGreaterThan(before.expiresAtMs);
  });

  it("prunes dead foreign direct bridge records during registration", async () => {
    const staleRelayId = await writeForeignNativeHookRelayBridgeRecordForTests(
      uniqueNativeHookRelayIdForTests("codex-dead-foreign-bridge"),
      {
        pid: 9_999_991,
        expiresAtMs: Date.now() + 60_000,
      },
    );
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 9_999_991) {
        throw Object.assign(new Error("missing process"), { code: "ESRCH" });
      }
      return true;
    });

    registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-prune-dead-foreign-bridge-session",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });

    expect(kill).toHaveBeenCalledWith(9_999_991, 0);
    expect(testing.getNativeHookRelayBridgeRecordForTests(staleRelayId)).toBeUndefined();
  });

  it("prunes expired foreign direct bridge records even when their pid is alive", async () => {
    const unrelatedLiveRelayId = await writeForeignNativeHookRelayBridgeRecordForTests(
      uniqueNativeHookRelayIdForTests("codex-unrelated-live-foreign-bridge"),
      {
        pid: 9_999_994,
        expiresAtMs: Date.now() + 60_000,
      },
    );
    const staleRelayId = await writeForeignNativeHookRelayBridgeRecordForTests(
      uniqueNativeHookRelayIdForTests("codex-expired-foreign-bridge"),
      {
        pid: 9_999_992,
        expiresAtMs: Date.now() - 1,
      },
    );
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid !== 9_999_992 && pid !== 9_999_994) {
        throw Object.assign(new Error("unexpected process"), { code: "ESRCH" });
      }
      return true;
    });

    registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-prune-expired-foreign-bridge-session",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });

    expect(kill).toHaveBeenCalledWith(9_999_994, 0);
    expect(kill).not.toHaveBeenCalledWith(9_999_992, 0);
    expect(testing.getNativeHookRelayBridgeRecordForTests(staleRelayId)).toBeUndefined();
    expect(testing.getNativeHookRelayBridgeRecordForTests(unrelatedLiveRelayId)).toBeDefined();
  });

  it("preserves live unexpired foreign direct bridge records during registration", async () => {
    const liveRelayId = await writeForeignNativeHookRelayBridgeRecordForTests(
      uniqueNativeHookRelayIdForTests("codex-live-foreign-bridge"),
      {
        pid: 9_999_993,
        expiresAtMs: Date.now() + 60_000,
      },
    );
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid !== 9_999_993) {
        throw Object.assign(new Error("unexpected process"), { code: "ESRCH" });
      }
      return true;
    });

    registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-preserve-live-foreign-bridge-session",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });

    expect(kill).toHaveBeenCalledWith(9_999_993, 0);
    expect(testing.getNativeHookRelayBridgeRecordForTests(liveRelayId)).toBeDefined();
  });

  it("preserves foreign direct bridge records when liveness is unknown", async () => {
    const liveRelayId = await writeForeignNativeHookRelayBridgeRecordForTests(
      uniqueNativeHookRelayIdForTests("codex-unknown-liveness-foreign-bridge"),
      {
        pid: 9_999_994,
        expiresAtMs: Date.now() + 60_000,
      },
    );
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 9_999_994) {
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      }
      return true;
    });

    registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-preserve-unknown-liveness-foreign-bridge-session",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });

    expect(kill).toHaveBeenCalledWith(9_999_994, 0);
    expect(testing.getNativeHookRelayBridgeRecordForTests(liveRelayId)).toBeDefined();
  });

  it("treats direct bridge records with a dead owning pid as absent", async () => {
    const relayId = await writeForeignNativeHookRelayBridgeRecordForTests(
      uniqueNativeHookRelayIdForTests("codex-dead-pid-bridge"),
      {
        pid: 9_999_996,
        expiresAtMs: Date.now() + 60_000,
      },
    );
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 9_999_996) {
        throw Object.assign(new Error("missing process"), { code: "ESRCH" });
      }
      return true;
    });

    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId,
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
    expect(kill).toHaveBeenCalledWith(9_999_996, 0);
  });

  it("accepts only loopback direct bridge records", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-private-bridge-session",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["pre_tool_use"],
    });

    const record = await waitForNativeHookRelayBridgeRecord(relay.relayId);
    writeNativeHookRelayBridgeRecord({
      // Simulate a hostile/corrupt database row outside the typed store contract.
      record: {
        ...record,
        hostname: "192.0.2.1",
        expiresAtMs: Date.now() + 10_000,
      } as unknown as NativeHookRelayBridgeRecord,
    });

    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId: relay.relayId,
        generation: relay.generation,
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
    writeNativeHookRelayBridgeRecord({
      record: {
        ...firstRecord,
        relayId: second.relayId,
        expiresAtMs: Date.now() + 10_000,
      },
    });

    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId: second.relayId,
        generation: second.generation,
        event: "pre_tool_use",
        timeoutMs: 500,
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).rejects.toThrow("native hook relay bridge target mismatch");
    expect(testing.getNativeHookRelayInvocationsForTests()).toStrictEqual([]);
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
      writeNativeHookRelayBridgeRecord({
        record: {
          ...record,
          port: address.port,
          token: "test-token",
          expiresAtMs: Date.now() + 10_000,
        },
      });

      await expect(
        invokeNativeHookRelayBridge({
          provider: "codex",
          relayId: relay.relayId,
          generation: relay.generation,
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

    const [recorded] = testing.getNativeHookRelayInvocationsForTests();
    expect(JSON.stringify(recorded?.rawPayload).length).toBeLessThan(25_000);
    const rawPayload = readRecordField(
      requireRecord(recorded, "native hook relay invocation"),
      "rawPayload",
      "invocation raw payload",
    );
    expect(String(rawPayload.tool_response)).toContain("[truncated]");
  });

  it("retains payload snapshots without splitting surrogate pairs", async () => {
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
        tool_response: `${"a".repeat(3_999)}😀tail`,
      },
    });

    const [recorded] = testing.getNativeHookRelayInvocationsForTests();
    const rawPayload = readRecordField(
      requireRecord(recorded, "native hook relay invocation"),
      "rawPayload",
      "invocation raw payload",
    );
    expect(rawPayload.tool_response).toBe(`${"a".repeat(3_999)}...[truncated]`);
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

    expect(testing.getNativeHookRelayInvocationsForTests()).toHaveLength(1);

    relay.unregister();

    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeUndefined();
    expect(testing.getNativeHookRelayInvocationsForTests()).toStrictEqual([]);
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

    const invocations = testing.getNativeHookRelayInvocationsForTests();
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
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      ttlMs: 5_000,
    });
    await waitForNativeHookRelayBridgeRecord(relay.relayId);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(relay.expiresAtMs + 1));

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {},
      }),
    ).rejects.toThrow("expired");
    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeUndefined();
    expect(testing.getNativeHookRelayBridgeRecordForTests(relay.relayId)).toBeUndefined();
    relay.unregister();
    expect(testing.getNativeHookRelayBridgeRecordForTests(relay.relayId)).toBeUndefined();
  });

  it("rearms relay expiry beyond the maximum timer chunk and physically releases at deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T00:00:00.000Z"));
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-timer-chunk",
      ttlMs: MAX_TIMER_TIMEOUT_MS + 10,
    });

    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeDefined();
    await vi.advanceTimersByTimeAsync(11);
    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeUndefined();
  });

  it("replaces the expiry timer when a relay renews", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T00:00:00.000Z"));
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-timer-renew",
      ttlMs: 100,
    });
    relay.renew(200);

    await vi.advanceTimersByTimeAsync(101);
    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeDefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeUndefined();
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
      requester: {
        channel: "telegram",
        accountId: "operations",
        senderId: "maintainer-user",
        senderIsOwner: false,
        roleIds: ["maintainer-role"],
      },
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
      requester: {
        channel: "telegram",
        accountId: "operations",
        senderId: "maintainer-user",
        senderIsOwner: false,
        roleIds: ["maintainer-role"],
      },
      toolName: "exec",
      toolCallId: "native-call-1",
    });
  });

  it("keeps a native pre-tool hook timeout distinct from a policy denial", async () => {
    const onPreToolUseFailure = vi.fn();
    const beforeToolCall = vi.fn(async () => {
      throw Object.assign(new Error("timed out after 5000ms"), { name: "TimeoutError" });
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-1",
      onPreToolUseFailure,
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        cwd: "/repo",
        tool_name: "exec_command",
        tool_use_id: "native-timeout-1",
        tool_input: { cmd: "pnpm test" },
      },
    });

    expect(response.failureDisposition).toBe("timed_out");
    expect(JSON.parse(response.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(onPreToolUseFailure).toHaveBeenCalledWith({
      toolName: "exec",
      toolCallId: "native-timeout-1",
      disposition: "timed_out",
      durationMs: expect.any(Number),
    });

    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        tool_name: "exec_command",
        tool_use_id: "native-timeout-1",
        tool_input: { cmd: "pnpm test" },
      },
    });
    expect(onPreToolUseFailure).toHaveBeenCalledTimes(1);
  });

  it("isolates an asynchronously rejected native failure projection", async () => {
    const onPreToolUseFailure = vi.fn(async () => {
      throw new Error("diagnostic sink unavailable");
    });
    const beforeToolCall = vi.fn(async () => {
      throw new Error("hook crashed");
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      onPreToolUseFailure,
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "exec_command",
          tool_use_id: "native-failed-projection",
          tool_input: { cmd: "pnpm test" },
        },
      }),
    ).resolves.toMatchObject({ failureDisposition: "failed" });
    expect(onPreToolUseFailure).toHaveBeenCalledTimes(1);
  });

  it("does not delay a native hook response on a pending failure projection", async () => {
    const onPreToolUseFailure = vi.fn(
      () =>
        new Promise<void>(() => {
          // Deliberately remain pending to prove projection does not block the response.
        }),
    );
    const beforeToolCall = vi.fn(async () => {
      throw new Error("hook crashed");
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      onPreToolUseFailure,
    });
    const invoke = () =>
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "exec_command",
          tool_use_id: "native-pending-projection",
          tool_input: { cmd: "pnpm test" },
        },
      });

    await expect(invoke()).resolves.toMatchObject({ failureDisposition: "failed" });
    await expect(invoke()).resolves.toMatchObject({ failureDisposition: "failed" });
    expect(onPreToolUseFailure).toHaveBeenCalledTimes(1);
  });

  it("leaves report-mode pre-tool failure projection to the approval owner", async () => {
    const onPreToolUseFailure = vi.fn();
    const beforeToolCall = vi.fn(async () => {
      throw Object.assign(new Error("timed out after 5000ms"), { name: "TimeoutError" });
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-1",
      onPreToolUseFailure,
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        openclaw_approval_mode: "report",
        tool_name: "exec_command",
        tool_use_id: "native-report-timeout",
        tool_input: { cmd: "pnpm test" },
      },
    });

    expect(response.failureDisposition).toBe("timed_out");
    expect(onPreToolUseFailure).not.toHaveBeenCalled();
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

  it.each(["Bash", "exec", "exec_command"] as const)(
    "executes a canonical exec policy for Codex %s hook payloads",
    async (nativeToolName) => {
      const beforeToolCall = vi.fn(() => ({
        block: true,
        blockReason: "shell command blocked",
      }));
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          { hookName: "before_tool_call", handler: beforeToolCall, matcher: ["exec"] },
        ]),
      );
      const relay = registerNativeHookRelay({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        preToolUseLoopDetection: false,
      });

      const response = await invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: nativeToolName,
          tool_use_id: `native-${nativeToolName}-1`,
          tool_input: { command: "rm -rf dist" },
        },
      });

      expect(JSON.parse(response.stdout)).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "shell command blocked",
        },
      });
      expect(beforeToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "exec" }),
        expect.objectContaining({ toolName: "exec" }),
      );
    },
  );

  it.each([
    { canonicalToolName: "apply_patch", nativeToolName: "apply_patch" },
    { canonicalToolName: "apply_patch", nativeToolName: "Write" },
    { canonicalToolName: "apply_patch", nativeToolName: "Edit" },
    { canonicalToolName: "spawn_agent", nativeToolName: "spawn_agent" },
    { canonicalToolName: "spawn_agent", nativeToolName: "Agent" },
  ] as const)(
    "executes canonical $canonicalToolName policy for Codex $nativeToolName hook payloads",
    async ({ canonicalToolName, nativeToolName }) => {
      const beforeToolCall = vi.fn(() => ({
        block: true,
        blockReason: "tool blocked",
      }));
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          { hookName: "before_tool_call", handler: beforeToolCall, matcher: [canonicalToolName] },
        ]),
      );
      const relay = registerNativeHookRelay({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        preToolUseLoopDetection: false,
      });

      const response = await invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: nativeToolName,
          tool_use_id: `native-${canonicalToolName}-1`,
          tool_input:
            canonicalToolName === "spawn_agent"
              ? { message: "inspect this repo" }
              : { patch: "*** Begin Patch" },
        },
      });

      expect(JSON.parse(response.stdout)).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "tool blocked",
        },
      });
      expect(beforeToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: canonicalToolName }),
        expect.objectContaining({ toolName: canonicalToolName }),
      );
    },
  );

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

  it("defers synthetic app-server PreToolUse approval requirements to the app-server approval", async () => {
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

    expect(response).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(beforeToolCall).toHaveBeenCalledTimes(1);
  });

  it("shares in-flight deferred PreToolUse approvals for duplicate app-server requests", async () => {
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

    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        openclaw_approval_mode: "report",
        cwd: "/repo",
        tool_name: "exec_command",
        tool_use_id: "native-approval-report-duplicate",
        tool_input: { cmd: "cat /tmp/private_key" },
      },
    });

    let resolveApproval:
      | ((value: { blocked: false; params: unknown; approvalResolution: "allow-once" }) => void)
      | undefined;
    const approvalRequester = vi.fn(
      () =>
        new Promise<{ blocked: false; params: unknown; approvalResolution: "allow-once" }>(
          (resolve) => {
            resolveApproval = resolve;
          },
        ),
    );
    testing.setNativeHookRelayDeferredToolApprovalRequesterForTests(approvalRequester);

    const firstApproval = resolveNativeHookRelayDeferredToolApproval({
      relayId: relay.relayId,
      toolUseId: "native-approval-report-duplicate",
    });
    const duplicateApproval = resolveNativeHookRelayDeferredToolApproval({
      relayId: relay.relayId,
      toolUseId: "native-approval-report-duplicate",
    });

    await vi.waitFor(() => expect(approvalRequester).toHaveBeenCalledTimes(1));
    resolveApproval?.({
      blocked: false,
      params: { cmd: "cat /tmp/private_key", command: "cat /tmp/private_key" },
      approvalResolution: "allow-once",
    });

    await expect(Promise.all([firstApproval, duplicateApproval])).resolves.toEqual([
      { handled: true, outcome: "approved-once" },
      { handled: true, outcome: "approved-once" },
    ]);
    await expect(
      resolveNativeHookRelayDeferredToolApproval({
        relayId: relay.relayId,
        toolUseId: "native-approval-report-duplicate",
      }),
    ).resolves.toBeUndefined();
  });

  it("preserves deferred native approval cancellation as a terminal disposition", async () => {
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
      runId: "run-1",
    });

    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        openclaw_approval_mode: "report",
        cwd: "/repo",
        tool_name: "exec_command",
        tool_use_id: "native-approval-cancelled",
        tool_input: { cmd: "pnpm test" },
      },
    });
    testing.setNativeHookRelayDeferredToolApprovalRequesterForTests(async () => ({
      blocked: true,
      kind: "failure",
      disposition: "cancelled",
      deniedReason: "plugin-approval",
      reason: "Approval cancelled because the run stopped",
    }));

    await expect(
      resolveNativeHookRelayDeferredToolApproval({
        relayId: relay.relayId,
        toolUseId: "native-approval-cancelled",
      }),
    ).resolves.toEqual({
      handled: true,
      outcome: "denied",
      reason: "Approval cancelled because the run stopped",
      failureDisposition: "cancelled",
    });
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
          evaluate(eventValue, ctx) {
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
      await replaceSessionEntry({ sessionKey: "agent:main:session-1", storePath }, {
        sessionId: "session-1",
        updatedAt: Date.now(),
      } as SessionEntry);
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
        preToolUseLoopDetection: false,
      });

      expect(relay.shouldRelayEvent("pre_tool_use")).toBe(true);

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
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

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
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

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
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    const first = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-1",
        tool_input: { command: "git status" },
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
        tool_input: { command: "git status" },
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
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

    await invokeNativeHookRelay({
      provider: "codex",
      relayId: first.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        cwd: "/repo",
        tool_name: "Bash",
        tool_use_id: "native-call-1",
        tool_input: { command: "git status" },
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
        tool_input: { command: "git status" },
      },
    });

    expect(approvalRequester).toHaveBeenCalledTimes(2);
    const request = getMockCallArg(approvalRequester, 1, 0, "second approval request");
    expectRecordFields(request, {
      agentId: "agent-1",
      sessionId: "session-2",
      sessionKey: "agent:main:session-2",
      toolInput: { command: "git status" },
    });
  });

  it("keeps allow-always PermissionRequest reuse scoped to matching cwd and input", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });
    const approvalRequester = vi.fn(async () => "allow-always" as const);
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

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
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(
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
          tool_input: { command: "git status" },
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
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

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

    await vi.waitFor(() => expect(approvalRequester).toHaveBeenCalledTimes(1));
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

  it("keeps replacement pending PermissionRequest approvals when stale approvals settle", async () => {
    const relayId = "codex-stale-pending-permission";
    const firstRelay = registerNativeHookRelay({
      provider: "codex",
      relayId,
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
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);
    const payload = {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_use_id: "native-call-1",
      tool_input: { command: "git push" },
    };

    const firstApproval = invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "permission_request",
      rawPayload: payload,
    });
    await vi.waitFor(() => expect(approvalRequester).toHaveBeenCalledTimes(1));
    expect(getNativeHookRelaySharedStateForTests().pendingPermissionApprovals.size).toBe(1);

    firstRelay.unregister();
    registerNativeHookRelay({
      provider: "codex",
      relayId,
      sessionId: "session-1",
      runId: "run-1",
    });
    const secondApproval = invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "permission_request",
      rawPayload: payload,
    });
    await vi.waitFor(() => expect(approvalRequester).toHaveBeenCalledTimes(2));
    expect(getNativeHookRelaySharedStateForTests().pendingPermissionApprovals.size).toBe(1);

    resolvers[0]?.("allow");
    await expect(firstApproval).rejects.toThrow("registration is inactive");
    expect(getNativeHookRelaySharedStateForTests().pendingPermissionApprovals.size).toBe(1);

    const duplicateSecondApproval = invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "permission_request",
      rawPayload: payload,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await vi.waitFor(() => expect(approvalRequester).toHaveBeenCalledTimes(2));

    resolvers[1]?.("allow");
    await expect(Promise.all([secondApproval, duplicateSecondApproval])).resolves.toHaveLength(2);
    expect(getNativeHookRelaySharedStateForTests().pendingPermissionApprovals.size).toBe(0);
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
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

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

    await vi.waitFor(() => expect(approvalRequester).toHaveBeenCalledTimes(2));
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
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

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
    testing.setNativeHookRelayPermissionApprovalRequesterForTests(approvalRequester);

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
    await vi.waitFor(() => expect(approvalRequester).toHaveBeenCalledTimes(1));

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
    await vi.waitFor(() => expect(approvalRequester).toHaveBeenCalledTimes(2));

    for (const resolve of resolvers) {
      resolve("allow");
    }
    await expect(Promise.all([...duplicateRequests, newRequest])).resolves.toHaveLength(13);
  });

  it("uses canonical PermissionRequest content fingerprints for ordinary objects", () => {
    const first = testing.permissionRequestContentFingerprintForTests({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      toolName: "exec",
      toolInput: { a: 1, b: { x: 2, y: 3 } },
    });
    const second = testing.permissionRequestContentFingerprintForTests({
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
      testing.permissionRequestContentFingerprintForTests({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        toolName: "exec",
        toolInput: firstToolInput,
      }),
    ).not.toBe(
      testing.permissionRequestContentFingerprintForTests({
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
      expect(testing.permissionRequestToolInputKeyFingerprintForTests(toolInput)).toContain("key-");
      expect(
        testing.permissionRequestContentFingerprintForTests({
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
      testing.formatPermissionApprovalDescriptionForTests({
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
      testing.formatPermissionApprovalDescriptionForTests({
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

  it("strips ESC and C1 CSI equivalently across PermissionRequest preview fields", () => {
    const formatPreview = (csi: string) =>
      testing.formatPermissionApprovalDescriptionForTests({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        toolName: `ex${csi}ec`,
        cwd: `/repo${csi}/red`,
        model: `gpt-${csi}5.4`,
        toolInput: {
          command: `printf${csi} 'ok'`,
        },
      });
    const formatKeyPreview = (csi: string) =>
      testing.formatPermissionApprovalDescriptionForTests({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        toolName: "exec",
        toolInput: {
          [`key${csi}-0`]: 0,
        },
      });
    const escCsi = "\u001b[@";
    const c1Csi = "\u009b@";

    expect(formatPreview(c1Csi)).toBe(formatPreview(escCsi));
    expect(formatPreview(c1Csi)).toBe(
      "Tool: exec\nCwd: /repo/red\nModel: gpt-5.4\nCommand: printf 'ok'",
    );
    expect(formatKeyPreview(c1Csi)).toBe(formatKeyPreview(escCsi));
    expect(formatKeyPreview(c1Csi)).toBe("Tool: exec\nInput keys: key-0");
  });

  it("truncates PermissionRequest approval previews without splitting surrogate pairs", () => {
    expect(
      testing.formatPermissionApprovalDescriptionForTests({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        toolName: "exec",
        toolInput: {
          command: `${"a".repeat(236)}😀tail`,
        },
      }),
    ).toBe(`Tool: exec\nCommand: ${"a".repeat(236)}...`);
  });
});

describe("native hook relay command builder", () => {
  it("uses the Codex hook relay command shape", () => {
    expect(
      buildNativeHookRelayCommand({
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "permission_request",
        executable: "openclaw",
      }),
    ).toBe(
      `${NATIVE_HOOK_RELAY_EXEC_PREFIX}openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event permission_request --timeout 5000`,
    );
  });

  it("execs niced relays so the Codex timeout owns the relay process", () => {
    const command = buildNativeHookRelayCommand({
      provider: "codex",
      relayId: "relay-1",
      event: "post_tool_use",
      executable: "openclaw",
      nice: 10,
    });

    expect(command).toBe(
      process.platform === "win32"
        ? "openclaw hooks relay --provider codex --relay-id relay-1 --event post_tool_use --timeout 5000"
        : "exec nice -n 10 openclaw hooks relay --provider codex --relay-id relay-1 --event post_tool_use --timeout 5000",
    );
  });

  it("includes explicit unavailable noop mode only for PreToolUse", () => {
    expect(
      buildNativeHookRelayCommand({
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        preToolUseUnavailable: "noop",
        executable: "openclaw",
      }),
    ).toBe(
      `${NATIVE_HOOK_RELAY_EXEC_PREFIX}openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event pre_tool_use --pre-tool-use-unavailable noop --timeout 5000`,
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
