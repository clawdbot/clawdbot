// Covers approval handler runtime adapter creation and lazy wiring.
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withGatewayNativeApprovalRuntime } from "./approval-gateway-runtime-context.js";
import type { GatewayNativeApprovalRuntime } from "./approval-gateway-runtime.types.js";
import {
  createChannelApprovalNativeRuntimeAdapter,
  createChannelApprovalHandlerFromCapability,
  createLazyChannelApprovalNativeRuntimeAdapter,
} from "./approval-handler-runtime.js";
import {
  createApprovalNativeRuntimeAdapterStubs,
  type ApprovalNativeRuntimeAdapterStubParams,
} from "./approval-handler.test-helpers.js";
import { createApprovalNativeRouteCoordinator } from "./approval-native-route-coordinator.js";
import { doesApprovalRequestSelectChannelAccount } from "./approval-request-account-binding.js";
import type { NormalizedApprovalRequest } from "./approval-types.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

type ApprovalCapability = NonNullable<
  Parameters<typeof createChannelApprovalHandlerFromCapability>[0]["capability"]
>;
type ApprovalNativeAdapter = NonNullable<ApprovalCapability["native"]>;

const TEST_HANDLER_PARAMS = {
  label: "test/approval-handler",
  clientDisplayName: "Test Approval Handler",
  channel: "test",
  channelLabel: "Test",
  cfg: { channels: {} } as never,
} as const;

function makeSequentialPendingDeliveryMock() {
  return vi
    .fn()
    .mockResolvedValueOnce({ messageId: "1" })
    .mockResolvedValueOnce({ messageId: "2" });
}

function makeSequentialPendingBindingMock() {
  return vi
    .fn()
    .mockResolvedValueOnce({ bindingId: "bound-1" })
    .mockResolvedValueOnce({ bindingId: "bound-2" });
}

function makeExecApprovalRequest(id: string): NormalizedApprovalRequest<ExecApprovalRequest> {
  return {
    approvalKind: "exec",
    id,
    expiresAtMs: Date.now() + 60_000,
    request: {
      command: "echo hi",
      turnSourceChannel: "test",
      turnSourceTo: "origin-chat",
    },
    createdAtMs: Date.now(),
  };
}

function makeNativeApprovalCapability(
  params: {
    preferredSurface?: ReturnType<
      ApprovalNativeAdapter["describeDeliveryCapabilities"]
    >["preferredSurface"];
    supportsApproverDmSurface?: boolean;
    resolveApproverDmTargets?: ApprovalNativeAdapter["resolveApproverDmTargets"];
  } & ApprovalNativeRuntimeAdapterStubParams = {},
): ApprovalCapability {
  const preferredSurface = params.preferredSurface ?? "origin";
  return {
    native: {
      describeDeliveryCapabilities: vi.fn().mockReturnValue({
        enabled: true,
        preferredSurface,
        supportsOriginSurface: true,
        supportsApproverDmSurface: params.supportsApproverDmSurface ?? false,
        notifyOriginWhenDmOnly: false,
      }),
      resolveOriginTarget: vi.fn().mockReturnValue({ to: "origin-chat" }),
      ...(params.resolveApproverDmTargets
        ? { resolveApproverDmTargets: params.resolveApproverDmTargets }
        : {}),
    },
    nativeRuntime: createApprovalNativeRuntimeAdapterStubs(params),
  };
}

function createTestApprovalHandler(capability: ApprovalCapability) {
  return createChannelApprovalHandlerFromCapability({
    capability,
    ...TEST_HANDLER_PARAMS,
  });
}

function createApprovalGatewayRuntime(getRuntimeConfig: () => OpenClawConfig) {
  const routeCoordinator = createApprovalNativeRouteCoordinator();
  onTestFinished(() => routeCoordinator.close());
  return {
    getRuntimeConfig,
    request: vi.fn().mockResolvedValue([]),
    requestRoute: vi.fn(),
    routeCoordinator,
    subscribe: vi.fn<GatewayNativeApprovalRuntime["subscribe"]>(() => () => {}),
  };
}

