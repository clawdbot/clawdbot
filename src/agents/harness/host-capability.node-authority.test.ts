import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
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
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";

type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];
const admissions: PreparedAgentRunAdmission[] = [];

async function admittedAttempt(
  runId: string,
  overrides: Omit<Partial<HostAttempt>, "admittedRunContext" | "runId"> = {},
): Promise<{ attempt: HostAttempt; admission: PreparedAgentRunAdmission }> {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: {
        kind: "system",
        boundary: "host-capability-node-authority-test",
        state: "present",
      },
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
      permissionMode: "full",
      ...overrides,
      admittedRunContext,
    },
  };
}

afterEach(() => {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  resetAgentRunRegistryForTest();
  resetPluginRuntimeStateForTest();
});

describe("agent harness node authority", () => {
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
              const requestScope = getPluginRuntimeGatewayRequestScope();
              const invoke = requestScope?.invokeWithSessionNodeAuthority;
              expect(invoke).toBeTypeOf("function");
              const placementGrantAuthority = requestScope?.nodePlacementGrantAuthority;
              expect(placementGrantAuthority).toMatchObject({
                agentId: "main",
                sessionKey: sessionTarget.sessionKey,
                runId: `run-${change}`,
              });
              const placementGrantRequest = {
                pluginId: "fixture",
                command: "fixture.exec",
                nodeId: "node-1",
                workspace: {
                  workspaceDir: "/node/workspace",
                  sessionKey: sessionTarget.sessionKey,
                  sessionId: "session-1",
                  environmentId: "environment-1",
                  ownerEpoch: 2,
                },
              };
              expect(() =>
                placementGrantAuthority?.assertCurrent(placementGrantRequest),
              ).not.toThrow();
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
                host.close();
                expect(() => placementGrantAuthority?.assertCurrent(placementGrantRequest)).toThrow(
                  "no longer active",
                );
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
});
