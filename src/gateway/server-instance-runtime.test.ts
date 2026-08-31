import { expectDefined } from "@openclaw/normalization-core";
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
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { setGatewayDedupeEntry } from "./agent-turn/agent-job.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import { handleChatAbortRequest } from "./server-methods/chat-abort-handler.js";
import { sendHandlers } from "./server-methods/send.js";
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
  describe.each(["live", "closed", "unavailable"] as const)(
    "instance liveness after authorization: %s",
    (liveness) => {
      it.each(["shared dispatch", "dedicated dispatch", "wait"] as const)(
        "%s stays bound to its available originating instance",
        async (operation) => {
          let available = true;
          const context = createContext();
          const runId = `instance-liveness-${liveness}-${operation}`;
          const payload = { runId, status: "ok", summary: "originating instance" };
          context.dedupe.set(`agent:${runId}`, { ts: Date.now(), ok: true, payload });
          const registry = createRegistry({});
          const runtime = createGatewayInstanceRuntime({
            getContext: () => context,
            getMethodRegistry: () => registry,
            isDispatchAvailable: () => available,
          });
          context.resolveGatewayContext = () => (runtime.isAvailable() ? context : undefined);
          context.recoveryRuntime = runtime.recovery;
          const replacementContext = createContext();
          replacementContext.dedupe.set(`agent:${runId}`, {
            ts: Date.now(),
            ok: true,
            payload: { ...payload, summary: "replacement instance" },
          });
          const getReplacementContext = vi.fn(() => replacementContext);
          const replacement = createGatewayInstanceRuntime({
            getContext: getReplacementContext,
            getMethodRegistry: () => registry,
            isDispatchAvailable: () => true,
          });
          try {
            expect(getGatewayRecoveryRuntime()).toBe(replacement.recovery);
            const pending =
              operation === "wait"
                ? runtime.recovery.waitForAgent({ runId, timeoutMs: 0 })
                : runtime.recovery.dispatchAgent(
                    {
                      message: "test",
                      idempotencyKey: runId,
                      ...(operation === "dedicated dispatch" ? { model: "test-model" } : {}),
                    },
                    undefined,
                    { allowModelOverride: operation === "dedicated dispatch" },
                  );
            // The real authorization function has yielded, but no envelope owns work yet.
            expect(getActiveGatewayRootWorkCount()).toBe(0);
            if (liveness === "closed") {
              runtime.close();
            } else if (liveness === "unavailable") {
              available = false;
            }
            if (liveness === "live") {
              await expect(pending).resolves.toEqual(
                operation === "wait"
                  ? { runId, status: "timeout", timeoutPhase: "queue", providerStarted: false }
                  : payload,
              );
            } else {
              await expect(pending).rejects.toThrow("Gateway instance dispatch unavailable");
            }
          } finally {
            runtime.close();
            replacement.close();
            expect(getReplacementContext).not.toHaveBeenCalled();
            expect(getGatewayRecoveryRuntime()).toBeUndefined();
            await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
          }
        },
      );
    },
  );

  it.each(["fresh root", "retained root"] as const)(
    "keeps the instance fence distinct from process drain: %s",
    async (rootKind) => {
      const context = createContext();
      const runId = `instance-liveness-drain-${rootKind}`;
      context.dedupe.set(`agent:${runId}`, {
        ts: Date.now(),
        ok: true,
        payload: { runId, status: "ok" },
      });
      const runtime = createGatewayInstanceRuntime({
        getContext: () => context,
        getMethodRegistry: () => createRegistry({}),
        isDispatchAvailable: () => true,
      });
      context.resolveGatewayContext = () => (runtime.isAvailable() ? context : undefined);
      const root = rootKind === "retained root" ? tryBeginGatewayRootWorkAdmission() : undefined;
      const dispatch = async () => {
        const pending = runtime.recovery.dispatchAgent({ message: "test", idempotencyKey: runId });
        markGatewayRestartDraining();
        if (rootKind === "retained root") {
          runtime.close();
        }
        await expect(pending).rejects.toThrow(
          rootKind === "retained root"
            ? "Gateway instance dispatch unavailable"
            : "gateway restart",
        );
      };
      try {
        if (rootKind === "retained root") {
          expect(root).toBeTruthy();
        }
        await (root ? root.run(dispatch) : dispatch());
      } finally {
        runtime.close();
        root?.release();
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        resetGatewayWorkAdmission();
      }
    },
  );

  it("preserves an already-admitted wait when its instance closes", async () => {
    const context = createContext();
    const runId = "instance-liveness-admitted-wait";
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () => createRegistry({}),
      isDispatchAvailable: () => true,
    });
    context.resolveGatewayContext = () => (runtime.isAvailable() ? context : undefined);
    const pending = runtime.recovery.waitForAgent({ runId });
    const finish = () =>
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `agent:${runId}`,
        entry: { ts: Date.now(), ok: true, payload: { runId, status: "ok" } },
      });
    try {
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(1));
      runtime.close();
      finish();
      await expect(pending).resolves.toMatchObject({ runId, status: "ok" });
    } finally {
      finish();
      await pending;
      runtime.close();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    }
  });

  it.each(["live", "closed", "unavailable"] as const)(
    "checks instance liveness before the real abort handler: %s",
    async (liveness) => {
      await withOpenClawTestState({ layout: "state-only", prefix: "instance-abort-" }, async () => {
        let available = true;
        const context = createContext();
        const runId = `instance-liveness-abort-${liveness}`;
        const payload = {
          runId,
          status: "accepted",
          agentId: "main",
          sessionKey: "agent:main:main",
        };
        context.dedupe.set(`agent:${runId}`, { ts: Date.now(), ok: true, payload });
        const runtime = createGatewayInstanceRuntime({
          getContext: () => context,
          getMethodRegistry: () => createRegistry({ "chat.abort": handleChatAbortRequest }),
          isDispatchAvailable: () => available,
        });
        context.resolveGatewayContext = () => (runtime.isAvailable() ? context : undefined);
        try {
          const pending = runtime.recovery.abortAgent({
            agentId: "main",
            runId,
            sessionKey: payload.sessionKey,
          });
          if (liveness === "closed") {
            runtime.close();
          } else if (liveness === "unavailable") {
            available = false;
          }
          if (liveness === "live") {
            await expect(pending).resolves.toMatchObject({ aborted: true, runIds: [runId] });
            expect(context.dedupe.get(`agent:${runId}`)?.payload).toMatchObject({
              status: "timeout",
              stopReason: "rpc",
            });
          } else {
            await expect.soft(pending).rejects.toThrow("Gateway instance dispatch unavailable");
            expect(context.dedupe.get(`agent:${runId}`)?.payload).toEqual(payload);
          }
        } finally {
          runtime.close();
          await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        }
      });
    },
  );

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

  it.each([
    ["recovery notice", "live"],
    ["recovery notice", "closed"],
    ["recovery notice", "unavailable"],
    ["approval route", "live"],
    ["approval route", "closed"],
    ["approval route", "unavailable"],
  ] as const)(
    "checks instance liveness before normal outbound: %s / %s",
    async (surface, liveness) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "recovery-notice-" },
        async () => {
          const sendText = vi.fn(async () => ({
            channel: "signal",
            messageId: "signal-message-1",
          }));
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
            getRuntimeConfig: () => ({
              agents: { list: [{ id: "main" }] },
              channels: { signal: { enabled: true } },
            }),
          } as GatewayRequestContext;
          let available = true;
          const runtime = createGatewayInstanceRuntime({
            getContext: () => context,
            getMethodRegistry: () =>
              createRegistry({ send: expectDefined(sendHandlers.send, "send handler") }),
            isDispatchAvailable: () => available,
          });
          context.resolveGatewayContext = () => (runtime.isAvailable() ? context : undefined);

          try {
            const payload = {
              channel: "signal",
              to: "+15551234567",
              accountId: "work",
              threadId: "thread-1",
              idempotencyKey: `main-session-restart-recovery:${surface}:${liveness}`,
            };
            const pending =
              surface === "recovery notice"
                ? runtime.recovery.sendRecoveryNotice({ ...payload, text: "Recovery notice" })
                : runtime.nativeApprovals.requestRoute("send", {
                    ...payload,
                    message: "Recovery notice",
                  });
            if (liveness === "closed") {
              runtime.close();
            } else if (liveness === "unavailable") {
              available = false;
            }
            if (liveness === "live") {
              await pending;
              expect(sendText).toHaveBeenCalledOnce();
              expect(sendText).toHaveBeenCalledWith(
                expect.objectContaining({
                  to: "+15551234567",
                  accountId: "work",
                  threadId: "thread-1",
                  text: "Recovery notice",
                }),
              );
            } else {
              await expect.soft(pending).rejects.toThrow("Gateway instance dispatch unavailable");
              expect(sendText).not.toHaveBeenCalled();
            }
            expect(handleAction).not.toHaveBeenCalled();
          } finally {
            runtime.close();
            await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
            restoreActivePluginRegistrySnapshot(pluginRegistrySnapshot);
          }
        },
      );
    },
  );

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
