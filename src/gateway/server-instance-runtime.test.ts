import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "../../packages/gateway-client/src/timeouts.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { GatewayNativeApprovalMethod } from "../infra/approval-gateway-runtime-methods.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";

function createContext(): GatewayRequestContext {
  return {
    deps: {},
    getRuntimeConfig: () => ({}),
    logGateway: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
}

function createRegistry(handlers: GatewayRequestHandlers) {
  return createGatewayMethodRegistry(
    Object.entries(handlers).map(([name, handler]) => ({
      name,
      handler,
      owner: { kind: "core" as const, area: "test" },
      scope: name.includes("approval") ? APPROVALS_SCOPE : WRITE_SCOPE,
    })),
  );
}

describe("createGatewayInstanceRuntime", () => {
  it("uses the typed recovery path and fails closed when the owning instance closes", async () => {
    let available = false;
    const rawAgent = vi.fn<NonNullable<GatewayRequestHandlers["agent"]>>(({ respond }) => {
      respond(true, { raw: true });
    });
    const rawAbort = vi.fn<NonNullable<GatewayRequestHandlers["chat.abort"]>>(
      ({ params, respond }) => {
        respond(true, { aborted: true, runIds: [(params as { runId: string }).runId] });
      },
    );
    const registry = createRegistry({ agent: rawAgent, "chat.abort": rawAbort });
    const context = createContext();
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () => registry,
      isDispatchAvailable: () => available,
    });
    expect(getGatewayRecoveryRuntime()).toBe(runtime.recovery);

    await expect(
      runtime.recovery.dispatchAgent({ message: "test", idempotencyKey: "run-unavailable" }),
    ).rejects.toThrow("Gateway instance dispatch unavailable");
    available = true;
    await expect(
      runtime.recovery.abortAgent({
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:main",
      }),
    ).resolves.toEqual({ aborted: true, runIds: ["run-1"] });
    expect(rawAbort).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          agentId: "main",
          runId: "run-1",
          sessionKey: "agent:main:main",
        },
      }),
    );
    await expect(runtime.recovery.waitForAgent({ runId: "run-1", timeoutMs: 0 })).resolves.toEqual({
      runId: "run-1",
      status: "timeout",
      timeoutPhase: "queue",
      providerStarted: false,
    });
    context.dedupe.set("agent:run-cached-recovery", {
      ts: Date.now(),
      ok: true,
      payload: { runId: "run-cached-recovery", status: "ok", summary: "replayed" },
    });
    await expect(
      runtime.recovery.dispatchAgent({
        message: "test",
        idempotencyKey: "run-cached-recovery",
      }),
    ).resolves.toEqual({ runId: "run-cached-recovery", status: "ok", summary: "replayed" });
    const onExecutionStarted = vi.fn();
    context.dedupe.set("agent:run-cached-active", {
      ts: Date.now(),
      ok: true,
      payload: { runId: "run-cached-active", status: "accepted" },
    });
    context.chatAbortControllers.set("run-cached-active", {
      controller: new AbortController(),
      executionStarted: true,
    } as never);
    await expect(
      runtime.recovery.dispatchAgent(
        { message: "test", idempotencyKey: "run-cached-active" },
        undefined,
        { onExecutionStarted },
      ),
    ).resolves.toMatchObject({ runId: "run-cached-active", status: "in_flight" });
    expect(onExecutionStarted).toHaveBeenCalledOnce();
    await expect(
      runtime.recovery.dispatchAgent({
        message: "test",
        idempotencyKey: "run-typed-recovery",
        cwd: "relative",
      }),
    ).rejects.toThrow("cwd must be absolute");
    expect(rawAgent).not.toHaveBeenCalled();

    const retainedFacade = await runtime.createAgentTurnFacade({
      client: createSyntheticPluginRuntimeClient({ scopes: [WRITE_SCOPE] }),
    });
    runtime.close();
    expect(getGatewayRecoveryRuntime()).toBeUndefined();
    await expect(runtime.recovery.waitForAgent({ runId: "run-1" })).rejects.toThrow(
      "Gateway instance dispatch unavailable",
    );
    await expect(
      retainedFacade.dispatch({ message: "stale completion", idempotencyKey: "closed-host" }),
    ).rejects.toThrow("Gateway instance dispatch unavailable");
    await expect(retainedFacade.wait({ runId: "run-1" })).rejects.toThrow(
      "Gateway instance dispatch unavailable",
    );
  });

  it("captures trusted agent principal fields verbatim", () => {
    const client = createSyntheticPluginRuntimeClient({
      allowModelOverride: true,
      agentRunTracking: "plugin_subagent",
      cronRunContinuation: true,
      internalDeliveryMediaUrls: ["https://example.test/media"],
      internalDeliverySuppressText: true,
      pluginRuntimeOwnerId: "memory-core",
      delegatedToolPolicyHandoffId: "handoff-1",
      sessionCreation: {
        via: "spawn",
        actor: { type: "agent", id: "main" },
        requesterSessionKey: "agent:main:main",
      },
    });

    const principal = captureAgentTurnPrincipal(client);

    expect(principal?.connect).toBe(client.connect);
    expect(principal?.internal).toBe(client.internal);
    expect(principal?.internal).toEqual(client.internal);

    const recoveryClient = createSyntheticPluginRuntimeClient({ scopes: [WRITE_SCOPE] });
    const recoveryPrincipal = captureAgentTurnPrincipal(recoveryClient);
    expect(recoveryPrincipal?.connect?.client.mode).toBe("backend");
    expect(recoveryPrincipal?.internal).toEqual({
      syntheticClient: true,
      allowModelOverride: false,
    });
    expect(recoveryPrincipal?.internal?.agentRunTracking).toBeUndefined();
    expect(recoveryPrincipal?.internal?.sessionCreation).toBeUndefined();
  });

  it("sends recovery notices through normal outbound without invoking plugin actions", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "recovery-notice-" }, async () => {
      const sendText = vi.fn(async () => ({ channel: "signal", messageId: "signal-message-1" }));
      const handleAction = vi.fn(async () => {
        throw new Error("recovery notice must not invoke message actions");
      });
      const plugin: ChannelPlugin = {
        id: "signal",
        meta: {
          id: "signal",
          label: "Signal",
          selectionLabel: "Signal",
          docsPath: "/channels/signal",
          blurb: "Signal-shaped recovery test plugin.",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["work"],
          resolveAccount: () => ({}),
          isConfigured: () => true,
        },
        actions: {
          describeMessageTool: () => ({ actions: ["send"] }),
          supportsAction: () => false,
          handleAction,
        },
        outbound: {
          deliveryMode: "direct",
          resolveTarget: ({ to }) => ({ ok: true, to: to?.trim() ?? "" }),
          sendText,
        },
      };
      const pluginRegistrySnapshot = captureActivePluginRegistrySnapshot();
      stageActivePluginRegistry(
        createTestRegistry([{ pluginId: "signal", source: "test", plugin }]),
        null,
        "default",
      );
      const context = {
        ...createContext(),
        getRuntimeConfig: () => ({ channels: { signal: { enabled: true } } }),
      } as GatewayRequestContext;
      const runtime = createGatewayInstanceRuntime({
        getContext: () => context,
        getMethodRegistry: () => createRegistry({}),
        isDispatchAvailable: () => true,
      });

      try {
        await runtime.recovery.sendRecoveryNotice({
          channel: "signal",
          to: "+15551234567",
          accountId: "work",
          threadId: "thread-1",
          text: "Recovery notice",
          idempotencyKey: "main-session-restart-recovery:run-1:failed-notice",
        });

        expect(sendText).toHaveBeenCalledOnce();
        expect(sendText).toHaveBeenCalledWith(
          expect.objectContaining({
            to: "+15551234567",
            accountId: "work",
            threadId: "thread-1",
            text: "Recovery notice",
          }),
        );
        expect(handleAction).not.toHaveBeenCalled();
      } finally {
        runtime.close();
        restoreActivePluginRegistrySnapshot(pluginRegistrySnapshot);
      }
    });
  });

  it("keeps approval subscribers isolated by Gateway instance and unregisters exactly once", () => {
    const registry = createRegistry({});
    const first = createGatewayInstanceRuntime({
      getContext: createContext,
      getMethodRegistry: () => registry,
      isDispatchAvailable: () => true,
    });
    const second = createGatewayInstanceRuntime({
      getContext: createContext,
      getMethodRegistry: () => registry,
      isDispatchAvailable: () => true,
    });
    expect(getGatewayRecoveryRuntime()).toBe(second.recovery);
    const onRequested = vi.fn();
    const unsubscribe = first.nativeApprovals.subscribe({
      eventKinds: new Set(["exec"]),
      shouldHandle: () => true,
      onRequested,
      onResolved: vi.fn(),
    });
    const request = {
      id: "approval-1",
      request: {},
      createdAtMs: 1,
      expiresAtMs: 2,
    } as ExecApprovalRequest;

    expect(second.approvalEvents.publishRequested("exec", request)).toBe(0);
    expect(first.approvalEvents.publishRequested("plugin", request)).toBe(0);
    expect(first.approvalEvents.publishRequested("exec", request)).toBe(1);
    expect(onRequested).toHaveBeenCalledOnce();

    unsubscribe();
    unsubscribe();
    expect(first.approvalEvents.publishRequested("exec", request)).toBe(0);

    const declined = vi.fn();
    first.nativeApprovals.subscribe({
      eventKinds: new Set(["exec"]),
      shouldHandle: () => false,
      onRequested: declined,
      onResolved: vi.fn(),
    });
    expect(first.approvalEvents.publishRequested("exec", request)).toBe(0);
    expect(declined).not.toHaveBeenCalled();
    first.close();
    expect(getGatewayRecoveryRuntime()).toBe(second.recovery);
    second.close();
    expect(getGatewayRecoveryRuntime()).toBeUndefined();
  });

  it("rejects methods outside each closed internal principal", async () => {
    const runtime = createGatewayInstanceRuntime({
      getContext: createContext,
      getMethodRegistry: () => createRegistry({}),
      isDispatchAvailable: () => true,
    });

    await expect(
      runtime.nativeApprovals.request("config.get" as GatewayNativeApprovalMethod, {}),
    ).rejects.toThrow("internal principal cannot dispatch config.get");
    await expect(runtime.nativeApprovals.requestRoute("config.get" as "send", {})).rejects.toThrow(
      "internal principal cannot dispatch config.get",
    );
    runtime.close();
  });

  it("preserves a trusted approval resolver display name", async () => {
    const runtime = createGatewayInstanceRuntime({
      getContext: createContext,
      getMethodRegistry: () =>
        createRegistry({
          "exec.approval.list": ({ client, respond }) =>
            respond(true, { displayName: client?.connect.client.displayName }),
        }),
      isDispatchAvailable: () => true,
    });

    await expect(
      runtime.nativeApprovals.request(
        "exec.approval.list",
        {},
        { clientDisplayName: "Telegram approval (owner)" },
      ),
    ).resolves.toEqual({ displayName: "Telegram approval (owner)" });
    runtime.close();
  });

  it("preserves the Gateway client's approval request deadline", async () => {
    vi.useFakeTimers();
    try {
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let finishHandler!: () => void;
      const handlerCanFinish = new Promise<void>((resolve) => {
        finishHandler = resolve;
      });
      const runtime = createGatewayInstanceRuntime({
        getContext: createContext,
        getMethodRegistry: () =>
          createRegistry({
            send: async () => {
              markStarted();
              await handlerCanFinish;
            },
          }),
        isDispatchAvailable: () => true,
      });

      try {
        const request = runtime.nativeApprovals.requestRoute("send", { message: "test" });
        const error = request.catch((value: unknown) => value);
        await started;
        await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
        const caught = await error;
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain("gateway request timeout for send");
      } finally {
        finishHandler();
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        runtime.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
