import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createInternalAgentTurnFacade } from "./agent-turn/internal-facade.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { resolveNodeInvokeRuntimeAuthorityError } from "./server-methods/nodes.invoke-authority.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestOptions,
} from "./server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";

const startTurn = vi.hoisted(() => vi.fn());
const waitForTurn = vi.hoisted(() => vi.fn());

vi.mock("./agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({
    startTurn,
    waitForTurn,
  }),
}));

function createContext(): GatewayRequestContext {
  const context = {
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    logGateway: { error: vi.fn(), warn: vi.fn() },
  } as unknown as GatewayRequestContext;
  context.createAgentTurnFacade = (principal) =>
    createInternalAgentTurnFacade({
      ...principal,
      getContext: () => context,
      ...(context.getGatewayMethodRegistry
        ? { getMethodRegistry: context.getGatewayMethodRegistry }
        : {}),
    });
  return context;
}

function createOperatorClient(params: {
  caps?: string[];
  profileId: string;
  scopes: string[];
}): NonNullable<GatewayRequestOptions["client"]> {
  return {
    connId: `conn-${params.profileId}`,
    authenticatedUserId: `${params.profileId}@example.com`,
    authenticatedUserProfile: {
      profileId: params.profileId,
      displayName: params.profileId,
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: {
      ...(params.caps ? { caps: params.caps } : {}),
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      role: "operator",
      scopes: params.scopes,
      client: {
        id: GATEWAY_CLIENT_IDS.TEST,
        version: "1",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.TEST,
      },
    },
  };
}

async function dispatchScopedAgent(params: {
  client: NonNullable<GatewayRequestOptions["client"]>;
  context: GatewayRequestContext;
  sessionKey?: string;
}) {
  return await dispatchScopedMethod({
    client: params.client,
    context: params.context,
    method: "agent",
    params: {
      message: "authorization probe",
      idempotencyKey: "authorization-probe",
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    },
  });
}

async function dispatchScopedMethod(params: {
  client: NonNullable<GatewayRequestOptions["client"]>;
  context: GatewayRequestContext;
  method: "agent" | "agent.wait";
  params: Record<string, unknown>;
  signal?: AbortSignal;
}) {
  return await withPluginRuntimeGatewayRequestScope(
    {
      client: params.client,
      context: params.context,
      isWebchatConnect: () => false,
    },
    async () =>
      await dispatchGatewayMethodInProcess(params.method, params.params, {
        disableSyntheticClient: true,
        requireScopedClient: true,
        ...(params.signal ? { signal: params.signal } : {}),
      }),
  );
}

describe("typed in-process agent authorization", () => {
  beforeEach(() => {
    startTurn.mockReset();
    waitForTurn.mockReset();
  });

  it.each([
    ["agent", { message: "owned turn", idempotencyKey: "host-owned" }],
    ["agent.wait", { runId: "host-owned" }],
  ] as const)(
    "uses the captured host factory for %s and refuses an ownerless context",
    async (method, params) => {
      const client = createOperatorClient({ profileId: "owner", scopes: ["operator.write"] });
      const context = createContext();
      const createFacade = vi.fn(context.createAgentTurnFacade!);
      context.createAgentTurnFacade = createFacade;
      const result = { runId: "host-owned", status: "ok" };
      startTurn.mockImplementation(async ({ io }) => io.emitAcceptance([true, result, undefined]));
      waitForTurn.mockResolvedValue(result);

      await expect(dispatchScopedMethod({ client, context, method, params })).resolves.toEqual(
        result,
      );
      expect(createFacade).toHaveBeenCalledOnce();
      expect(createFacade.mock.calls[0]?.[0].client).toBe(client);

      delete context.createAgentTurnFacade;
      await expect(dispatchScopedMethod({ client, context, method, params })).rejects.toThrow(
        "Gateway instance agent turn facade unavailable",
      );
    },
  );

  it.each([
    ["agent", { message: "retired turn", idempotencyKey: "retired-host" }],
    ["agent.wait", { runId: "retired-host" }],
  ] as const)(
    "revalidates the captured host after awaiting its %s factory",
    async (method, params) => {
      const context = createContext();
      let current = context;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const createFacade = context.createAgentTurnFacade!;
      context.createAgentTurnFacade = async (principal) => {
        entered.resolve();
        await release.promise;
        return createFacade(principal);
      };

      const pending = dispatchGatewayMethodInProcess(method, params, {
        forceSyntheticClient: true,
        operatorRoleActor: { kind: "system" },
        resolveGatewayContext: () => current,
      });
      const rejected = expect(pending).rejects.toThrow("current gateway instance binding");
      await entered.promise;
      current = createContext();
      release.resolve();

      await rejected;
      expect(startTurn).not.toHaveBeenCalled();
      expect(waitForTurn).not.toHaveBeenCalled();
    },
  );

  it("preserves verified operator identity and never widens a synthetic tool caller's scopes", async () => {
    const owner = createOperatorClient({
      profileId: "tool-owner",
      scopes: ["operator.read"],
    });
    let dispatched: GatewayRequestOptions["client"] = null;
    const context = createContext();
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: "sessions.list",
          scope: "operator.read",
          owner: { kind: "core", area: "sessions" },
          handler: ({ client, respond }: GatewayRequestHandlerOptions) => {
            dispatched = client;
            respond(true, { sessions: [] });
          },
        },
      ]);

    await withOperatorToolGatewayAuthority(
      {
        authenticatedUserProfile: owner.authenticatedUserProfile!,
        scopes: owner.connect.scopes ?? [],
      },
      async () =>
        await dispatchGatewayMethodInProcess(
          "sessions.list",
          {},
          {
            forceSyntheticClient: true,
            syntheticScopes: ["operator.read", "operator.admin"],
            resolveGatewayContext: () => context,
          },
        ),
    );

    expect(dispatched).toMatchObject({
      authenticatedUserProfile: { profileId: "tool-owner" },
      connect: { scopes: ["operator.read"] },
      internal: { syntheticClient: true },
    });
  });

  it.each(["explicit", "scoped"])(
    "does not fall back to ambient scope when a %s Gateway binding is retired",
    async (binding) => {
      const ambient = createContext();
      ambient.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: "sessions.list",
            scope: "operator.read",
            owner: { kind: "core", area: "sessions" },
            handler: ({ respond }: GatewayRequestHandlerOptions) => {
              respond(true, { sessions: [] });
            },
          },
        ]);

      await withPluginRuntimeGatewayRequestScope(
        {
          context: ambient,
          ...(binding === "scoped" ? { resolveGatewayContext: () => undefined } : {}),
          isWebchatConnect: () => false,
        },
        async () =>
          await expect(
            dispatchGatewayMethodInProcess(
              "sessions.list",
              {},
              {
                forceSyntheticClient: true,
                ...(binding === "explicit" ? { resolveGatewayContext: () => undefined } : {}),
                syntheticScopes: ["operator.read"],
              },
            ),
          ).rejects.toThrow("instance binding"),
      );
    },
  );

  it.each(["explicit", "scoped"])(
    "carries a %s Gateway binding into the session mutation commit guard",
    async (binding) => {
      const admitted = createContext();
      const replacement = createContext();
      let current = admitted;
      let committed = false;
      const setupStarted = createDeferredCore();
      const releaseSetup = createDeferredCore();
      admitted.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: "sessions.create",
            scope: "operator.write",
            owner: { kind: "core", area: "sessions" },
            handler: async ({
              respond,
              sessionMutationCommitGuard,
            }: GatewayRequestHandlerOptions) => {
              setupStarted.resolve();
              await releaseSetup.promise;
              sessionMutationCommitGuard?.();
              committed = true;
              respond(true, { key: "agent:main:dashboard:child" });
            },
          },
        ]);

      const dispatch = withPluginRuntimeGatewayRequestScope(
        {
          context: admitted,
          isWebchatConnect: () => false,
          ...(binding === "scoped" ? { resolveGatewayContext: () => current } : {}),
        },
        () =>
          dispatchGatewayMethodInProcess(
            "sessions.create",
            { agentId: "main" },
            {
              forceSyntheticClient: true,
              ...(binding === "explicit" ? { resolveGatewayContext: () => current } : {}),
              syntheticScopes: ["operator.write"],
            },
          ),
      );
      await setupStarted.promise;
      current = replacement;
      releaseSetup.resolve();

      await expect(dispatch).rejects.toThrow("current gateway instance binding");
      expect(committed).toBe(false);
    },
  );

  it("composes caller authority into the session mutation commit guard", async () => {
    const admitted = createContext();
    const assertCallerCurrent = vi.fn();
    admitted.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: "sessions.create",
          scope: "operator.write",
          owner: { kind: "core", area: "sessions" },
          handler: ({ respond, sessionMutationCommitGuard }: GatewayRequestHandlerOptions) => {
            sessionMutationCommitGuard?.();
            respond(true, { key: "agent:main:dashboard:child" });
          },
        },
      ]);

    await dispatchGatewayMethodInProcess(
      "sessions.create",
      { agentId: "main" },
      {
        forceSyntheticClient: true,
        resolveGatewayContext: () => admitted,
        sessionMutationCommitGuard: assertCallerCurrent,
        syntheticScopes: ["operator.write"],
      },
    );

    expect(assertCallerCurrent).toHaveBeenCalledOnce();
  });

  it("preserves the scoped operator identity across synthetic model-initiated session creation", async () => {
    const owner = createOperatorClient({
      profileId: "model-spawn-owner",
      scopes: ["operator.write"],
    });
    let dispatched: GatewayRequestOptions["client"] = null;
    const context = createContext();
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: "sessions.create",
          scope: "operator.write",
          owner: { kind: "core", area: "sessions" },
          handler: ({ client, respond }: GatewayRequestHandlerOptions) => {
            dispatched = client;
            respond(true, { key: "agent:guest:dashboard:child" });
          },
        },
      ]);

    await withPluginRuntimeGatewayRequestScope(
      {
        client: owner,
        context,
        isWebchatConnect: () => false,
      },
      async () =>
        await dispatchGatewayMethodInProcess(
          "sessions.create",
          { agentId: "guest" },
          {
            forceSyntheticClient: true,
            syntheticScopes: ["operator.write", "operator.admin"],
            sessionCreation: {
              via: "spawn",
              actor: { type: "agent", id: "main" },
              requesterSessionKey: "agent:main:main",
            },
          },
        ),
    );

    expect(dispatched).toMatchObject({
      authenticatedUserProfile: { profileId: "model-spawn-owner" },
      connect: { scopes: ["operator.write"] },
      internal: { syntheticClient: true },
    });
  });

  it("rejects retained tool authority after its owning invocation has completed", async () => {
    const owner = createOperatorClient({ profileId: "expired-owner", scopes: ["operator.read"] });
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    let retained: Promise<unknown> | undefined;

    await withOperatorToolGatewayAuthority(
      {
        authenticatedUserProfile: owner.authenticatedUserProfile!,
        scopes: owner.connect.scopes ?? [],
      },
      async () => {
        retained = dispatchGate.then(
          async () =>
            await dispatchGatewayMethodInProcess(
              "sessions.list",
              {},
              { forceSyntheticClient: true, resolveGatewayContext: createContext },
            ),
        );
      },
    );
    releaseDispatch();

    await expect(retained).rejects.toThrow("operator tool invocation authority expired");
  });

  it("keeps a spawned agent host-owned and clears human authority before autonomous work", async () => {
    const owner = createOperatorClient({
      profileId: "spawn-owner",
      scopes: ["operator.write"],
    });
    const context = createContext();
    let autonomousClient: GatewayRequestOptions["client"] = null;
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: "sessions.list",
          scope: "operator.write",
          owner: { kind: "core", area: "sessions" },
          handler: ({ client, respond }: GatewayRequestHandlerOptions) => {
            autonomousClient = client;
            respond(true, { sessions: [] });
          },
        },
      ]);
    startTurn.mockImplementation(async ({ principal, io }) => {
      expect(principal.authenticatedUserProfile).toBeUndefined();
      expect(principal.internal).toMatchObject({
        operatorRoleActor: { kind: "operator", profileId: "spawn-owner" },
      });
      await dispatchGatewayMethodInProcess(
        "sessions.list",
        {},
        { forceSyntheticClient: true, resolveGatewayContext: () => context },
      );
      io.emitAcceptance([true, { runId: "autonomous-run", status: "accepted" }, undefined]);
    });

    await withOperatorToolGatewayAuthority(
      {
        authenticatedUserProfile: owner.authenticatedUserProfile!,
        scopes: owner.connect.scopes ?? [],
      },
      async () =>
        await dispatchGatewayMethodInProcess(
          "agent",
          { message: "run child", idempotencyKey: "autonomous-run" },
          {
            forceSyntheticClient: true,
            agentRunTracking: "native_subagent",
            syntheticScopes: ["operator.write"],
            resolveGatewayContext: () => context,
          },
        ),
    );

    expect(autonomousClient).toMatchObject({
      connect: { scopes: ["operator.write"] },
      internal: { operatorRoleActor: { kind: "operator", profileId: "spawn-owner" } },
    });
    expect(autonomousClient).not.toHaveProperty("authenticatedUserProfile");
  });

  it("explicitly marks profile-less host-owned agent launches as system actors", async () => {
    const context = createContext();
    startTurn.mockImplementation(async ({ principal, io }) => {
      expect(principal.authenticatedUserProfile).toBeUndefined();
      expect(principal.internal).toMatchObject({ operatorRoleActor: { kind: "system" } });
      io.emitAcceptance([true, { runId: "system-run", status: "accepted" }, undefined]);
    });

    await dispatchGatewayMethodInProcess(
      "agent",
      { message: "run child", idempotencyKey: "system-run" },
      {
        forceSyntheticClient: true,
        agentRunTracking: "native_subagent",
        syntheticScopes: ["operator.write"],
        resolveGatewayContext: () => context,
      },
    );
  });

  it("rejects tracked agent launches when a scoped operator identity was dropped", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const unidentifiedClient = createOperatorClient({
        profileId: "dropped-spawn-owner",
        scopes: ["operator.write"],
      });
      delete unidentifiedClient.authenticatedUserProfile;
      const context = createContext();
      context.getRuntimeConfig = () => ({
        gateway: {
          roles: {
            default: "limited",
            definitions: {
              limited: {
                agents: ["guest"],
                scopes: ["operator.write"],
                sessions: { others: "none" },
              },
            },
          },
        },
      });
      const foreignSessionKey = "agent:maintainer:main";
      await upsertSessionEntryCore(
        {
          agentId: "maintainer",
          sessionKey: foreignSessionKey,
        },
        {
          sessionId: "maintainer-session",
          updatedAt: 1,
          visibility: "shared",
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: "maintainer" },
        },
      );

      await expect(
        withPluginRuntimeGatewayRequestScope(
          {
            client: unidentifiedClient,
            context,
            isWebchatConnect: () => false,
          },
          async () =>
            await dispatchGatewayMethodInProcess(
              "agent",
              {
                message: "run forbidden child",
                sessionKey: foreignSessionKey,
                idempotencyKey: "dropped-spawn-owner",
              },
              {
                forceSyntheticClient: true,
                agentRunTracking: "native_subagent",
                operatorRoleActor: { kind: "system" },
                syntheticScopes: ["operator.write"],
              },
            ),
        ),
      ).rejects.toThrow(/scope|role|operator/i);
      expect(startTurn).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      name: "non-synthetic client",
      method: "node.invoke",
      options: { pluginRuntimeOwnerId: "duplex-fixture" },
    },
    {
      name: "ownerless synthetic client",
      method: "node.invoke",
      options: { forceSyntheticClient: true },
    },
    {
      name: "different gateway method",
      method: "node.list",
      options: { forceSyntheticClient: true, pluginRuntimeOwnerId: "duplex-fixture" },
    },
  ])("rejects node duplex hooks on an $name", async ({ method, options }) => {
    const onDispatchReady = vi.fn();

    await expect(
      dispatchGatewayMethodInProcess(
        method,
        {},
        {
          ...options,
          nodeInvokeStream: {
            onProgress: vi.fn(),
            onDispatchReady,
            isRuntimeCurrent: () => true,
          },
          resolveGatewayContext: createContext,
        },
      ),
    ).rejects.toThrow("owner-bound trusted synthetic client");

    expect(onDispatchReady).not.toHaveBeenCalled();
  });

  it("retains the authenticated caller and its closure-bound authority for node duplex", async () => {
    const client = createOperatorClient({
      profileId: "duplex-owner",
      scopes: ["operator.write", "operator.approvals"],
    });
    const operationalRunInstance = createOperationalRunInstanceRef("duplex-owned-run");
    const agentRuntimeIdentity = {
      kind: "agentRuntime" as const,
      agentId: "main",
      sessionKey: "agent:main:duplex-owner",
      operationalRunInstance,
      delegatedAuthority: {
        kind: "local" as const,
        operationalRunInstance,
        lifecycleGeneration: "duplex-generation",
        claimId: "duplex-claim",
      },
    };
    client.isDeviceTokenAuth = true;
    client.internal = {
      agentRuntimeIdentity,
      approvalRuntime: true,
      senderAttribution: { id: "duplex-sender" },
    };
    let authorityCurrent = true;
    const dispatched: { client: GatewayRequestOptions["client"] } = { client: null };
    const context = createContext();
    context.validateAgentRuntimeApprovalAuthority = (identity) =>
      authorityCurrent && identity === agentRuntimeIdentity;
    const methodRegistry = createGatewayMethodRegistry([
      {
        name: "node.invoke",
        scope: "operator.write",
        owner: { kind: "core", area: "nodes" },
        handler: ({ client: resolvedClient, respond }: GatewayRequestHandlerOptions) => {
          dispatched.client = resolvedClient;
          respond(true, { ok: true });
        },
      },
    ]);
    context.getGatewayMethodRegistry = () => methodRegistry;

    await withPluginRuntimeGatewayRequestScope(
      { client, context, isWebchatConnect: () => false },
      async () =>
        await dispatchGatewayMethodInProcess(
          "node.invoke",
          {},
          {
            forceSyntheticClient: true,
            pluginRuntimeOwnerId: "duplex-fixture",
            syntheticScopes: ["operator.write", "operator.approvals"],
            nodeInvokeStream: {
              onProgress: vi.fn(),
              onDispatchReady: vi.fn(),
              isRuntimeCurrent: () => true,
            },
          },
        ),
    );

    expect(dispatched.client).toMatchObject({
      connId: "conn-duplex-owner",
      authenticatedUserId: "duplex-owner@example.com",
      authenticatedUserProfile: { profileId: "duplex-owner" },
      isDeviceTokenAuth: true,
      connect: { scopes: ["operator.write", "operator.approvals"] },
      internal: {
        syntheticClient: true,
        pluginRuntimeOwnerId: "duplex-fixture",
        approvalRuntime: true,
        senderAttribution: { id: "duplex-sender" },
      },
    });
    expect(dispatched.client?.internal?.agentRuntimeIdentity).toBe(agentRuntimeIdentity);
    expect(
      resolveNodeInvokeRuntimeAuthorityError({ context, client: dispatched.client }),
    ).toBeUndefined();

    authorityCurrent = false;
    expect(resolveNodeInvokeRuntimeAuthorityError({ context, client: dispatched.client })).toBe(
      "agent runtime approval authority closed before node dispatch",
    );
  });

  it("rejects a scoped agent turn without operator.write", async () => {
    await expect(
      dispatchScopedAgent({
        client: createOperatorClient({ profileId: "reader", scopes: ["operator.read"] }),
        context: createContext(),
      }),
    ).rejects.toThrow("missing scope: operator.write");
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("applies the pending-profile gate to typed in-process agent dispatch", async () => {
    const client = createOperatorClient({ profileId: "pending", scopes: ["operator.write"] });
    delete client.authenticatedUserProfile;
    client.authenticatedGitHubIdentitySync = vi
      .fn()
      .mockRejectedValue(new Error("private provider detail"));

    await expect(dispatchScopedAgent({ client, context: createContext() })).rejects.toThrow(
      "Authenticated profile verification is unavailable",
    );
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("rejects a nonparticipant agent turn before preflight", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:private-draft";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "private-draft-session",
          updatedAt: 1,
          visibility: "draft",
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: "owner" },
        },
      );

      await expect(
        dispatchScopedAgent({
          client: createOperatorClient({ profileId: "outsider", scopes: ["operator.write"] }),
          context: createContext(),
          sessionKey,
        }),
      ).rejects.toThrow("session is draft for this connection");
      expect(startTurn).not.toHaveBeenCalled();
    });
  });

  it("rejects invalid agent params before preflight", async () => {
    await expect(
      dispatchScopedMethod({
        client: createOperatorClient({ profileId: "writer", scopes: ["operator.write"] }),
        context: createContext(),
        method: "agent",
        params: {
          message: "validation probe",
          idempotencyKey: "validation-probe",
          sessionKey: 42,
        },
      }),
    ).rejects.toThrow("invalid agent params:");
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("rejects invalid agent.wait params before lifecycle lookup", async () => {
    await expect(
      dispatchScopedMethod({
        client: createOperatorClient({ profileId: "writer", scopes: ["operator.write"] }),
        context: createContext(),
        method: "agent.wait",
        params: { runId: 42 },
      }),
    ).rejects.toThrow("invalid agent.wait params:");
    expect(waitForTurn).not.toHaveBeenCalled();
  });

  it("registers tool-event observation for a capable scoped client", async () => {
    const context = createContext();
    context.registerToolEventRecipient = vi.fn();
    startTurn.mockImplementation(async ({ io, onRunObserved }) => {
      onRunObserved?.("observed-run");
      io.emitAcceptance([true, { runId: "observed-run", status: "accepted" }, undefined]);
    });

    await dispatchScopedAgent({
      client: createOperatorClient({
        caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
        profileId: "tool-observer",
        scopes: ["operator.write"],
      }),
      context,
    });

    expect(context.registerToolEventRecipient).toHaveBeenCalledWith(
      "observed-run",
      "conn-tool-observer",
    );
  });

  it.each([
    ["agent", { message: "cancelled", idempotencyKey: "cancelled-agent" }],
    ["agent.wait", { runId: "cancelled-run" }],
  ] as const)("rejects a pre-aborted %s request before agent work", async (method, params) => {
    const controller = new AbortController();
    controller.abort(new Error("already aborted"));

    await expect(
      dispatchScopedMethod({
        client: createOperatorClient({ profileId: "writer", scopes: ["operator.write"] }),
        context: createContext(),
        method,
        params,
        signal: controller.signal,
      }),
    ).rejects.toThrow("already aborted");
    expect(startTurn).not.toHaveBeenCalled();
    expect(waitForTurn).not.toHaveBeenCalled();
  });
});