type ApprovalHandlerRuntime = NonNullable<Awaited<ReturnType<typeof createTestApprovalHandler>>>;

function expectApprovalRuntime(
  runtime: Awaited<ReturnType<typeof createTestApprovalHandler>>,
): ApprovalHandlerRuntime {
  if (runtime === null) {
    throw new Error("Expected approval handler runtime");
  }
  expect(typeof runtime.handleRequested).toBe("function");
  return runtime;
}

function firstCallArg(mock: ReturnType<typeof vi.fn>): unknown {
  return mock.mock.calls[0]?.[0];
}

describe("createChannelApprovalHandlerFromCapability", () => {
  it("checks the current Gateway config before its initial subscription", async () => {
    const initial: OpenClawConfig = {};
    const next: OpenClawConfig = { gateway: { publicOrigin: "https://current.example.com" } };
    let current = initial;
    const gatewayRuntime = createApprovalGatewayRuntime(() => current);
    const capability = makeNativeApprovalCapability();
    const isConfigured = vi.fn(({ cfg }: { cfg: OpenClawConfig }) => cfg === next);
    capability.nativeRuntime!.availability.isConfigured = isConfigured;
    const runtime = expectApprovalRuntime(
      await withGatewayNativeApprovalRuntime(gatewayRuntime, () =>
        createChannelApprovalHandlerFromCapability({
          ...TEST_HANDLER_PARAMS,
          capability,
          cfg: initial,
        }),
      ),
    );
    onTestFinished(() => runtime.stop());

    current = next;
    await runtime.start();

    expect(isConfigured).toHaveBeenCalledWith(expect.objectContaining({ cfg: next }));
    expect(gatewayRuntime.subscribe).toHaveBeenCalledOnce();
  });

  it.each(["exec", "system-agent"] as const)(
    "pins an admitted %s request through delayed delivery and resolution",
    async (approvalKind) => {
      const initial: OpenClawConfig = { gateway: { publicOrigin: "https://admitted.example.com" } };
      let current = initial;
      const gatewayRuntime = createApprovalGatewayRuntime(() => current);
      const entered = createDeferred();
      const release = createDeferred();
      const deliverPending = vi.fn().mockResolvedValue({ messageId: "pinned" });
      const buildResolvedResult = vi.fn().mockResolvedValue({ kind: "leave" });
      const capability = makeNativeApprovalCapability({
        eventKinds: [approvalKind],
        deliverPending,
        buildResolvedResult,
      });
      capability.nativeRuntime!.presentation.buildPendingPayload = async ({ cfg }) => {
        entered.resolve();
        await release.promise;
        return { text: cfg.gateway?.publicOrigin };
      };
      const runtime = expectApprovalRuntime(
        await withGatewayNativeApprovalRuntime(gatewayRuntime, () =>
          createChannelApprovalHandlerFromCapability({
            ...TEST_HANDLER_PARAMS,
            capability,
            cfg: initial,
          }),
        ),
      );
      onTestFinished(async () => {
        release.resolve();
        await runtime.stop();
      });
      await runtime.start();
      const subscriber = gatewayRuntime.subscribe.mock.calls[0]?.[0];
      if (!subscriber) {
        throw new Error("Expected Gateway approval subscription");
      }
      const request =
        approvalKind === "exec"
          ? makeExecApprovalRequest("exec:admitted")
          : {
              approvalKind: "system-agent" as const,
              id: "system-agent:admitted",
              createdAtMs: Date.now(),
              expiresAtMs: Date.now() + 60_000,
              request: {
                title: "OpenClaw change",
                description: "Restart Gateway",
                command: "Restart Gateway",
                proposalHash: "a".repeat(64),
                sessionId: "test-session",
                allowedDecisions: ["allow-once", "deny"] as const,
              },
            };
      expect(subscriber.shouldHandle(request)).toBe(true);
      current = { gateway: { publicOrigin: "https://later.example.com" } };
      subscriber.onRequested(request);
      await withTestTimeout(entered.promise, 1_000, "approval presentation did not start");
      current = {};
      release.resolve();
      await vi.waitFor(() => expect(deliverPending).toHaveBeenCalledOnce());
      await runtime.handleResolved({ id: request.id, decision: "deny", ts: Date.now() });

      expect(deliverPending).toHaveBeenCalledWith(
        expect.objectContaining({
          cfg: initial,
          pendingPayload: { text: "https://admitted.example.com" },
        }),
      );
      expect(buildResolvedResult).toHaveBeenCalledWith(expect.objectContaining({ cfg: initial }));
    },
  );

  it.each(["runtime", "isolated"] as const)(
    "uses the applicable %s config for a new approval after publication",
    async (ownership) => {
      const initial: OpenClawConfig = { gateway: { publicOrigin: "https://before.example.com" } };
      const isolated: OpenClawConfig = {
        gateway: { publicOrigin: "https://isolated.example.com" },
      };
      const next: OpenClawConfig = { gateway: { publicOrigin: "https://after.example.com" } };
      let current = initial;
      const gatewayRuntime = createApprovalGatewayRuntime(() => current);
      setRuntimeConfigSnapshot(initial, initial);
      onTestFinished(clearRuntimeConfigSnapshot);
      const capability = makeNativeApprovalCapability();
      const pendingPayload = vi.fn(({ cfg }: { cfg: OpenClawConfig }) => ({
        text: `${cfg.gateway?.publicOrigin}/approve`,
      }));
      capability.nativeRuntime!.presentation.buildPendingPayload = pendingPayload;
      const runtime = expectApprovalRuntime(
        await withGatewayNativeApprovalRuntime(
          ownership === "runtime" ? gatewayRuntime : undefined,
          () =>
            createChannelApprovalHandlerFromCapability({
              ...TEST_HANDLER_PARAMS,
              capability,
              cfg: ownership === "runtime" ? initial : isolated,
            }),
        ),
      );
      onTestFinished(() => runtime.stop());

      setRuntimeConfigSnapshot(next, next);
      current = next;
      await runtime.handleRequested(makeExecApprovalRequest(`exec:${ownership}`));

      expect(pendingPayload).toHaveBeenCalledOnce();
      expect(pendingPayload.mock.results[0]?.value).toEqual({
        text: `${ownership === "runtime" ? next.gateway?.publicOrigin : isolated.gateway?.publicOrigin}/approve`,
      });
    },
  );

  it.each(["exec", "plugin"] as const)(
    "selects the new native account after %s forwarding targets hot-apply",
    async (approvalKind) => {
      const configForAccount = (accountId: string): OpenClawConfig => ({
        approvals: {
          [approvalKind]: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "test", accountId, to: "approver" }],
          },
        },
      });
      const initial = configForAccount("first");
      let current = initial;
      const gatewayRuntime = createApprovalGatewayRuntime(() => current);
      setRuntimeConfigSnapshot(initial, initial);
      onTestFinished(clearRuntimeConfigSnapshot);
      const deliveries: string[] = [];
      const runtimes = await Promise.all(
        ["first", "second"].map(async (accountId) => {
          const capability = makeNativeApprovalCapability({
            eventKinds: [approvalKind],
            shouldHandle: ({ cfg, request }) =>
              doesApprovalRequestSelectChannelAccount({
                cfg,
                request,
                channel: "test",
                accountId,
                defaultAccountId: "first",
                eligibleAccountIds: ["first", "second"],
              }),
            deliverPending: async () => {
              deliveries.push(accountId);
              return { messageId: accountId };
            },
          });
          const runtime = expectApprovalRuntime(
            await withGatewayNativeApprovalRuntime(gatewayRuntime, () =>
              createChannelApprovalHandlerFromCapability({
                ...TEST_HANDLER_PARAMS,
                cfg: initial,
                accountId,
                capability,
              }),
            ),
          );
          onTestFinished(() => runtime.stop());
          await runtime.start();
          return runtime;
        }),
      );
      const next = configForAccount("second");
      setRuntimeConfigSnapshot(next, next);
      current = next;
      const request: ExecApprovalRequest | PluginApprovalRequest = {
        ...makeExecApprovalRequest(`${approvalKind}:changed-target`),
        ...(approvalKind === "exec"
          ? { approvalKind, request: { command: "echo hi" } }
          : { approvalKind, request: { title: "Plugin action", description: "Allow action" } }),
      };
      for (const runtime of runtimes) {
        await runtime.handleRequested(request);
      }

      expect(deliveries).toEqual(["second"]);
    },
  );

  it("returns null when the capability does not expose a native runtime", async () => {
    await expect(
      createChannelApprovalHandlerFromCapability({
        capability: {},
        ...TEST_HANDLER_PARAMS,
      }),
    ).resolves.toBeNull();
  });

  it("returns a runtime when the capability exposes a native runtime", async () => {
    const runtime = await createChannelApprovalHandlerFromCapability({
      capability: {
        nativeRuntime: {
          availability: {
            isConfigured: vi.fn().mockReturnValue(true),
            shouldHandle: vi.fn().mockReturnValue(true),
          },
          presentation: {
            buildPendingPayload: vi.fn(),
            buildResolvedResult: vi.fn(),
            buildExpiredResult: vi.fn(),
          },
          transport: {
            prepareTarget: vi.fn(),
            deliverPending: vi.fn(),
          },
        },
      },
      ...TEST_HANDLER_PARAMS,
    });

    expectApprovalRuntime(runtime);
  });

  it("derives kind once before stop-time cleanup unbinds", async () => {
    const unbindPending = vi.fn();
    const shouldHandle = vi.fn().mockReturnValue(true);
    const runtime = await createTestApprovalHandler(
      makeNativeApprovalCapability({
        eventKinds: ["plugin"],
        shouldHandle,
        unbindPending,
      }),
    );

    const approvalRuntime = expectApprovalRuntime(runtime);
    const request: PluginApprovalRequest = {
      id: "custom:1",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      request: {
        title: "Plugin approval",
        description: "Allow the plugin action",
        turnSourceChannel: "test",
        turnSourceTo: "origin-chat",
      },
    };
    const normalizedRequest = { ...request, approvalKind: "plugin" as const };

    await approvalRuntime.handleRequested(request);
    expect(shouldHandle).toHaveBeenCalledWith(
      expect.objectContaining({ request: normalizedRequest, approvalKind: "plugin" }),
    );
    await approvalRuntime.stop();

    expect(unbindPending).toHaveBeenCalledOnce();
    const stopUnbind = firstCallArg(unbindPending) as
      | { request?: unknown; approvalKind?: string }
      | undefined;
    expect(stopUnbind?.request).toEqual(normalizedRequest);
    expect(stopUnbind?.approvalKind).toBe("plugin");
  });

  it("normalizes and cleans up system-agent entries through the shared lifecycle", async () => {
    const shouldHandle = vi.fn().mockReturnValue(true);
    const unbindPending = vi.fn();
    const onFinalized = vi.fn();
    const buildResolvedResult = vi.fn().mockResolvedValue({ kind: "leave" });
    const runtime = await createTestApprovalHandler(
      makeNativeApprovalCapability({
        eventKinds: ["system-agent"],
        shouldHandle,
        buildResolvedResult,
        unbindPending,
        onFinalized,
      }),
    );
    const approvalRuntime = expectApprovalRuntime(runtime);
    const request = {
      id: "system-agent:1",
      request: {
        title: "OpenClaw change",
        description: "restart the Gateway",
        command: "restart the Gateway",
        proposalHash: "a".repeat(64),
        allowedDecisions: ["allow-once", "deny"] as const,
        sessionId: "delegation-1",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    };

    await approvalRuntime.handleRequested(request);
    expect(shouldHandle).toHaveBeenCalledWith(
      expect.objectContaining({ approvalKind: "system-agent" }),
    );
    await approvalRuntime.handleResolved({
      id: request.id,
      decision: "deny",
      ts: 1,
    } as never);

    expect(unbindPending).toHaveBeenCalledWith(
      expect.objectContaining({ approvalKind: "system-agent" }),
    );
    expect(buildResolvedResult).toHaveBeenCalledOnce();
    expect(onFinalized).toHaveBeenCalledWith(
      expect.objectContaining({ approvalKind: "system-agent", phase: "resolved" }),
    );
  });

  it("honors the shipped approval kind override through the capability runtime", async () => {
    const resolveApprovalKind = vi.fn().mockReturnValue("plugin");
    const shouldHandle = vi.fn().mockReturnValue(true);
    const runtime = await createTestApprovalHandler(
      makeNativeApprovalCapability({
        eventKinds: ["plugin"],
        resolveApprovalKind,
        shouldHandle,
      }),
    );
    const approvalRuntime = expectApprovalRuntime(runtime);
    const request: PluginApprovalRequest = {
      id: "plugin:legacy-owned-id",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      request: {
        title: "Plugin approval",
        description: "Allow the plugin action",
      },
    };
    const normalizedRequest = { ...request, approvalKind: "plugin" as const };

    await approvalRuntime.handleRequested(request);

    expect(resolveApprovalKind).toHaveBeenCalledWith(normalizedRequest);
    expect(shouldHandle).toHaveBeenCalledWith(
      expect.objectContaining({ request: normalizedRequest, approvalKind: "plugin" }),
    );
    await approvalRuntime.stop();
  });

  it("ignores duplicate pending request ids before finalization", async () => {
    const unbindPending = vi.fn();
    const buildResolvedResult = vi.fn().mockResolvedValue({ kind: "leave" });
    const runtime = await createTestApprovalHandler(
      makeNativeApprovalCapability({
        buildResolvedResult,
        deliverPending: makeSequentialPendingDeliveryMock(),
        bindPending: makeSequentialPendingBindingMock(),
        unbindPending,
      }),
    );

    const approvalRuntime = expectApprovalRuntime(runtime);
    const request = makeExecApprovalRequest("exec:1");

    await approvalRuntime.handleRequested(request);
    await approvalRuntime.handleRequested(request);
    await approvalRuntime.handleResolved({
      id: "exec:1",
      decision: "approved",
      resolvedBy: "operator",
    } as never);

    expect(unbindPending).toHaveBeenCalledTimes(1);
    const unbind = firstCallArg(unbindPending) as
      | { entry?: unknown; binding?: unknown; request?: unknown }
      | undefined;
    expect(unbind?.entry).toEqual({ messageId: "1" });
    expect(unbind?.binding).toEqual({ bindingId: "bound-1" });
    expect(unbind?.request).toBe(request);
    expect(buildResolvedResult).toHaveBeenCalledTimes(1);
  });

  it("continues finalization cleanup after one resolved entry unbind failure", async () => {
    const unbindPending = vi
      .fn()
      .mockRejectedValueOnce(new Error("unbind failed"))
      .mockResolvedValueOnce(undefined);
    const buildResolvedResult = vi.fn().mockResolvedValue({ kind: "leave" });
    const runtime = await createTestApprovalHandler(
      makeNativeApprovalCapability({
        preferredSurface: "both",
        supportsApproverDmSurface: true,
        resolveApproverDmTargets: vi.fn().mockResolvedValue([{ to: "approver-dm" }]),
        buildResolvedResult,
        prepareTarget: vi.fn().mockImplementation(async ({ plannedTarget }) => ({
          dedupeKey: String(plannedTarget.target.to),
          target: { to: plannedTarget.target.to },
        })),
        deliverPending: makeSequentialPendingDeliveryMock(),
        bindPending: makeSequentialPendingBindingMock(),
        unbindPending,
      }),
    );

    const request = makeExecApprovalRequest("exec:2");

    const approvalRuntime = expectApprovalRuntime(runtime);
    await approvalRuntime.handleRequested(request);
    await expect(
      approvalRuntime.handleResolved({
        id: "exec:2",
        decision: "approved",
        resolvedBy: "operator",
      } as never),
    ).resolves.toBeUndefined();

    expect(unbindPending).toHaveBeenCalledTimes(2);
    expect(buildResolvedResult).toHaveBeenCalledTimes(1);
    const resolvedPayload = firstCallArg(buildResolvedResult) as { entry?: unknown } | undefined;
    expect(resolvedPayload?.entry).toEqual({ messageId: "2" });
  });

  it("continues stop-time unbind cleanup when one binding throws", async () => {
    const unbindPending = vi
      .fn()
      .mockRejectedValueOnce(new Error("unbind failed"))
      .mockResolvedValueOnce(undefined);
    const runtime = await createTestApprovalHandler(
      makeNativeApprovalCapability({
        deliverPending: makeSequentialPendingDeliveryMock(),
        bindPending: makeSequentialPendingBindingMock(),
        unbindPending,
      }),
    );

    const request = makeExecApprovalRequest("exec:stop-1");

    const approvalRuntime = expectApprovalRuntime(runtime);
    await approvalRuntime.handleRequested(request);
    await approvalRuntime.handleRequested({
      ...request,
      id: "exec:stop-2",
    });

    await expect(approvalRuntime.stop()).resolves.toBeUndefined();
    expect(unbindPending).toHaveBeenCalledTimes(2);
    await expect(approvalRuntime.stop()).resolves.toBeUndefined();
    expect(unbindPending).toHaveBeenCalledTimes(2);
  });
});

