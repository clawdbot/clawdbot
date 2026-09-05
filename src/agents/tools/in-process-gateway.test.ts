import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readInProcessAgentRuntimeIdentity } from "../../gateway/in-process-agent-runtime-identity.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";

const mocks = vi.hoisted(() => ({
  hasContext: true,
  dispatch: vi.fn(),
  callGateway: vi.fn(),
  callGatewayTool: vi.fn(),
}));

vi.mock("../../gateway/method-scopes.js", () => ({
  resolveLeastPrivilegeOperatorScopesForMethod: () => ["operator.write"],
}));

vi.mock("../../gateway/server-plugins.js", () => ({
  dispatchGatewayMethodInProcess: mocks.dispatch,
  getInProcessGatewayRequestContext: vi.fn(),
  runWithOperatorToolGatewayCleanupContext: <T>(run: () => T) => run(),
  hasInProcessGatewayContext: (resolveGatewayContext?: () => GatewayRequestContext | undefined) =>
    Boolean(resolveGatewayContext?.() ?? mocks.hasContext),
}));

vi.mock("./gateway.js", () => ({ callGatewayTool: mocks.callGatewayTool }));
vi.mock("../../gateway/call.js", () => ({ callGateway: mocks.callGateway }));

import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { getGatewaySessionSpawnContext } from "./gateway-session-spawn-context.js";
import {
  callAgentToolGatewayRequest,
  callInProcessGatewayTool,
  callInProcessGatewayToolWithCreation,
  withAgentToolGatewayRuntimeIdentity,
} from "./in-process-gateway.js";

