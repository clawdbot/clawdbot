import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { callInProcessGatewayTool } from "../../agents/tools/in-process-gateway.js";
import type { CliDeps } from "../../cli/deps.types.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as gatewayCall from "../../gateway/call.js";
import { withLocalGatewayRequestScope } from "../../gateway/local-request-context.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import { createLazyCoreHandlers } from "../../gateway/server-methods/lazy-core-handlers.js";
import { sessionDeleteHandlers } from "../../gateway/server-methods/sessions-delete.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import { GatewayRequestEntryLifetime } from "../../gateway/server-request-entry.js";
import {
  getSessionBindingService,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { ensureGatewayOwnerProfile } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../runtime/registry.js";
import { AcpSessionManager, getAcpSessionManager, testing as managerTesting } from "./manager.js";
import { disposeAcpSessionManagerInstance } from "./manager.lifecycle.js";
import { DEFAULT_DEPS } from "./manager.types.js";
import { cleanupFailedAcpSpawn } from "./spawn.js";

const backendId = "provisional-cleanup-fixture";
const agentId = "main";
const sessionKey = "agent:main:acp:provisional-cleanup";
type Initialized = Awaited<
  ReturnType<ReturnType<typeof getAcpSessionManager>["initializeSession"]>
>;

// This fixture opens no browser; browser ownership has its own lifecycle tests.
vi.mock("../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: async () => {},
}));

beforeAll(async () => {
  // Prepare the real lazy cleanup graph outside request deadlines. Vitest source
  // transformation is not part of the running Gateway's ten-second RPC budget.
  await Promise.all([
    import("../../gateway/server-methods/sessions-delete.js"),
    import("../../gateway/server-methods/sessions.runtime.js"),
    import("../../agents/embedded-agent.js"),
    import("../../agents/agent-bundle-mcp-tools.js"),
    import("../../agents/bash-process-registry.js"),
  ]);
});
afterEach(() => vi.restoreAllMocks());

