import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "../../gateway/server-methods/types.js";
import type { WorkerTunnelHandle } from "../../gateway/worker-environments/tunnel.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  getExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";

// The fixture registers its plugin directly; disk discovery is outside this handoff.
vi.mock("../../plugins/loader.js", () => ({
  loadAndActivateRootPluginRegistry: vi.fn(() => {
    throw new Error("unexpected plugin discovery");
  }),
  loadOpenClawPlugins: vi.fn(() => {
    throw new Error("unexpected plugin discovery");
  }),
}));

vi.mock("../../agents/agent-tools.js", () => ({
  createOpenClawCodingTools: vi.fn(() => {
    throw new Error("unexpected coding tool construction");
  }),
}));

const state = setupAgentRunnerExecutionTestState();

let execute: Awaited<ReturnType<typeof getExecuteAgentTurnForTest>>;
let fixture: typeof import("../../gateway/worker-environments/worker-turn-launcher.test-support.js");
beforeEach(async () => {
  execute = await getExecuteAgentTurnForTest();
  fixture = await import("../../gateway/worker-environments/worker-turn-launcher.test-support.js");
  await fixture.setupWorkerTurnLauncherTest();
});
afterEach(async () => {
  (await import("../../plugins/runtime.js")).resetPluginRuntimeStateForTest();
  (await import("../../infra/agent-run-registry.js")).resetAgentRunRegistryForTest();
  await fixture.cleanupWorkerTurnLauncherTest();
});

