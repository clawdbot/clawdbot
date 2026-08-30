import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import {
  closeAdmittedRunDelegatedAuthority,
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { runAgentToolSourceExecutionGuard } from "../agent-tool-source-execution-guard.js";
import {
  rewrapToolWithBeforeToolCallHook,
  runBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
  type InternalToolExecutionPreparer,
} from "../runtime/internal-hooks.js";
import type { AnyAgentTool } from "../tools/common.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { callGatewayTool } from "../tools/gateway.js";
import { getInProcessGatewayToolContext } from "../tools/in-process-gateway.js";
import {
  createAgentHarnessHostCapabilities,
  retainBeforeToolCallForNativeHookRelay,
} from "./host-capability.js";

const agentToolsMocks = vi.hoisted(() => ({
  createOpenClawCodingTools: vi.fn(() => []),
}));

vi.mock("../agent-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-tools.js")>()),
  createOpenClawCodingTools: agentToolsMocks.createOpenClawCodingTools,
}));
vi.mock("../agent-tools.before-tool-call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-tools.before-tool-call.js")>()),
  rewrapToolWithBeforeToolCallHook: vi.fn((tool) => tool),
  runBeforeToolCallHook: vi.fn(async ({ params }) => ({ blocked: false, params })),
}));
vi.mock("../tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

const mockRewrap = vi.mocked(rewrapToolWithBeforeToolCallHook);
const mockRunBefore = vi.mocked(runBeforeToolCallHook);
const mockCallGatewayTool = vi.mocked(callGatewayTool);
type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];

const admissions: PreparedAgentRunAdmission[] = [];

async function admittedAttempt(
  runId = "run-1",
  overrides: Omit<Partial<HostAttempt>, "admittedRunContext" | "runId"> = {},
): Promise<{ attempt: HostAttempt; admission: PreparedAgentRunAdmission }> {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "host-capability-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  admissions.push(admission);
  const admittedRunContext = await admission.admit("plugin-harness", `harness-${runId}`);
  return {
    admission,
    attempt: {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId,
      cwd: "/attempt/worktree",
      workspaceDir: "/workspace",
      currentChannelId: "chat-1",
      messageChannel: "telegram",
      ...overrides,
      admittedRunContext,
    },
  };
}

function testTool(execute = vi.fn(async () => ({ content: [], details: {} }))): {
  tool: AnyAgentTool;
  execute: typeof execute;
} {
  return {
    execute,
    tool: {
      name: "read",
      label: "Read",
      description: "read",
      parameters: Type.Object({}),
      execute,
    },
  };
}

function bindTool(
  attempt: HostAttempt,
  tool: AnyAgentTool,
): {
  host: ReturnType<typeof createAgentHarnessHostCapabilities>;
  bound: AnyAgentTool;
} {
  const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
  const [bound] = host.capabilities.bindToolSurface([tool]);
  if (!bound) {
    throw new Error("expected bound tool");
  }
  return { host, bound };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  resetAgentRunRegistryForTest();
});