async function withCleanupFixture(
  run: (fixture: {
    cfg: OpenClawConfig;
    manager: ReturnType<typeof getAcpSessionManager>;
    runtime: AcpRuntime;
    initialize: () => Promise<Initialized>;
    cleanup: (initialized: Initialized) => Promise<void>;
    close: ReturnType<typeof vi.fn<AcpRuntime["close"]>>;
    ensureSession: ReturnType<typeof vi.fn<AcpRuntime["ensureSession"]>>;
    prepareFreshSession: ReturnType<typeof vi.fn<NonNullable<AcpRuntime["prepareFreshSession"]>>>;
    socket: MockInstance<typeof gatewayCall.callGateway>;
    bindings: Map<string, SessionBindingRecord>;
    bind: ReturnType<typeof vi.fn<NonNullable<SessionBindingAdapter["bind"]>>>;
  }) => Promise<void>,
) {
  return await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      acp: { enabled: true, backend: backendId, allowedAgents: [agentId] },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId } },
        entries: { main: { workspace: state.workspaceDir } },
      },
      channels: { discord: { threadBindings: { enabled: true } } },
    };
    await state.writeConfig(cfg);
    const close = vi.fn<AcpRuntime["close"]>(async () => {});
    const ensureSession = vi.fn<AcpRuntime["ensureSession"]>(async (input) => ({
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      backend: backendId,
      runtimeSessionName: input.sessionKey,
      backendSessionId: `runtime:${input.sessionKey}`,
    }));
    const prepareFreshSession = vi.fn<NonNullable<AcpRuntime["prepareFreshSession"]>>(
      async () => {},
    );
    const runtime: AcpRuntime = {
      ownerAwareSessions: 1,
      ensureSession,
      close,
      prepareFreshSession,
      async cancel() {},
      runTurn() {
        throw new Error("No provider turn belongs in this cleanup fixture");
      },
    };
    const bindings = new Map<string, SessionBindingRecord>();
    const bind = vi.fn<NonNullable<SessionBindingAdapter["bind"]>>(async (input) => {
      const binding: SessionBindingRecord = {
        bindingId: `binding:${input.targetSessionKey}`,
        targetSessionKey: input.targetSessionKey,
        targetKind: input.targetKind,
        conversation: input.conversation,
        status: "active",
        boundAt: Date.now(),
        metadata: input.metadata,
      };
      bindings.set(input.targetSessionKey, binding);
      return binding;
    });
    const adapter: SessionBindingAdapter = {
      channel: "discord",
      accountId: "default",
      capabilities: {
        placements: ["current", "child"],
        bindSupported: true,
        unbindSupported: true,
      },
      bind,
      listBySession: (key) => (bindings.has(key) ? [bindings.get(key)!] : []),
      resolveByConversation: () => null,
      unbind: async (input) => {
        const removed = [...bindings.values()].filter(
          (record) => record.targetSessionKey === input.targetSessionKey,
        );
        for (const record of removed) {
          bindings.delete(record.targetSessionKey);
        }
        return removed;
      },
    };
    registerSessionBindingAdapter(adapter);
    registerAcpRuntimeBackend({ id: backendId, runtime });
    managerTesting.resetAcpSessionManagerForTests();
    const manager = getAcpSessionManager();
    const socket = vi
      .spyOn(gatewayCall, "callGateway")
      .mockRejectedValue(new Error("Raw WebSocket transport is unavailable"));
    try {
      await withLocalGatewayRequestScope({ deps: {} as CliDeps, getRuntimeConfig: () => cfg }, () =>
        run({
          cfg,
          manager,
          runtime,
          close,
          ensureSession,
          prepareFreshSession,
          socket,
          bindings,
          bind,
          initialize: () =>
            manager.initializeSession({
              cfg,
              sessionKey,
              agentId,
              agent: agentId,
              mode: "persistent",
            }),
          cleanup: (initialized) =>
            cleanupFailedAcpSpawn({
              cfg,
              sessionKey,
              agentId,
              sessionEntry: initialized.sessionEntry,
              deleteTranscript: true,
              closeRuntimeOnFailure: initialized.closeRuntimeOnFailure,
            }),
        }),
      );
    } finally {
      await disposeAcpSessionManagerInstance(manager, "fixture-cleanup");
      managerTesting.resetAcpSessionManagerForTests();
      unregisterAcpRuntimeBackend(backendId);
      unregisterSessionBindingAdapter({ channel: "discord", accountId: "default", adapter });
    }
  });
}