describe("trusted in-process Gateway session creation", () => {
  beforeEach(() => {
    mocks.hasContext = true;
    mocks.dispatch.mockReset().mockResolvedValue({ key: "agent:main:dashboard:child" });
    mocks.callGateway.mockReset().mockResolvedValue({ status: "ok" });
    mocks.callGatewayTool.mockReset().mockResolvedValue({ key: "agent:main:dashboard:child" });
  });

  it("surfaces creation provenance only on in-process dispatch", async () => {
    const creation = {
      via: "spawn" as const,
      actor: { type: "agent" as const, id: "main" },
      requesterSessionKey: "agent:main:main",
    };
    await callInProcessGatewayToolWithCreation("sessions.create", { agentId: "main" }, creation);

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "sessions.create",
      { agentId: "main" },
      {
        forceSyntheticClient: true,
        operatorRoleActor: { kind: "system" },
        sessionCreation: creation,
        syntheticScopes: ["operator.write"],
      },
    );
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();

    mocks.hasContext = false;
    await callInProcessGatewayToolWithCreation("sessions.create", { agentId: "main" }, creation);

    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "sessions.create",
      {},
      { agentId: "main" },
      { scopes: ["operator.write"] },
    );
  });

  it("uses an explicitly bound Gateway when worker creation has no ambient request scope", async () => {
    mocks.hasContext = false;
    const admitted = {} as GatewayRequestContext;
    const resolveGatewayContext = () => admitted;
    const sessionMutationCommitGuard = vi.fn();
    const creation = {
      via: "spawn" as const,
      actor: { type: "agent" as const, id: "main" },
      requesterSessionKey: "agent:main:dashboard:worker",
      inheritedToolPolicy: { version: 1 as const, allow: ["sessions_spawn"], deny: [] },
    };

    await callInProcessGatewayToolWithCreation("sessions.create", { agentId: "main" }, creation, {
      resolveGatewayContext,
      sessionMutationCommitGuard,
    });

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "sessions.create",
      { agentId: "main" },
      expect.objectContaining({
        resolveGatewayContext: expect.any(Function),
        sessionMutationCommitGuard,
        sessionCreation: creation,
      }),
    );
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("carries visible-spawn policy through signed identity on fallback dispatch", async () => {
    mocks.hasContext = false;
    const inheritedToolPolicy = {
      version: 1 as const,
      allow: ["read", "sessions_spawn"],
      deny: ["exec"],
    };

    mocks.callGatewayTool.mockImplementationOnce(async () => {
      expect(getGatewaySessionSpawnContext()).toEqual({
        completionOwnerSessionKey: "agent:main:discord:direct:alice",
        inheritedToolPolicy,
      });
      return { key: "agent:main:dashboard:child" };
    });

    await callInProcessGatewayToolWithCreation(
      "sessions.create",
      { agentId: "main", parentSessionKey: "agent:main:main", spawnDepth: 1 },
      {
        via: "spawn",
        actor: { type: "agent", id: "main" },
        requesterSessionKey: "agent:main:main",
        completionOwnerSessionKey: "agent:main:discord:direct:alice",
        inheritedToolPolicy,
      },
    );

    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "sessions.create",
      {},
      { agentId: "main", parentSessionKey: "agent:main:main", spawnDepth: 1 },
      {
        scopes: ["operator.write"],
        requireAgentRuntimeIdentity: true,
      },
    );
    expect(getGatewaySessionSpawnContext()).toBeUndefined();
  });

  it("keeps session creation on the admitted Gateway through async settlement", async () => {
    const admitted = { gateway: "admitted" } as unknown as GatewayRequestContext;
    const replacement = { gateway: "replacement" } as unknown as GatewayRequestContext;
    const params = { agentId: "main", label: "worker" };
    const creation = {
      via: "spawn" as const,
      actor: { type: "agent" as const, id: "main" },
      requesterSessionKey: "agent:main:main",
    };
    const controller = new AbortController();
    let current = admitted;
    let admittedDispatches = 0;
    let replacementDispatches = 0;
    const dispatchThroughSelectedGateway = (
      options:
        | {
            resolveGatewayContext?: () => GatewayRequestContext | undefined;
            sessionCreation?: unknown;
            signal?: AbortSignal;
            syntheticScopes?: string[];
            timeoutMs?: number;
          }
        | undefined,
    ) => {
      const selected = options?.resolveGatewayContext?.() ?? replacement;
      if (selected === admitted) {
        admittedDispatches += 1;
      } else if (selected === replacement) {
        replacementDispatches += 1;
      }
      return selected;
    };
    const runAsAdmittedCaller = async <T>(run: () => Promise<T>) =>
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          gatewayContextResolver: () => current,
        },
        run,
      );

    mocks.dispatch.mockImplementationOnce(async (_method, _params, options) => {
      expect(dispatchThroughSelectedGateway(options)).toBe(admitted);
      expect(options).toEqual({
        forceSyntheticClient: true,
        operatorRoleActor: { kind: "system" },
        resolveGatewayContext: expect.any(Function),
        sessionCreation: creation,
        signal: controller.signal,
        syntheticScopes: ["operator.write"],
        timeoutMs: 2_000,
      });
      return { key: "agent:main:worker" };
    });

    await expect(
      runAsAdmittedCaller(() =>
        callInProcessGatewayToolWithCreation("sessions.create", params, creation, {
          signal: controller.signal,
          timeoutMs: 2_000,
        }),
      ),
    ).resolves.toEqual({ key: "agent:main:worker" });
    expect(mocks.dispatch).toHaveBeenLastCalledWith("sessions.create", params, expect.any(Object));
    expect({ admittedDispatches, replacementDispatches }).toEqual({
      admittedDispatches: 1,
      replacementDispatches: 0,
    });

    current = admitted;
    const dispatchesBeforeReplacement = mocks.dispatch.mock.calls.length;
    await expect(
      runAsAdmittedCaller(async () => {
        current = replacement;
        return await callInProcessGatewayToolWithCreation("sessions.create", params, creation);
      }),
    ).rejects.toThrow("Gateway instance unavailable for sessions.create");
    expect(mocks.dispatch).toHaveBeenCalledTimes(dispatchesBeforeReplacement);
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
    expect(replacementDispatches).toBe(0);

    for (const settlement of ["resolve", "reject"] as const) {
      current = admitted;
      const pendingDispatch = createDeferred<{ key: string }>();
      mocks.dispatch.mockImplementationOnce(async (_method, _params, options) => {
        expect(dispatchThroughSelectedGateway(options)).toBe(admitted);
        return await pendingDispatch.promise;
      });

      const expectedDispatchCount = mocks.dispatch.mock.calls.length + 1;
      const creationCall = runAsAdmittedCaller(() =>
        callInProcessGatewayToolWithCreation("sessions.create", params, creation),
      );
      await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(expectedDispatchCount));
      current = replacement;
      if (settlement === "resolve") {
        pendingDispatch.resolve({ key: "agent:main:worker" });
      } else {
        pendingDispatch.reject(new Error("inner dispatch failed"));
      }
      await expect(creationCall).rejects.toThrow(
        "Gateway instance unavailable for sessions.create",
      );
      expect(replacementDispatches).toBe(0);
    }
  });

  it("retains the generic helper's admitted binding and transport fallback", async () => {
    const admitted = { gateway: "admitted" } as unknown as GatewayRequestContext;
    const replacement = { gateway: "replacement" } as unknown as GatewayRequestContext;
    let current = admitted;
    mocks.dispatch.mockImplementationOnce(async (_method, _params, options) => ({
      selected: options?.resolveGatewayContext?.() ?? replacement,
    }));

    await expect(
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          gatewayContextResolver: () => current,
        },
        () => callInProcessGatewayTool("sessions.list", {}),
      ),
    ).resolves.toEqual({ selected: admitted });

    current = admitted;
    await expect(
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          gatewayContextResolver: () => current,
        },
        async () => {
          current = replacement;
          return await callInProcessGatewayTool("sessions.list", {});
        },
      ),
    ).rejects.toThrow("Gateway instance unavailable for sessions.list");

    mocks.hasContext = false;
    const signal = new AbortController().signal;
    await callInProcessGatewayTool("sessions.list", { limit: 5 }, { timeoutMs: 120_000, signal });
    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "sessions.list",
      { timeoutMs: 120_000 },
      { limit: 5 },
      { scopes: ["operator.write"], signal },
    );
  });
});