describe("agent harness host capability", () => {
  beforeEach(() => {
    agentToolsMocks.createOpenClawCodingTools.mockClear();
    mockRewrap.mockClear();
    mockRunBefore.mockClear();
    mockCallGatewayTool.mockReset();
  });

  it("binds Full node invocation to the exact live admission, session and placement", async () => {
    const previousRegistry = getActivePluginRegistry();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-full-node-"));
    const sessionTarget = {
      agentId: "main",
      sessionKey: "agent:main:session-1",
      sessionId: "session-1",
      storePath: path.join(root, "sessions.json"),
    };
    try {
      for (const change of [
        "none",
        "ordinary",
        "close",
        "admission",
        "restart",
        "permission",
        "session",
        "placement",
        "gateway",
        "plugin",
        "plugin-reload",
      ] as const) {
        await upsertSessionEntryCore(sessionTarget, {
          sessionId: "session-1",
          updatedAt: Date.now(),
          permissionMode: "full",
        });
        const { attempt, admission } = await admittedAttempt(`run-${change}`, {
          permissionMode: change === "ordinary" ? "workspace" : "full",
          sessionTarget,
        });
        let placementActive = true;
        const registry = createEmptyPluginRegistry();
        registry.plugins.push(
          createPluginRecord({
            id: "fixture",
            source: "fixture",
            origin: "bundled",
            enabled: true,
            configSchema: true,
          }),
        );
        setActivePluginRegistry(registry);
        const context = {} as GatewayRequestContext;
        const assertPlacementCurrent = vi.fn(() => {
          if (!placementActive) {
            throw new Error("placement no longer current");
          }
        });
        let currentContext = context;
        bindGatewayContextResolver(attempt.admittedRunContext, () => currentContext);
        const host = createAgentHarnessHostCapabilities({
          attempt,
          pluginId: "fixture",
          requiredNodeCommands: ["fixture.exec"],
        });
        const dispatched = vi.fn(async () => "launched");
        await withPluginRuntimeGatewayRequestScope(
          { isWebchatConnect: () => false, assertNodeExecutionCurrent: assertPlacementCurrent },
          () =>
            host.runWithScope(async () => {
              const invoke = getPluginRuntimeGatewayRequestScope()?.invokeWithSessionNodeAuthority;
              expect(invoke).toBeTypeOf("function");
              const ready = createDeferred();
              const release = createDeferred();
              const result = invoke!(
                {
                  source: "session-full",
                  command: "fixture.exec",
                  pluginId: change === "plugin" ? "other" : "fixture",
                  nodeId: "node-1",
                  workspace: {
                    workspaceDir: "/node/workspace",
                    sessionKey: sessionTarget.sessionKey,
                    sessionId: "session-1",
                    environmentId: "environment-1",
                    ownerEpoch: 2,
                  },
                },
                async (assertCurrent) => {
                  ready.resolve();
                  await release.promise;
                  assertCurrent();
                  return await dispatched();
                },
              );
              void result.catch(() => {});
              if (change === "ordinary") {
                await expect(result).resolves.toBeUndefined();
                expect(dispatched).not.toHaveBeenCalled();
                return;
              }
              if (change === "plugin") {
                await expect(result).rejects.toThrow("no longer current");
                expect(dispatched).not.toHaveBeenCalled();
                return;
              }
              await ready.promise;
              switch (change) {
                case "close":
                  host.close();
                  break;
                case "admission":
                  admission.close();
                  break;
                case "restart":
                  rotateAgentRunRegistryLifecycleGeneration();
                  break;
                case "permission":
                  await upsertSessionEntryCore(sessionTarget, { permissionMode: "workspace" });
                  break;
                case "session":
                  await upsertSessionEntryCore(sessionTarget, { sessionId: "replacement" });
                  break;
                case "placement":
                  placementActive = false;
                  break;
                case "gateway":
                  currentContext = {} as GatewayRequestContext;
                  break;
                case "plugin-reload":
                  setActivePluginRegistry(createEmptyPluginRegistry());
                  break;
                case "none":
                  break;
              }
              release.resolve();
              if (change === "none") {
                await expect(result).resolves.toBe("launched");
                expect(dispatched).toHaveBeenCalledOnce();
              } else {
                await expect(result).rejects.toThrow(/no longer (active|current)/);
                expect(dispatched).not.toHaveBeenCalled();
              }
            }),
        );
        host.close();
        admission.close();
      }
    } finally {
      if (previousRegistry) {
        setActivePluginRegistry(previousRegistry);
      } else {
        resetPluginRuntimeStateForTest();
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("overwrites plugin policy fields with the host snapshot and revokes lexically", async () => {
    const { attempt, admission } = await admittedAttempt();
    const authority = getAdmittedRunDelegatedAuthority(attempt.admittedRunContext);
    const { tool, execute } = testTool();
    const { host, bound } = bindTool(attempt, tool);
    expect(mockRewrap).toHaveBeenCalledWith(
      tool,
      expect.objectContaining({
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:session-1",
        channelId: "chat-1",
      }),
    );

    const forgedRequest = {
      toolName: "exec",
      params: { command: "true" },
      approvalMode: "deny" as const,
      ctx: { agentId: "forged" },
    };
    // Plain-JavaScript plugins can still supply removed policy fields at runtime.
    await host.capabilities.runBeforeToolCall(
      forgedRequest as unknown as Parameters<typeof host.capabilities.runBeforeToolCall>[0],
    );
    expect(mockRunBefore).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalMode: "request",
        ctx: expect.objectContaining({ agentId: "main", runId: "run-1" }),
      }),
    );

    await host.capabilities.runBeforeToolCall({
      toolName: "exec",
      params: { command: "true" },
      approvalMode: "defer",
    });
    expect(mockRunBefore).toHaveBeenLastCalledWith(
      expect.objectContaining({ approvalMode: "defer" }),
    );
    expect(() => host.capabilities.assertActive()).not.toThrow();

    host.close();
    expect(getAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(authority);
    expect(() => host.capabilities.bindToolSurface([tool])).toThrow("no longer active");
    expect(() => host.capabilities.createToolSurface?.({} as never)).toThrow("no longer active");
    expect(() => host.capabilities.assertActive()).toThrow("no longer active");
    await expect(bound.execute("call-1", {})).rejects.toThrow("no longer active");
    expect(execute).not.toHaveBeenCalled();

    admission.close();
    expect(getAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBeUndefined();
  });

  it("forces host-required source delivery deferral into a created tool surface", async () => {
    const deferred = await admittedAttempt("run-deferred-tools", {
      deferSourceMessageToolDelivery: true,
    });
    const deferredHost = createAgentHarnessHostCapabilities({
      attempt: deferred.attempt,
      pluginId: "codex",
    });
    deferredHost.capabilities.createToolSurface?.({
      deferSourceMessageToolDelivery: false,
    } as never);

    expect(agentToolsMocks.createOpenClawCodingTools).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deferSourceMessageToolDelivery: true,
        operationalRunInstance: deferred.attempt.admittedRunContext.operationalRunInstance,
      }),
    );

    const ordinary = await admittedAttempt("run-ordinary-tools");
    const ordinaryHost = createAgentHarnessHostCapabilities({
      attempt: ordinary.attempt,
      pluginId: "codex",
    });
    ordinaryHost.capabilities.createToolSurface?.({
      deferSourceMessageToolDelivery: false,
    } as never);

    expect(agentToolsMocks.createOpenClawCodingTools).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deferSourceMessageToolDelivery: false,
        operationalRunInstance: ordinary.attempt.admittedRunContext.operationalRunInstance,
      }),
    );
  });

  it("keeps policy snapshots independent from later attempt mutation", async () => {
    const config = { tools: { loopDetection: { enabled: true } } };
    const skillsSnapshot = { prompt: "safe", version: 1, skills: [{ name: "safe" }] };
    const { attempt } = await admittedAttempt("run-snapshot", { config, skillsSnapshot });
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });

    config.tools.loopDetection.enabled = false;
    skillsSnapshot.skills[0]!.name = "forged";
    await host.capabilities.runBeforeToolCall({ toolName: "read", params: {} });

    expect(mockRunBefore).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          config: { tools: { loopDetection: { enabled: true } } },
          skillsSnapshot: expect.objectContaining({ skills: [{ name: "safe" }] }),
        }),
      }),
    );
  });

  it("closes prepared mutable-file approval revalidators with the admitted run", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-host-binding-"));
    try {
      fs.writeFileSync(path.join(cwd, "script.sh"), "#!/bin/sh\necho approved\n");
      const { attempt } = await admittedAttempt("run-file-binding", { cwd });
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      const prepared = await host.capabilities.prepareMutableFileApproval?.({
        command: "sh script.sh",
        cwd,
      });
      expect(prepared?.ok).toBe(true);
      if (!prepared?.ok) {
        throw new Error("expected mutable file approval binding");
      }

      host.close();

      await expect(prepared.revalidate()).rejects.toThrow("no longer active");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps prepared environment access closure-bound", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    const { attempt } = await admittedAttempt("run-local-env", {
      config: {
        tools: { github: { profileId: "ghp_11111111111111111111111111111111" } },
      },
    });
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });

    expect(host.capabilities.preparedEnvironment?.()).toMatchObject({
      credentialScrubEnv: { GH_TOKEN: "", GITHUB_TOKEN: "" },
      localIdentityEnv: expect.objectContaining({ GH_CONFIG_DIR: expect.any(String) }),
      managedLocalIdentity: true,
    });
    host.close();
    expect(() => host.capabilities.preparedEnvironment?.()).toThrow("no longer active");
  });

  it("rejects retained preparation after the admitted Gateway is replaced", async () => {
    const { attempt } = await admittedAttempt("run-prepared-gateway");
    const admitted = {} as GatewayRequestContext;
    const replacement = {} as GatewayRequestContext;
    let current = admitted;
    bindGatewayContextResolver(attempt.admittedRunContext, () => current);
    const preparedExecute = vi.fn(async () => ({ content: [], details: {} }));
    const tool = attachInternalToolExecutionPreparer(testTool().tool, async () => {
      expect(getInProcessGatewayToolContext()).toBe(admitted);
      return {
        kind: "ready",
        args: {},
        execute: preparedExecute,
        dispose: vi.fn(),
      };
    });
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const [bound] = host.capabilities.bindToolSurface([tool]);
    const preparer = bound ? getInternalToolExecutionPreparer(bound) : undefined;
    if (!preparer) {
      throw new Error("expected bound preparer");
    }

    await withPluginRuntimeGatewayRequestScope(
      { context: replacement, isWebchatConnect: () => false },
      async () => {
        const prepared = await preparer({ toolCallId: "prepare", args: {} });
        expect(prepared.kind).toBe("ready");
        current = replacement;
        if (prepared.kind === "ready") {
          await expect(prepared.execute()).rejects.toThrow("no longer active");
        }
      },
    );

    expect(preparedExecute).not.toHaveBeenCalled();
  });

  it("delegates trajectory events and rejects a flush that outlives the capability", async () => {
    const flushStarted = createDeferred();
    const flushResult = createDeferred();
    const recordEvent = vi.fn();
    const flush = vi.fn(async () => {
      flushStarted.resolve();
      await flushResult.promise;
    });
    const { attempt } = await admittedAttempt("run-trajectory", {
      trajectoryRecorder: {
        recordEvent,
        flush,
      },
    });
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const trajectory = host.capabilities.trajectory;
    if (!trajectory) {
      throw new Error("expected trajectory capability");
    }

    trajectory.recordEvent("plugin.event", { ok: true });
    expect(recordEvent).toHaveBeenCalledWith("plugin.event", { ok: true });
    const pending = trajectory.flush();
    await flushStarted.promise;
    host.close();
    flushResult.resolve();

    await expect(pending).rejects.toThrow("no longer active");
    expect(() => trajectory.recordEvent("late.event")).toThrow("no longer active");
  });

  it("preserves ambient GitHub service tokens for a native local identity", async () => {
    vi.stubEnv("GH_TOKEN", "ambient-service-token");
    vi.stubEnv("GITHUB_TOKEN", "ambient-fallback-token");
    const { attempt } = await admittedAttempt("run-native-local-env", { config: {} });
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });

    expect(host.capabilities.preparedEnvironment?.()).toEqual({
      credentialScrubEnv: {},
      localIdentityEnv: {},
      managedLocalIdentity: false,
    });
  });

  it.each([
    { identity: "native", managed: false, source: "env" as const },
    { identity: "managed", managed: true, source: "env" as const },
    { identity: "native", managed: false, source: "store" as const },
    { identity: "managed", managed: true, source: "store" as const },
  ])(
    "prepares the $source preview scrub for a $identity local Codex host",
    async ({ managed, source }) => {
      const { attempt } = await admittedAttempt(`run-${source}-${managed ? "managed" : "native"}`, {
        config: {
          ...(managed
            ? { tools: { github: { profileId: "ghp_66666666666666666666666666666666" } } }
            : {}),
          gateway: {
            controlUi: {
              github: {
                token: { source, provider: "default", id: "PREVIEW_SERVICE_TOKEN" },
              },
            },
          },
        },
      });
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      const environment = host.capabilities.preparedEnvironment?.();

      if (managed) {
        expect(environment?.credentialScrubEnv).toMatchObject({
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
        });
      } else {
        expect(environment?.credentialScrubEnv).not.toHaveProperty("GH_TOKEN");
        expect(environment?.credentialScrubEnv).not.toHaveProperty("GITHUB_TOKEN");
      }
      expect(environment?.credentialScrubEnv).toHaveProperty("PREVIEW_SERVICE_TOKEN", "");
      expect(environment?.managedLocalIdentity).toBe(managed);
      expect(environment?.localIdentityEnv).not.toHaveProperty("PREVIEW_SERVICE_TOKEN");
    },
  );

  it("binds hooks to the native harness cwd instead of the agent workspace", async () => {
    const { attempt } = await admittedAttempt("run-native-cwd", {
      cwd: "/tmp/agent-workspace",
    });
    const { tool } = testTool();
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });

    host.capabilities.bindToolSurface([tool], { cwd: "/tmp/codex-binding" });

    expect(mockRewrap).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cwd: "/tmp/codex-binding" }),
    );
  });

  it("derives a bounded native action cwd without accepting forged host authority", async () => {
    const { attempt } = await admittedAttempt("run-native");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });

    const forgedRequest = {
      toolName: "exec",
      params: { command: "pwd" },
      nativeOperation: { cwd: " ./native/../action " },
      ctx: { agentId: "forged", cwd: "/forged" },
    };
    await host.capabilities.runBeforeToolCall(forgedRequest);

    expect(mockRunBefore).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          agentId: "main",
          runId: "run-native",
          sessionKey: "agent:main:session-1",
          cwd: "/attempt/worktree/action",
        }),
      }),
    );

    await expect(
      host.capabilities.runBeforeToolCall({
        toolName: "exec",
        params: { command: "pwd" },
        nativeOperation: { cwd: `/${"x".repeat(4096)}` },
      }),
    ).rejects.toThrow("must not exceed 4096 bytes");
    expect(mockRunBefore).toHaveBeenCalledTimes(1);
  });

  it.each(
    [
      {
        name: "lexical host closure",
        revoke: async ({
          host,
        }: {
          host: ReturnType<typeof createAgentHarnessHostCapabilities>;
          attempt: HostAttempt;
        }) => {
          host.close();
        },
      },
      {
        name: "exact authority release",
        revoke: async ({
          attempt,
        }: {
          host: ReturnType<typeof createAgentHarnessHostCapabilities>;
          attempt: HostAttempt;
        }) => {
          expect(closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(true);
        },
      },
      {
        name: "replacement owner",
        revoke: async ({
          attempt,
        }: {
          host: ReturnType<typeof createAgentHarnessHostCapabilities>;
          attempt: HostAttempt;
        }) => {
          await admittedAttempt(attempt.runId);
        },
      },
    ].flatMap((entry) =>
      (["resolve", "reject"] as const).map((settlement) => Object.assign({ settlement }, entry)),
    ),
  )("rejects a deferred policy $settlement after $name", async ({ revoke, settlement }) => {
    const { attempt } = await admittedAttempt("run-policy-race");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const hookStarted = createDeferred<(() => boolean | void) | undefined>();
    const hookResult = createDeferred<{ blocked: false; params: { command: string } }>();
    mockRunBefore.mockImplementationOnce(async () => {
      hookStarted.resolve(getGatewayToolCallerIdentity()?.receiptAuthority);
      return await hookResult.promise;
    });

    const pending = host.capabilities.runBeforeToolCall({
      toolName: "exec",
      params: { command: "true" },
    });
    const receiptAuthority = await hookStarted.promise;
    expect(receiptAuthority).toEqual(expect.any(Function));
    await revoke({ attempt, host });
    expect(receiptAuthority?.()).toBe(false);
    if (settlement === "resolve") {
      hookResult.resolve({ blocked: false, params: { command: "true" } });
    } else {
      hookResult.reject(new Error("deferred policy rejected"));
    }

    await expect(pending).rejects.toThrow(
      settlement === "resolve" ? "no longer active" : "deferred policy rejected",
    );
  });

  it("keeps a private native policy lease after foreground close but fences replacement", async () => {
    const { attempt } = await admittedAttempt("run-retained-policy");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const delegatedAuthority = getAdmittedRunDelegatedAuthority(attempt.admittedRunContext);
    const retained = retainBeforeToolCallForNativeHookRelay(host.capabilities.runBeforeToolCall);
    mockRunBefore.mockImplementationOnce(async ({ params }) => {
      expect(getGatewayToolCallerIdentity()).toBeUndefined();
      return { blocked: false, params };
    });
    expect(delegatedAuthority).toBeDefined();
    expect(retained).toBeDefined();
    if (!retained) {
      throw new Error("expected retained native policy lease");
    }

    expect(closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(true);
    expect(validateAgentRunDelegatedAuthority(delegatedAuthority!)).toBe(false);
    await expect(
      host.capabilities.runBeforeToolCall({ toolName: "exec", params: { command: "true" } }),
    ).rejects.toThrow("no longer active");
    await expect(
      retained.runBeforeToolCall({ toolName: "exec", params: { command: "true" } }),
    ).resolves.toMatchObject({ blocked: false });

    await admittedAttempt("run-retained-policy");
    await expect(
      retained.runBeforeToolCall({ toolName: "exec", params: { command: "true" } }),
    ).rejects.toThrow("no longer active");
    retained.release();
  });

  it("fences a retained native policy lease after lifecycle rotation", async () => {
    const { attempt } = await admittedAttempt("run-retained-policy-lifecycle");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    const retained = retainBeforeToolCallForNativeHookRelay(host.capabilities.runBeforeToolCall);
    if (!retained) {
      throw new Error("expected retained native policy lease");
    }
    expect(closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(true);

    rotateAgentRunRegistryLifecycleGeneration();

    await expect(
      retained.runBeforeToolCall({ toolName: "exec", params: { command: "true" } }),
    ).rejects.toThrow("no longer active");
    retained.release();
  });

  it.each([
    {
      name: "lexical host closure",
      revoke: async ({ host }: { host: ReturnType<typeof createAgentHarnessHostCapabilities> }) => {
        host.close();
      },
    },
    {
      name: "exact authority release",
      revoke: async ({ attempt }: { attempt: HostAttempt }) => {
        expect(closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(true);
      },
    },
    {
      name: "outer admission abort",
      revoke: async ({ admission }: { admission: PreparedAgentRunAdmission }) => {
        admission.close();
      },
    },
    {
      name: "replacement owner",
      revoke: async ({ attempt }: { attempt: HostAttempt }) => {
        await admittedAttempt(attempt.runId);
      },
    },
  ])("rejects late approval results after $name", async ({ name, revoke }) => {
    const operations = [
      {
        name: "request",
        result: { id: "approval-1", decision: null },
        start: (host: ReturnType<typeof createAgentHarnessHostCapabilities>) =>
          host.capabilities.requestApproval({
            title: "Run command",
            description: "Execute a native command",
            severity: "warning",
            toolName: "exec",
            timeoutMs: 1_000,
          }),
      },
      {
        name: "wait",
        result: { id: "approval-1", decision: "allow-once" as const },
        start: (host: ReturnType<typeof createAgentHarnessHostCapabilities>) =>
          host.capabilities.waitForApproval({ approvalId: "approval-1", timeoutMs: 1_000 }),
      },
    ] as const;

    for (const operation of operations) {
      const runId = `run-approval-race-${name.replaceAll(" ", "-")}-${operation.name}`;
      const { attempt, admission } = await admittedAttempt(runId);
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      const gatewayStarted = createDeferred();
      const gatewayResult = createDeferred<typeof operation.result>();
      mockCallGatewayTool.mockImplementationOnce(async () => {
        gatewayStarted.resolve();
        return await gatewayResult.promise;
      });

      const pending = operation.start(host);
      await gatewayStarted.promise;
      await revoke({ admission, attempt, host });
      gatewayResult.resolve(operation.result);

      await expect(pending).rejects.toThrow("no longer active");
    }
  });

  it("preserves the gateway decision and terminal reason at the host boundary", async () => {
    const { attempt } = await admittedAttempt("run-approval-timeout-result");
    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "approval-1",
      decision: "deny",
      terminalReason: "timeout",
    });

    await expect(
      host.capabilities.waitForApproval({ approvalId: "approval-1", timeoutMs: 1_000 }),
    ).resolves.toEqual({ decision: "deny", terminalReason: "timeout" });
  });

  it("revokes a retained bound tool when the same run id gets a replacement owner", async () => {
    const first = await admittedAttempt("run-replaced");
    const { tool, execute } = testTool();
    const { bound } = bindTool(first.attempt, tool);

    await admittedAttempt("run-replaced");

    await expect(bound.execute("call-1", {})).rejects.toThrow("no longer active");
    expect(execute).not.toHaveBeenCalled();
  });

  it("revalidates the source boundary after awaited bound-tool policy", async () => {
    const { attempt, admission } = await admittedAttempt("run-bound-policy-race");
    const policyStarted = createDeferred();
    const policyResult = createDeferred();
    mockRewrap.mockImplementationOnce((tool) => ({
      ...tool,
      execute: async (...args: Parameters<NonNullable<AnyAgentTool["execute"]>>) => {
        policyStarted.resolve();
        await policyResult.promise;
        runAgentToolSourceExecutionGuard(tool);
        return await tool.execute?.(...args);
      },
    }));
    const { tool, execute } = testTool();
    const { bound } = bindTool(attempt, tool);

    const pending = bound.execute("call-policy-race", {});
    await policyStarted.promise;
    admission.close();
    policyResult.resolve();

    await expect(pending).rejects.toThrow("no longer active");
    expect(execute).not.toHaveBeenCalled();
  });

  it("aborts an in-flight bound tool when its host capability closes", async () => {
    const { attempt } = await admittedAttempt("run-bound-close-race");
    const sourceStarted = createDeferred();
    const sourceResult = createDeferred<{ content: []; details: Record<string, never> }>();
    const { tool } = testTool(
      vi.fn(async () => {
        sourceStarted.resolve();
        return await sourceResult.promise;
      }),
    );
    const { host, bound } = bindTool(attempt, tool);

    const pending = bound.execute("call-close-race", {});
    await sourceStarted.promise;
    host.close();

    await expect(pending).rejects.toThrow("Aborted");
    sourceResult.resolve({ content: [], details: {} });
  });

  it("rejects a bound tool result after exact authority closes during execution", async () => {
    const { attempt } = await admittedAttempt("run-bound-release-race");
    const sourceStarted = createDeferred();
    const sourceResult = createDeferred<{ content: []; details: Record<string, never> }>();
    const { tool } = testTool(
      vi.fn(async () => {
        sourceStarted.resolve();
        return await sourceResult.promise;
      }),
    );
    const { bound } = bindTool(attempt, tool);

    const pending = bound.execute("call-release-race", {});
    await sourceStarted.promise;
    expect(closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(true);
    sourceResult.resolve({ content: [], details: {} });

    await expect(pending).rejects.toThrow("no longer active");
  });

  it("disposes a prepared handle that resolves after host capability closure", async () => {
    const { attempt } = await admittedAttempt("run-preparation-close-race");
    const preparationStarted = createDeferred();
    const preparationResult = createDeferred<Awaited<ReturnType<InternalToolExecutionPreparer>>>();
    const dispose = vi.fn();
    const { tool } = testTool();
    attachInternalToolExecutionPreparer(tool, async () => {
      preparationStarted.resolve();
      return await preparationResult.promise;
    });
    const { host, bound } = bindTool(attempt, tool);
    const boundPreparer = getInternalToolExecutionPreparer(bound);
    if (!boundPreparer) {
      throw new Error("expected retained bound execution preparer");
    }

    const pending = boundPreparer({ toolCallId: "call-prepare-close-race", args: {} });
    await preparationStarted.promise;
    host.close();

    await expect(pending).rejects.toThrow("Aborted");
    preparationResult.resolve({
      kind: "immediate",
      outcome: { kind: "error", error: new Error("late preparation") },
      dispose,
    });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });

  it("aborts prepared execution when its host capability closes", async () => {
    const { attempt } = await admittedAttempt("run-prepared-close-race");
    const executionStarted = createDeferred();
    const executionResult = createDeferred<{ content: []; details: Record<string, never> }>();
    const { tool } = testTool();
    attachInternalToolExecutionPreparer(tool, async () => ({
      kind: "ready",
      args: {},
      execute: async () => {
        executionStarted.resolve();
        return await executionResult.promise;
      },
      dispose() {},
    }));
    const { host, bound } = bindTool(attempt, tool);
    const boundPreparer = getInternalToolExecutionPreparer(bound);
    if (!boundPreparer) {
      throw new Error("expected retained bound execution preparer");
    }
    const prepared = await boundPreparer({ toolCallId: "call-ready-close-race", args: {} });
    if (prepared.kind !== "ready") {
      throw new Error("expected ready execution preparation");
    }

    const pending = prepared.execute();
    await executionStarted.promise;
    host.close();

    await expect(pending).rejects.toThrow("Aborted");
    executionResult.resolve({ content: [], details: {} });
  });

  it("restores the attempt abort race around a rebound tool", async () => {
    const abortController = new AbortController();
    const { attempt } = await admittedAttempt("run-bound-abort", {
      abortSignal: abortController.signal,
    });
    const sourceStarted = createDeferred();
    const sourceResult = createDeferred<{ content: []; details: Record<string, never> }>();
    const { tool } = testTool(
      vi.fn(async () => {
        sourceStarted.resolve();
        return await sourceResult.promise;
      }),
    );
    const { bound } = bindTool(attempt, tool);

    const pending = bound.execute("call-abort", {});
    await sourceStarted.promise;
    abortController.abort();

    await expect(pending).rejects.toThrow("Aborted");
    sourceResult.resolve({ content: [], details: {} });
  });

  it("revokes a retained bound tool after lifecycle rotation", async () => {
    const { attempt } = await admittedAttempt("run-rotated");
    const { tool, execute } = testTool();
    const { bound } = bindTool(attempt, tool);

    rotateAgentRunRegistryLifecycleGeneration();

    await expect(bound.execute("call-1", {})).rejects.toThrow("no longer active");
    expect(execute).not.toHaveBeenCalled();
  });

  it("revokes retained tools on exact release and outer abort", async () => {
    const released = await admittedAttempt("run-released");
    const releasedTool = testTool();
    const releasedBound = bindTool(released.attempt, releasedTool.tool).bound;
    expect(closeAdmittedRunDelegatedAuthority(released.attempt.admittedRunContext)).toBe(true);
    await expect(releasedBound.execute("call-release", {})).rejects.toThrow("no longer active");
    expect(releasedTool.execute).not.toHaveBeenCalled();

    const aborted = await admittedAttempt("run-aborted");
    const abortedTool = testTool();
    const abortedBound = bindTool(aborted.attempt, abortedTool.tool).bound;
    aborted.admission.close();
    await expect(abortedBound.execute("call-abort", {})).rejects.toThrow("no longer active");
    expect(abortedTool.execute).not.toHaveBeenCalled();
  });

  it("fails closed when constructing a host after admission authority closes", async () => {
    const { attempt, admission } = await admittedAttempt("run-closed-before-host");
    admission.close();

    expect(() => createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" })).toThrow(
      "requires active admitted run authority",
    );
  });

  it("rejects a retained execution preparer before preparation after revocation", async () => {
    const { attempt, admission } = await admittedAttempt("run-prepare-revoked");
    const { tool } = testTool();
    const prepare = vi.fn<InternalToolExecutionPreparer>(async () => ({
      kind: "immediate",
      outcome: { kind: "error", error: new Error("not reached") },
      dispose() {},
    }));
    attachInternalToolExecutionPreparer(tool, prepare);
    const { bound } = bindTool(attempt, tool);
    const boundPreparer = getInternalToolExecutionPreparer(bound);
    admission.close();

    await expect(boundPreparer?.({ toolCallId: "call-prepare", args: {} })).rejects.toThrow(
      "no longer active",
    );
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects ready execution when authority closes after preparation", async () => {
    const { attempt, admission } = await admittedAttempt("run-ready-revoked");
    const { tool } = testTool();
    const executePrepared = vi.fn(async () => ({ content: [], details: {} }));
    const prepare = vi.fn<InternalToolExecutionPreparer>(async () => ({
      kind: "ready",
      args: {},
      execute: executePrepared,
      dispose() {},
    }));
    attachInternalToolExecutionPreparer(tool, prepare);
    const { bound } = bindTool(attempt, tool);
    const boundPreparer = getInternalToolExecutionPreparer(bound);
    if (!boundPreparer) {
      throw new Error("expected retained bound execution preparer");
    }
    const prepared = await boundPreparer({ toolCallId: "call-ready", args: {} });
    expect(prepared.kind).toBe("ready");
    admission.close();

    if (prepared.kind !== "ready") {
      throw new Error("expected ready execution preparation");
    }
    await expect(prepared.execute()).rejects.toThrow("no longer active");
    expect(executePrepared).not.toHaveBeenCalled();
  });
});