describe("webchat admission to plugin node duplex authority", () => {
  const cases = [
    ...(
      [
        "full",
        "shared",
        "workspace",
        "raw",
        "unrelated-command",
        "missing-descriptor",
        "expanded-descriptor",
      ] as const
    ).map((mode) => ({
      mode,
      phase: "startup" as const,
    })),
    ...(
      [
        "permission",
        "session",
        "admission",
        "gateway",
        "node",
        "plugin",
        "placement",
        "runtime-plugin",
        "runtime-retired",
        "runtime-reactivated",
        "gateway-reactivated",
        "runtime-record-revoked",
      ] as const
    ).flatMap((mode) => (["startup", "policy"] as const).map((phase) => ({ mode, phase }))),
  ];
  it.each(cases)(
    "carries only current admitted Full through the request envelope: $mode ($phase)",
    async ({ mode, phase }) => {
      const { createAgentHarnessHostCapabilities } =
        await import("../../agents/harness/host-capability.js");
      const { upsertSessionEntryCore } = await import("../../config/sessions/session-accessor.js");
      const { createGatewayMethodRegistry } = await import("../../gateway/methods/registry.js");
      const { applyPluginNodeInvokePolicy } =
        await import("../../gateway/node-invoke-plugin-policy.js");
      const { createContext, createNodeSession } =
        await import("../../gateway/node-invoke-plugin-policy.test-helpers.js");
      const { runWithGatewayRequestEnvelope } = await import("../../gateway/server-methods.js");
      const { createGatewayNodesRuntime } = await import("../../gateway/server-plugins.js");
      const { createPluginRecord } = await import("../../plugins/loader-records.js");
      const {
        markPluginRegistryActive,
        markPluginRegistryRetired,
        revokePluginRecordLifecycleEpoch,
      } = await import("../../plugins/registry-lifecycle.js");
      const { createEmptyPluginRegistry } = await import("../../plugins/registry-empty.js");
      const { withPluginRuntimePluginScope, withPluginRuntimeRegistryScope } =
        await import("../../plugins/runtime/gateway-request-scope.js");
      const { setActivePluginRegistry } = await import("../../plugins/runtime.js");
      const {
        attachedEnvironment,
        createWorkerSessionTurnPlacementProvider,
        ENVIRONMENT_ID,
        MANIFEST_REF,
        OWNER_EPOCH,
        placements,
        root,
        seedActivePlacement,
        SESSION_ID,
        SESSION_KEY,
        sessionTarget,
        unusedEnvironments,
      } = fixture;
      await upsertSessionEntryCore(sessionTarget, { permissionMode: "full" });
      seedActivePlacement("remote-exec");
      const workspace = {
        workspaceDir: "/worker/workspace",
        sessionKey: SESSION_KEY,
        sessionId: SESSION_ID,
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
      };
      const command =
        mode === "unrelated-command" || mode === "expanded-descriptor" ? "demo.other" : "demo.read";
      const requiredNodeCommands = mode === "missing-descriptor" ? undefined : ["demo.read"];
      const node = createNodeSession();
      node.declaredCommands = ["demo.read", "demo.other"];
      node.commands = [...node.declaredCommands];
      const { context, invoke } = createContext({
        nodeSession: node,
        getRuntimeConfig: () => ({ gateway: { nodes: { commands: { allow: node.commands } } } }),
      });
      let currentContext: GatewayRequestContext | undefined = context;
      context.resolveGatewayContext = () => currentContext;
      const registry = createEmptyPluginRegistry();
      const nodes = createGatewayNodesRuntime(context.resolveGatewayContext);
      const record = createPluginRecord({
        id: "demo",
        source: "fixture",
        origin: "bundled",
        enabled: true,
        configSchema: true,
      });
      registry.plugins.push(record);
      for (const declaredCommand of node.commands) {
        registry.nodeHostCommands.push({
          pluginId: record.id,
          source: "fixture",
          command: {
            command: declaredCommand,
            dangerous: true,
            duplex: true,
            handle: async () => "{}",
          },
        });
      }
      const prompt = vi.fn();
      let revoke = async () => {};
      registry.nodeInvokePolicies.push({
        pluginId: record.id,
        source: "fixture",
        policy: {
          commands: [...node.commands],
          async handle(policy) {
            await Promise.resolve();
            if (phase === "policy") {
              await revoke();
            }
            const result = await policy.invokeNodeWithSessionFull?.({
              workspace,
              createParams: () => ({ placement: workspace, authorization: "session-full" }),
            });
            if (result) {
              return result;
            }
            prompt();
            return { ok: false, code: "APPROVAL_REQUIRED", message: "one-time approval required" };
          },
        },
      });
      const preparedRegistry = createEmptyPluginRegistry();
      const preparedRecord = { ...record };
      preparedRegistry.plugins.push(preparedRecord);
      preparedRegistry.nodeHostCommands.push(...registry.nodeHostCommands);
      const scopedRegistry = mode === "shared" ? registry : preparedRegistry;
      setActivePluginRegistry(registry);
      const methodRegistry = createGatewayMethodRegistry(
        [
          {
            name: "node.invoke",
            owner: { kind: "core", area: "nodes" },
            scope: "operator.write",
            async handler(options: GatewayRequestHandlerOptions) {
              const result = await applyPluginNodeInvokePolicy({
                context: options.context,
                client: options.client,
                nodeSession: node,
                command,
                params: options.params.params,
                sessionKey: options.params.sessionKey as string,
                nodeInvokeStream: options.client?.internal?.nodeInvokeStream,
              });
              if (result?.ok) {
                options.respond(true, result.payload);
              } else {
                options.respond(false, undefined, {
                  code: "INVALID_REQUEST",
                  message: result?.message ?? "missing policy",
                });
              }
            },
          },
        ],
        registry,
      );
      context.getGatewayMethodRegistry = () => methodRegistry;
      invoke.mockImplementation(async (params) => {
        expect(params?.isDispatchAuthorized?.()).toBe(true);
        params?.onDispatchReady?.("fixture-invoke");
        params?.onProgress?.(JSON.stringify({ v: 1, kind: "ready" }));
        return { ok: true, payload: { launched: true } };
      });
      const tunnel: WorkerTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        launchTurn: vi.fn(),
        runWorkspaceCommand: vi.fn(),
        syncWorkspace: vi.fn(),
        quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
        reconcileWorkspace: async (request) => {
          request.journal.commit(MANIFEST_REF);
          return {
            manifestRef: MANIFEST_REF,
            changed: false,
            verifyStable: async () => {},
            verifyLocalStable: async () => {},
          };
        },
        stop: async () => {},
      };
      const environment = {
        ...attachedEnvironment(),
        providerId: "device",
        nodeDeviceId: node.nodeId,
        sshEndpoint: null,
      };
      const claimTurn = vi.spyOn(placements, "claimTurn");
      const placement = createWorkerSessionTurnPlacementProvider({
        placements,
        environments: {
          ...unusedEnvironments(),
          get: () => environment,
          startTunnel: async () => tunnel,
        },
      });
      const launchErrors: string[] = [];
      state.runEmbeddedAgentMock.mockImplementationOnce(
        async (originalParams: RunEmbeddedAgentParams) => {
          // The shared fixture omits runId from its parameter stub; retain the real admission's id.
          const admission = originalParams.preparedRunAdmission!;
          const params = { ...originalParams, runId: admission.operationalRunInstance.runId };
          return placement.executeTurn(
            {
              sessionId: SESSION_ID,
              sessionKey: SESSION_KEY,
              agentId: "main",
              runId: params.runId,
            },
            { ...params, sessionFile: SESSION_KEY, sessionTarget },
            async () => {
              const admittedRunContext = await admission.admit("plugin-harness");
              const host = createAgentHarnessHostCapabilities({
                attempt: {
                  admittedRunContext,
                  runId: params.runId,
                  agentId: params.agentId,
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                  sessionTarget,
                  permissionMode: params.permissionMode,
                  abortSignal: params.abortSignal,
                  config: params.config,
                  workspaceDir: params.workspaceDir,
                },
                pluginId: record.id,
                requiredNodeCommands,
              });
              if (mode === "expanded-descriptor") {
                requiredNodeCommands?.push("demo.other");
              }
              revoke = async () => {
                switch (mode) {
                  case "full":
                  case "shared":
                  case "workspace":
                  case "raw":
                  case "unrelated-command":
                  case "missing-descriptor":
                  case "expanded-descriptor":
                    break;
                  case "permission":
                    await upsertSessionEntryCore(sessionTarget, { permissionMode: "workspace" });
                    break;
                  case "session":
                    await upsertSessionEntryCore(sessionTarget, {
                      sessionId: "replacement-session",
                    });
                    break;
                  case "admission":
                    admission.close();
                    break;
                  case "gateway":
                    currentContext = { ...context };
                    break;
                  case "node":
                    environment.nodeDeviceId = "replacement-node";
                    break;
                  case "plugin":
                    registry.plugins.splice(0, 1, { ...record });
                    break;
                  case "runtime-plugin":
                    preparedRegistry.plugins.splice(0, 1, { ...preparedRecord });
                    break;
                  case "runtime-retired":
                    markPluginRegistryRetired(preparedRegistry);
                    break;
                  case "runtime-reactivated":
                    markPluginRegistryRetired(preparedRegistry);
                    markPluginRegistryActive(preparedRegistry);
                    break;
                  case "gateway-reactivated":
                    markPluginRegistryActive(registry);
                    break;
                  case "runtime-record-revoked":
                    revokePluginRecordLifecycleEpoch(preparedRegistry, preparedRecord);
                    break;
                  case "placement": {
                    const claimed = claimTurn.mock.results[0];
                    if (claimed?.type !== "return") {
                      throw new Error("expected an admitted placement claim");
                    }
                    placements.cancelWorkspaceResultAndReleaseTurn(claimed.value, {
                      reason: "node-disconnect",
                    });
                    break;
                  }
                }
              };
              try {
                await withPluginRuntimeRegistryScope(scopedRegistry, () =>
                  host.runWithScope(() =>
                    withPluginRuntimePluginScope(
                      { pluginId: record.id, pluginOrigin: "bundled" },
                      async () => {
                        // Runtime initialization completes asynchronously before opening the channel.
                        await new Promise<void>((resolve) => {
                          setImmediate(resolve);
                        });
                        if (phase === "startup") {
                          await revoke();
                        }
                        try {
                          const input = {
                            nodeId: node.nodeId,
                            command,
                            params: workspace,
                            sessionKey: SESSION_KEY,
                          };
                          if (mode === "raw") {
                            await nodes.invoke(input);
                          } else {
                            const channel = await nodes.openDuplex(input);
                            await channel.closed;
                          }
                        } catch (error) {
                          launchErrors.push((error as Error).message);
                        }
                      },
                    ),
                  ),
                );
              } finally {
                host.close();
              }
              return { payloads: [{ text: "finished" }], meta: { durationMs: 1 } };
            },
          );
        },
      );
      const followupRun = createFollowupRun();
      Object.assign(followupRun.run, {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentDir: root,
        workspaceDir: root,
        permissionMode: mode === "workspace" ? "workspace" : "full",
      });

      const reply = await runWithGatewayRequestEnvelope(
        "sessions.send",
        null,
        () =>
          execute({
            ...createMinimalRunAgentTurnParams({ followupRun }),
            sessionKey: SESSION_KEY,
          }),
        {
          context,
          isWebchatConnect: () => true,
          methodRegistry,
          reject: (error) => {
            throw new Error(error.message);
          },
        },
      );
      if (mode !== "placement" && mode !== "session") {
        expect(reply).toMatchObject({ kind: "success" });
      }
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      if (mode === "full" || mode === "shared") {
        expect(launchErrors).toEqual([]);
        expect(prompt).not.toHaveBeenCalled();
        expect(invoke).toHaveBeenCalledOnce();
        expect(invoke.mock.calls[0]?.[0]).toMatchObject({
          params: { placement: workspace, authorization: "session-full" },
        });
      } else if (
        mode === "workspace" ||
        mode === "raw" ||
        mode === "unrelated-command" ||
        mode === "missing-descriptor" ||
        mode === "expanded-descriptor"
      ) {
        expect(invoke).not.toHaveBeenCalled();
        expect(launchErrors).toEqual(["one-time approval required"]);
        expect(prompt).toHaveBeenCalledOnce();
      } else {
        expect(launchErrors).toHaveLength(1);
        expect(launchErrors[0]).toMatch(/no longer (active|current)/);
        expect(prompt).not.toHaveBeenCalled();
        expect(invoke).not.toHaveBeenCalled();
      }
      currentContext = undefined;
    },
  );
});
