import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "../../packages/gateway-client/src/timeouts.js";
import type { GatewayNativeApprovalMethod } from "../infra/approval-gateway-runtime-methods.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./server-methods/types.js";
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";

function createContext(): GatewayRequestContext {
  return {
    logGateway: {
      warn: vi.fn(),
      error: vi.fn(),
    },
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
  it("uses the live registry and fails closed when the owning instance closes", async () => {
    let version = "one";
    let available = false;
    let registry = createRegistry({
      agent: ({ respond }) => respond(true, { version }),
      "agent.wait": ({ respond }) => respond(true, { status: "ok" }),
      "message.action": ({ respond }) => respond(true, { ok: true }),
    });
    const runtime = createGatewayInstanceRuntime({
      getContext: createContext,
      getMethodRegistry: () => registry,
      isDispatchAvailable: () => available,
    });
    expect(getGatewayRecoveryRuntime()).toBe(runtime.recovery);

    await expect(runtime.recovery.dispatchAgent({ message: "test" })).rejects.toThrow(
      "Gateway instance dispatch unavailable",
    );
    available = true;
    await expect(runtime.recovery.dispatchAgent({ message: "test" })).resolves.toEqual({
      version: "one",
    });
    version = "two";
    registry = createRegistry({
      agent: ({ respond }) => respond(true, { version }),
      "agent.wait": ({ respond }) => respond(true, { status: "ok" }),
      "message.action": ({ respond }) => respond(true, { ok: true }),
    });
    await expect(runtime.recovery.dispatchAgent({ message: "test" })).resolves.toEqual({
      version: "two",
    });

    runtime.close();
    expect(getGatewayRecoveryRuntime()).toBeUndefined();
    await expect(runtime.recovery.waitForAgent({ runId: "run-1" })).rejects.toThrow(
      "Gateway instance dispatch unavailable",
    );
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
      const runtime = createGatewayInstanceRuntime({
        getContext: createContext,
        getMethodRegistry: () =>
          createRegistry({
            send: async () => {
              markStarted();
              await new Promise<never>(() => {});
            },
          }),
        isDispatchAvailable: () => true,
      });

      const request = runtime.nativeApprovals.requestRoute("send", { message: "test" });
      const error = request.catch((value: unknown) => value);
      await started;
      await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
      const caught = await error;
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("gateway request timeout for send");
      runtime.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