describe("failed ACP provisional cleanup", () => {
  it.each(["live Gateway", "retired Gateway", "expired operator"] as const)(
    "retains local resource cleanup after %s ownership",
    async (owner) => {
      await withCleanupFixture(
        async ({ initialize, cleanup, close, ensureSession, socket, manager }) => {
          const scope = getPluginRuntimeGatewayRequestScope();
          if (!scope?.context) {
            throw new Error("Expected the local Gateway owner");
          }
          const initialized = await initialize();
          const before = loadSessionEntry({ sessionKey, agentId });
          let current = true;
          const resolveGatewayContext = () => (current ? scope.context : undefined);
          await withPluginRuntimeGatewayRequestScope({ ...scope, resolveGatewayContext }, () =>
            withGatewayToolCallerIdentity(
              {
                agentId,
                sessionKey: "agent:main:main",
                operationalRunInstance: { instanceId: "parent-instance", runId: "parent-run" },
                receiptAuthority: () => false,
                gatewayContextResolver: resolveGatewayContext,
              },
              async () => {
                if (owner === "expired operator") {
                  const profile = ensureGatewayOwnerProfile("Cleanup owner");
                  const release = createDeferredCore();
                  let late: Promise<void> | undefined;
                  await withOperatorToolGatewayAuthority(
                    {
                      authenticatedUserProfile: {
                        profileId: profile.id,
                        displayName: profile.displayName,
                        hasAvatar: false,
                        updatedAt: profile.updatedAt,
                      },
                      scopes: ["operator.admin"],
                    },
                    async () => {
                      late = release.promise.then(() => cleanup(initialized));
                    },
                  );
                  release.resolve();
                  await late;
                } else {
                  current = owner !== "retired Gateway";
                  await cleanup(initialized);
                }
              },
            ),
          );
          expect(loadSessionEntry({ sessionKey, agentId })).toEqual(
            owner === "live Gateway" ? undefined : before,
          );
          expect(close).toHaveBeenCalledOnce();
          expect(ensureSession).toHaveBeenCalledOnce();
          expect(socket).not.toHaveBeenCalled();
          await initialized.closeRuntimeOnFailure();
          await disposeAcpSessionManagerInstance(manager, "repeat-disposal");
          expect(close).toHaveBeenCalledOnce();
        },
      );
    },
  );

  it("releases the original handle when Gateway retirement during lazy preparation prevents admission", async () => {
    await withCleanupFixture(async ({ initialize, cleanup, close, ensureSession, socket }) => {
      const scope = getPluginRuntimeGatewayRequestScope();
      if (!scope?.context) {
        throw new Error("Expected local Gateway owner");
      }
      const initialized = await initialize();
      const before = loadSessionEntry({ sessionKey, agentId });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const deletion = vi.fn(sessionDeleteHandlers["sessions.delete"]!);
      const lazy = createLazyCoreHandlers({
        methods: ["sessions.delete"],
        loadHandlers: async () => {
          entered.resolve();
          await release.promise;
          return { "sessions.delete": deletion };
        },
      });
      const registry = createGatewayMethodRegistry([
        {
          name: "sessions.delete",
          owner: { kind: "core", area: "sessions" },
          scope: "operator.admin",
          handler: lazy["sessions.delete"]!,
        },
      ]);
      const lifetime = new GatewayRequestEntryLifetime();
      const context = {
        ...scope.context,
        requestEntryLifetime: lifetime,
        getGatewayMethodRegistry: () => registry,
      };
      let current = true;
      await withPluginRuntimeGatewayRequestScope(
        { ...scope, context, resolveGatewayContext: () => (current ? context : undefined) },
        async () => {
          const cleaning = cleanup(initialized);
          try {
            await entered.promise;
            current = false;
            lifetime.beginClose();
          } finally {
            release.resolve();
          }
          await cleaning;
          await lifetime.sealAndJoin();
          expect(deletion).not.toHaveBeenCalled();
          expect(close).toHaveBeenCalledOnce();
          expect(close).toHaveBeenCalledWith({
            handle: initialized.handle,
            reason: "spawn-failed",
          });
          expect(ensureSession).toHaveBeenCalledOnce();
          expect(loadSessionEntry({ sessionKey, agentId })).toEqual(before);
          expect(socket).not.toHaveBeenCalled();
        },
      );
    });
  });

  it.each(["before admission", "after admission"] as const)(
    "does not repeat resource cleanup after a deadline %s",
    async (boundary) => {
      await withCleanupFixture(async ({ initialize, cleanup, close, ensureSession, socket }) => {
        const scope = getPluginRuntimeGatewayRequestScope();
        if (!scope?.context) {
          throw new Error("Expected local Gateway owner");
        }
        const initialized = await initialize();
        const before = loadSessionEntry({ sessionKey, agentId });
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const deletion = vi.fn(sessionDeleteHandlers["sessions.delete"]!);
        const lazy = createLazyCoreHandlers({
          methods: ["sessions.delete"],
          loadHandlers: async () => {
            if (boundary === "before admission") {
              entered.resolve();
              await release.promise;
            }
            return { "sessions.delete": deletion };
          },
        });
        if (boundary === "after admission") {
          close.mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
          });
        }
        const registry = createGatewayMethodRegistry([
          {
            name: "sessions.delete",
            owner: { kind: "core", area: "sessions" },
            scope: "operator.admin",
            handler: lazy["sessions.delete"]!,
          },
        ]);
        const executions: Promise<unknown>[] = [];
        const context = {
          ...scope.context,
          getGatewayMethodRegistry: () => registry,
          trackExecution: <T>(work: () => T | Promise<T>) => {
            const tracked = scope.context!.trackExecution(work);
            executions.push(tracked);
            return tracked;
          },
        };
        const retainedRelease = vi.fn(initialized.closeRuntimeOnFailure);
        await withPluginRuntimeGatewayRequestScope(
          { ...scope, context, resolveGatewayContext: () => context },
          async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const cleaning = cleanup({ ...initialized, closeRuntimeOnFailure: retainedRelease });
            try {
              await entered.promise;
              await vi.advanceTimersByTimeAsync(10_001);
              await cleaning;
              expect(retainedRelease).toHaveBeenCalledTimes(
                boundary === "before admission" ? 1 : 0,
              );
              expect(close).toHaveBeenCalledOnce();
            } finally {
              vi.useRealTimers();
              release.resolve();
              await cleaning;
              await Promise.allSettled(executions);
            }
            expect(deletion).toHaveBeenCalledTimes(boundary === "before admission" ? 0 : 1);
            expect(loadSessionEntry({ sessionKey, agentId })).toEqual(
              boundary === "before admission" ? before : undefined,
            );
            expect(close).toHaveBeenCalledOnce();
            expect(ensureSession).toHaveBeenCalledOnce();
            expect(socket).not.toHaveBeenCalled();
          },
        );
      });
    },
  );

  it("deletes the provisional shell after the initializer owns metadata-failure release", async () => {
    await withCleanupFixture(async ({ cfg, close, ensureSession, socket }) => {
      const shell = await upsertSessionEntryCore(
        { sessionKey, agentId },
        { sessionId: "metadata-failure-shell", updatedAt: Date.now() },
      );
      if (!shell) {
        throw new Error("Expected provisional shell");
      }
      const manager = new AcpSessionManager({
        ...DEFAULT_DEPS,
        upsertSessionMeta: async () => {
          throw new Error("metadata write refused");
        },
      });
      try {
        await expect(
          manager.initializeSession({
            cfg,
            sessionKey,
            agentId,
            agent: agentId,
            mode: "persistent",
          }),
        ).rejects.toThrow("metadata write refused");
        expect(close).toHaveBeenCalledExactlyOnceWith({
          handle: expect.objectContaining({ sessionKey }),
          reason: "init-meta-failed",
        });
        await cleanupFailedAcpSpawn({
          cfg,
          sessionKey,
          agentId,
          sessionEntry: shell,
          deleteTranscript: true,
        });
        expect(loadSessionEntry({ sessionKey, agentId })).toBeUndefined();
        expect(ensureSession).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        expect(socket).not.toHaveBeenCalled();
      } finally {
        await disposeAcpSessionManagerInstance(manager, "fixture-cleanup");
      }
    });
  });

  it("uses pending-identity prepare-fresh cleanup without rehydrating or forcing a close", async () => {
    await withCleanupFixture(
      async ({ ensureSession, initialize, cleanup, close, prepareFreshSession, manager }) => {
        ensureSession.mockImplementationOnce(async (input) => ({
          sessionKey: input.sessionKey,
          agentId: input.agentId,
          backend: backendId,
          runtimeSessionName: input.sessionKey,
        }));
        const initialized = await initialize();
        await cleanup(initialized);
        expect(loadSessionEntry({ sessionKey, agentId })).toBeUndefined();
        expect(ensureSession).toHaveBeenCalledOnce();
        expect(close).not.toHaveBeenCalled();
        expect(prepareFreshSession).toHaveBeenCalledOnce();
        await initialized.closeRuntimeOnFailure();
        expect(close).not.toHaveBeenCalled();
        expect(manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
      },
    );
  });

  it.each(["replace", "reset"] as const)(
    "keeps a %s successor and its binding untouched by stale cleanup",
    async (mutation) => {
      await withCleanupFixture(
        async ({ initialize, cleanup, close, ensureSession, bindings, socket }) => {
          const original = await initialize();
          await callInProcessGatewayTool(
            mutation === "replace" ? "sessions.delete" : "sessions.reset",
            { key: sessionKey, agentId },
          );
          const successor = await initialize();
          if (mutation === "replace") {
            expect(successor.sessionEntry.sessionId).not.toBe(original.sessionEntry.sessionId);
          } else {
            expect(successor.sessionEntry.sessionId).toBe(original.sessionEntry.sessionId);
            expect(successor.sessionEntry.lifecycleRevision).not.toBe(
              original.sessionEntry.lifecycleRevision,
            );
          }
          const binding = await getSessionBindingService().bind({
            targetSessionKey: sessionKey,
            targetKind: "session",
            placement: "current",
            conversation: {
              channel: "discord",
              accountId: "default",
              conversationId: "successor-thread",
            },
          });
          const before = loadSessionEntry({ sessionKey, agentId });
          close.mockClear();
          ensureSession.mockClear();
          await cleanup(original);
          expect(loadSessionEntry({ sessionKey, agentId })).toEqual(before);
          expect(bindings.get(sessionKey)).toEqual(binding);
          expect(close).not.toHaveBeenCalled();
          expect(ensureSession).not.toHaveBeenCalled();
          expect(socket).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("releases an initialization that finishes after its Gateway and manager retire", async () => {
    await withCleanupFixture(
      async ({ manager, initialize, cleanup, ensureSession, close, socket }) => {
        const scope = getPluginRuntimeGatewayRequestScope();
        if (!scope?.context) {
          throw new Error("Expected local Gateway owner");
        }
        let current = true;
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const originalEnsure = ensureSession.getMockImplementation()!;
        ensureSession.mockImplementationOnce(async (input) => {
          entered.resolve();
          await release.promise;
          return await originalEnsure(input);
        });
        await withPluginRuntimeGatewayRequestScope(
          { ...scope, resolveGatewayContext: () => (current ? scope.context : undefined) },
          async () => {
            const initializing = initialize();
            try {
              await entered.promise;
              current = false;
              await disposeAcpSessionManagerInstance(manager, "gateway-shutdown");
              expect(close).not.toHaveBeenCalled();
            } finally {
              release.resolve();
            }
            const initialized = await initializing;
            await cleanup(initialized);
            expect(close).toHaveBeenCalledOnce();
            expect(ensureSession).toHaveBeenCalledOnce();
            expect(socket).not.toHaveBeenCalled();
            expect(manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
          },
        );
      },
    );
  });

  it("does not release a newer handle through a retained initialization callback", async () => {
    await withCleanupFixture(async ({ manager, initialize, close }) => {
      const original = await initialize();
      const successor = await initialize();
      expect(successor.handle).not.toBe(original.handle);
      await original.closeRuntimeOnFailure();
      expect(close).not.toHaveBeenCalled();
      await disposeAcpSessionManagerInstance(manager, "gateway-shutdown");
      await successor.closeRuntimeOnFailure();
      expect(close).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledWith({ handle: successor.handle, reason: "gateway-shutdown" });
    });
  });

  it("rolls back a refused /acp conversation binding through the local session owner", async () => {
    const { handleAcpCommand } = await import("../../auto-reply/reply/commands-acp.js");
    const { buildCommandTestParams } =
      await import("../../auto-reply/reply/commands.test-harness.js");
    await withCleanupFixture(async ({ cfg, bind, ensureSession, close, socket }) => {
      bind.mockRejectedValueOnce(new Error("Conversation binding refused"));
      const params = buildCommandTestParams("/acp spawn main --bind here", cfg, {
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:fixture-room",
        SenderId: "fixture-owner",
        AccountId: "default",
      });
      params.command.senderIsOwner = true;
      const result = await handleAcpCommand(params, true);
      expect(result?.reply?.text).toContain("Conversation binding refused");
      expect(bind).toHaveBeenCalledOnce();
      expect(ensureSession).toHaveBeenCalledOnce();
      const childKey = ensureSession.mock.calls[0]![0].sessionKey;
      expect(loadSessionEntry({ sessionKey: childKey, agentId })).toBeUndefined();
      expect(close).toHaveBeenCalledOnce();
      expect(socket).not.toHaveBeenCalled();
    });
  });
});