describe("createLazyChannelApprovalNativeRuntimeAdapter", () => {
  it("preserves the deprecated kind callback through the typed adapter factory", () => {
    const resolveApprovalKind = vi.fn().mockReturnValue("plugin");
    const adapter = createChannelApprovalNativeRuntimeAdapter({
      resolveApprovalKind,
      availability: {
        isConfigured: vi.fn().mockReturnValue(true),
        shouldHandle: vi.fn().mockReturnValue(true),
      },
      presentation: {
        buildPendingPayload: vi.fn().mockReturnValue({ text: "pending" }),
        buildResolvedResult: vi.fn().mockReturnValue({ kind: "leave" }),
        buildExpiredResult: vi.fn().mockReturnValue({ kind: "leave" }),
      },
      transport: {
        prepareTarget: vi.fn().mockReturnValue(null),
        deliverPending: vi.fn().mockReturnValue(null),
      },
    });
    const request = { id: "opaque-plugin-id" } as never;

    expect(adapter.resolveApprovalKind?.(request)).toBe("plugin");
    expect(resolveApprovalKind).toHaveBeenCalledWith(request);
  });

  it("loads the runtime lazily and reuses the loaded adapter", async () => {
    const explicitIsConfigured = vi.fn().mockReturnValue(true);
    const explicitShouldHandle = vi.fn().mockReturnValue(false);
    const resolveApprovalKind = vi.fn().mockReturnValue("exec");
    const buildPendingPayload = vi.fn().mockResolvedValue({ text: "pending" });
    const load = vi.fn().mockResolvedValue({
      availability: {
        isConfigured: vi.fn(),
        shouldHandle: vi.fn(),
      },
      presentation: {
        buildPendingPayload,
        buildResolvedResult: vi.fn(),
        buildExpiredResult: vi.fn(),
      },
      transport: {
        prepareTarget: vi.fn(),
        deliverPending: vi.fn(),
      },
    });
    const adapter = createLazyChannelApprovalNativeRuntimeAdapter({
      eventKinds: ["exec"],
      resolveApprovalKind,
      isConfigured: explicitIsConfigured,
      shouldHandle: explicitShouldHandle,
      load,
    });
    const cfg = { channels: {} } as never;
    const request = { id: "exec:1" } as never;
    const view = {} as never;

    expect(adapter.eventKinds).toEqual(["exec"]);
    expect(adapter.resolveApprovalKind?.(request)).toBe("exec");
    expect(resolveApprovalKind).toHaveBeenCalledWith(request);
    expect(adapter.availability.isConfigured({ cfg })).toBe(true);
    expect(adapter.availability.shouldHandle({ cfg, request, approvalKind: "exec" })).toBe(false);
    await expect(
      adapter.presentation.buildPendingPayload({
        cfg,
        request,
        approvalKind: "exec",
        nowMs: 1,
        view,
      }),
    ).resolves.toEqual({ text: "pending" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(explicitIsConfigured).toHaveBeenCalledWith({ cfg });
    expect(explicitShouldHandle).toHaveBeenCalledWith({ cfg, request, approvalKind: "exec" });
    expect(buildPendingPayload).toHaveBeenCalledWith({
      cfg,
      request,
      approvalKind: "exec",
      nowMs: 1,
      view,
    });
  });

  it("keeps observe hooks synchronous and only uses the already-loaded runtime", async () => {
    const onDelivered = vi.fn();
    const load = vi.fn().mockResolvedValue({
      availability: {
        isConfigured: vi.fn(),
        shouldHandle: vi.fn(),
      },
      presentation: {
        buildPendingPayload: vi.fn().mockResolvedValue({ text: "pending" }),
        buildResolvedResult: vi.fn(),
        buildExpiredResult: vi.fn(),
      },
      transport: {
        prepareTarget: vi.fn(),
        deliverPending: vi.fn(),
      },
      observe: {
        onDelivered,
      },
    });
    const adapter = createLazyChannelApprovalNativeRuntimeAdapter({
      isConfigured: vi.fn().mockReturnValue(true),
      shouldHandle: vi.fn().mockReturnValue(true),
      load,
    });

    adapter.observe?.onDelivered?.({ request: { id: "exec:1" } } as never);
    expect(load).not.toHaveBeenCalled();
    expect(onDelivered).not.toHaveBeenCalled();

    await adapter.presentation.buildPendingPayload({
      cfg: {} as never,
      request: { id: "exec:1" } as never,
      approvalKind: "exec",
      nowMs: 1,
      view: {} as never,
    });
    expect(load).toHaveBeenCalledTimes(1);

    adapter.observe?.onDelivered?.({ request: { id: "exec:1" } } as never);
    expect(onDelivered).toHaveBeenCalledWith({ request: { id: "exec:1" } });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("unbinds in-flight wrapped entry when stop() fires between bindPending and activeEntries.set", async () => {
    const bindEntered = createDeferred();
    const bindGate = createDeferred();
    const deliverPending = vi.fn().mockResolvedValue({ messageId: "in-flight" });
    const bindPending = vi.fn(async () => {
      bindEntered.resolve();
      await bindGate.promise;
      return { bindingId: "bound-in-flight" };
    });
    const unbindPending = vi.fn();

    const runtime = await createTestApprovalHandler(
      makeNativeApprovalCapability({
        deliverPending,
        bindPending,
        unbindPending,
      }),
    );
    const approvalRuntime = expectApprovalRuntime(runtime);
    const request = makeExecApprovalRequest("exec:in-flight");

    const inflight = approvalRuntime.handleRequested(request);
    await withTestTimeout(bindEntered.promise, 1_000, "in-flight approval binding did not start");

    // stop() flips the stopped flag while bindPending is parked.
    await approvalRuntime.stop();
    bindGate.resolve();
    await inflight;

    expect(unbindPending).toHaveBeenCalledTimes(1);
    const unbind = firstCallArg(unbindPending) as
      | { entry?: unknown; binding?: unknown; request?: unknown }
      | undefined;
    expect(unbind?.entry).toEqual({ messageId: "in-flight" });
    expect(unbind?.binding).toEqual({ bindingId: "bound-in-flight" });
    expect(unbind?.request).toBe(request);
  });

  it("invokes cancelDelivered when stop() fires between deliverPending and bindPending", async () => {
    const deliverEntered = createDeferred();
    const deliverGate = createDeferred();
    const deliveredEntry = { messageId: "pre-bind" };
    const deliverPending = vi.fn(async () => {
      deliverEntered.resolve();
      await deliverGate.promise;
      return deliveredEntry;
    });
    const bindPending = vi.fn().mockResolvedValue({ bindingId: "should-not-bind" });
    const unbindPending = vi.fn();
    const cancelDelivered = vi.fn();

    const runtime = await createTestApprovalHandler(
      makeNativeApprovalCapability({
        deliverPending,
        bindPending,
        unbindPending,
        cancelDelivered,
      }),
    );
    const approvalRuntime = expectApprovalRuntime(runtime);
    const request = makeExecApprovalRequest("exec:pre-bind");

    const inflight = approvalRuntime.handleRequested(request);
    await withTestTimeout(
      deliverEntered.promise,
      1_000,
      "pre-bind approval delivery did not start",
    );

    // stop() flips the stopped flag while deliverPending is still pending.
    await approvalRuntime.stop();
    deliverGate.resolve();
    await inflight;

    expect(bindPending).not.toHaveBeenCalled();
    expect(unbindPending).not.toHaveBeenCalled();
    expect(cancelDelivered).toHaveBeenCalledTimes(1);
    const cancel = firstCallArg(cancelDelivered) as
      | { entry?: unknown; request?: unknown; approvalKind?: string }
      | undefined;
    expect(cancel?.entry).toBe(deliveredEntry);
    expect(cancel?.request).toBe(request);
    expect(cancel?.approvalKind).toBe("exec");
  });

  it("invokes cancelDelivered when stop() fires after bindPending returned null", async () => {
    const bindEntered = createDeferred();
    const bindGate = createDeferred();
    const deliveredEntry = { messageId: "post-bind-null" };
    const deliverPending = vi.fn().mockResolvedValue(deliveredEntry);
    const bindPending = vi.fn(async () => {
      bindEntered.resolve();
      await bindGate.promise;
      return null;
    });
    const unbindPending = vi.fn();
    const cancelDelivered = vi.fn();

    const runtime = await createTestApprovalHandler(
      makeNativeApprovalCapability({
        deliverPending,
        bindPending,
        unbindPending,
        cancelDelivered,
      }),
    );
    const approvalRuntime = expectApprovalRuntime(runtime);
    const request = makeExecApprovalRequest("exec:post-bind-null");

    const inflight = approvalRuntime.handleRequested(request);
    await withTestTimeout(bindEntered.promise, 1_000, "null approval binding did not start");

    // stop() flips the stopped flag while bindPending is parked; it then resolves to null.
    await approvalRuntime.stop();
    bindGate.resolve();
    await inflight;

    expect(unbindPending).not.toHaveBeenCalled();
    expect(cancelDelivered).toHaveBeenCalledTimes(1);
    const cancel = firstCallArg(cancelDelivered) as
      | { entry?: unknown; request?: unknown }
      | undefined;
    expect(cancel?.entry).toBe(deliveredEntry);
    expect(cancel?.request).toBe(request);
  });
});