describe("request-shaped in-process Gateway dispatch", () => {
  beforeEach(() => {
    mocks.hasContext = true;
    mocks.dispatch.mockReset().mockResolvedValue({ runId: "run-1" });
    mocks.callGateway.mockReset().mockResolvedValue({ runId: "run-1" });
  });

  it("uses the local router with least privilege and transport-equivalent request options", async () => {
    const controller = new AbortController();
    const onAccepted = vi.fn();
    const agentToolCaller = {
      agentId: "main",
      sessionKey: "agent:main:discord:direct:colin",
    };

    await callAgentToolGatewayRequest({
      method: "agent",
      params: { sessionKey: "agent:main:worker", message: "run" },
      agentToolCaller,
      expectFinal: true,
      onAccepted,
      signal: controller.signal,
    });

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "agent",
      { sessionKey: "agent:main:worker", message: "run" },
      {
        forceSyntheticClient: true,
        operatorRoleActor: { kind: "system" },
        agentToolCaller,
        syntheticScopes: ["operator.write"],
        expectFinal: true,
        onAccepted,
        signal: controller.signal,
        timeoutMs: 10_000,
      },
    );
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("carries trusted runtime identity only through the private in-process carrier", async () => {
    const identity = {
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "agent:main:worker",
      operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
      delegatedAuthority: {
        kind: "local",
        lifecycleGeneration: "generation-1",
        claimId: "claim-1",
        operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
      },
    } as const;
    const request = withAgentToolGatewayRuntimeIdentity(
      { method: "chat.send", params: { sessionKey: "agent:main:child" } },
      identity,
    );
    mocks.dispatch.mockImplementationOnce(async (_method, _params, options) => {
      expect(readInProcessAgentRuntimeIdentity(options)).toBe(identity);
      return { runId: "run-1" };
    });

    await callAgentToolGatewayRequest(request);

    expect(JSON.stringify(request)).toBe(
      '{"method":"chat.send","params":{"sessionKey":"agent:main:child"}}',
    );
  });

  it.each([
    [null, undefined],
    [0, 0],
    [25_000, 25_000],
  ] as const)("maps timeout %s to the local dispatch deadline", async (timeoutMs, expected) => {
    await callAgentToolGatewayRequest({ method: "sessions.list", timeoutMs });

    const options = mocks.dispatch.mock.calls[0]?.[2] as { timeoutMs?: number } | undefined;
    expect(options?.timeoutMs).toBe(expected);
  });

  it("routes abort cleanup through the same local caller", async () => {
    mocks.dispatch.mockImplementation(
      async (
        method: string,
        _params: unknown,
        options?: { onSignalAbort?: () => Promise<void> },
      ) => {
        if (method === "conversations.turn.cancel") {
          return { status: "ok" };
        }
        await options?.onSignalAbort?.();
        throw new Error("primary aborted");
      },
    );

    await expect(
      callAgentToolGatewayRequest({
        method: "conversations.turn",
        params: { turnId: "turn-1" },
        onSignalAbort: async (request) => {
          await request("conversations.turn.cancel", { turnId: "turn-1" });
        },
      }),
    ).rejects.toThrow("primary aborted");
    expect(mocks.dispatch.mock.calls).toContainEqual([
      "conversations.turn.cancel",
      { turnId: "turn-1" },
      expect.objectContaining({ forceSyntheticClient: true }),
    ]);
    expect(
      mocks.dispatch.mock.calls.filter(([method]) => method === "conversations.turn.cancel"),
    ).toHaveLength(1);
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("does not route abort cleanup through a replacement Gateway", async () => {
    const admitted = {} as GatewayRequestContext;
    const replacement = {} as GatewayRequestContext;
    let current = admitted;
    let cancelDispatches = 0;
    mocks.dispatch.mockImplementation(
      async (
        method: string,
        _params: unknown,
        options?: { onSignalAbort?: () => Promise<void> },
      ) => {
        if (method === "conversations.turn.cancel") {
          cancelDispatches += 1;
          return { status: "ok" };
        }
        current = replacement;
        await options?.onSignalAbort?.();
        throw new Error("primary aborted");
      },
    );

    await expect(
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          gatewayContextResolver: () => current,
        },
        async () =>
          await callAgentToolGatewayRequest({
            method: "conversations.turn",
            params: { turnId: "turn-1" },
            onSignalAbort: async (request) => {
              await request("conversations.turn.cancel", { turnId: "turn-1" });
            },
          }),
      ),
    ).rejects.toThrow(/Gateway|gateway|unavailable/u);
    expect(cancelDispatches).toBe(0);
  });

  it("falls back to the original Gateway request outside the Gateway process", async () => {
    mocks.hasContext = false;
    const request = {
      method: "sessions.list",
      params: { limit: 5 },
      timeoutMs: 2_000,
      agentRunTracking: "native_subagent",
      agentToolCaller: {
        agentId: "main",
        sessionKey: "agent:main:discord:direct:colin",
      },
    } as const;

    await callAgentToolGatewayRequest(request);

    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "sessions.list",
      params: { limit: 5 },
      timeoutMs: 2_000,
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("does not drop a private runtime identity onto the transport fallback", async () => {
    mocks.hasContext = false;
    const request = withAgentToolGatewayRuntimeIdentity(
      { method: "chat.send", params: { sessionKey: "agent:main:child" } },
      {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:worker",
        operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
        delegatedAuthority: {
          kind: "local",
          lifecycleGeneration: "generation-1",
          claimId: "claim-1",
          operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
        },
      },
    );

    await expect(callAgentToolGatewayRequest(request)).rejects.toThrow(
      "trusted agent runtime identity requires in-process Gateway dispatch",
    );
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });
});

describe("built-in Gateway foreground authority", () => {
  beforeEach(() => {
    mocks.hasContext = true;
    mocks.dispatch.mockReset().mockResolvedValue({ ok: true });
    mocks.callGateway.mockReset();
    mocks.callGatewayTool.mockReset();
  });

  const callers = [
    {
      name: "request-shaped",
      call: () =>
        callAgentToolGatewayRequest({
          method: "sessions.patch",
          params: { key: "target", pinned: true },
        }),
    },
    {
      name: "generic",
      call: () => callInProcessGatewayTool("sessions.patch", { key: "target", pinned: true }),
    },
  ];

  it.each(callers)(
    "rejects retained $name work after its exact caller closes",
    async ({ call }) => {
      let current = true;
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:caller",
          operationalRunInstance: { instanceId: "caller-instance", runId: "caller-run" },
          receiptAuthority: () => current,
        },
        async () => {
          current = false;
          await expect(call()).rejects.toThrow(/authority.*no longer active/i);
        },
      );
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(mocks.callGateway).not.toHaveBeenCalled();
      expect(mocks.callGatewayTool).not.toHaveBeenCalled();
    },
  );

  it.each(callers)(
    "rechecks $name caller authority at the mutation commit boundary",
    async ({ call }) => {
      const entered = createDeferred();
      const release = createDeferred();
      let current = true;
      let committed = false;
      mocks.dispatch.mockImplementation(async (_method, _params, options) => {
        entered.resolve();
        await release.promise;
        options.sessionMutationCommitGuard?.();
        committed = true;
        return { ok: true };
      });
      const pending = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:caller",
          operationalRunInstance: { instanceId: "caller-instance", runId: "caller-run" },
          receiptAuthority: () => current,
        },
        call,
      );
      const rejected = expect(pending).rejects.toThrow(/authority.*no longer active/i);
      await entered.promise;
      current = false;
      release.resolve();
      await rejected;
      expect(committed).toBe(false);
    },
  );

  it("lets host-owned abort cleanup settle without reopening the closed foreground caller", async () => {
    const context = {} as GatewayRequestContext;
    const controller = new AbortController();
    let current = true;
    let cancelled = false;
    mocks.dispatch.mockImplementation(async (method, _params, options) => {
      if (method === "conversations.turn.cancel") {
        expect(options.resolveGatewayContext()).toBe(context);
        expect(readInProcessAgentRuntimeIdentity(options)).toBeUndefined();
        cancelled = true;
        return { ok: true };
      }
      current = false;
      controller.abort();
      await options.onSignalAbort();
      throw new Error("primary aborted");
    });
    await expect(
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:caller",
          operationalRunInstance: { instanceId: "caller-instance", runId: "caller-run" },
          receiptAuthority: () => current,
          approvalSignals: [controller.signal],
          gatewayContextResolver: () => context,
        },
        () =>
          callAgentToolGatewayRequest({
            method: "conversations.turn",
            params: { turnId: "owned-turn" },
            signal: controller.signal,
            onSignalAbort: async (request) => {
              await request("conversations.turn.cancel", { turnId: "owned-turn" });
            },
          }),
      ),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(mocks.dispatch.mock.calls.map(([method]) => method)).toEqual([
      "conversations.turn",
      "conversations.turn.cancel",
    ]);
  });
});
