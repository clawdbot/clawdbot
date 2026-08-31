import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { applyPluginNodeInvokePolicy } from "./node-invoke-plugin-policy.js";
import {
  createNodeSession,
  createContext,
  createDemoPolicy,
  setDangerousDemoCommandRegistry,
  DEMO_PLUGIN_ID,
  DEMO_COMMAND,
  DEMO_PARAMS,
} from "./node-invoke-plugin-policy.test-helpers.js";
import type { GatewayClient } from "./server-methods/types.js";
afterEach(() => resetPluginRuntimeStateForTest());
describe("admitted Full node dispatch", () => {
  it.each(["stream", "raw", "permission", "plugin", "node", "command"] as const)(
    "preserves the owned boundary during awaited policy (%s)",
    async (change) => {
      const node = createNodeSession();
      const { context, invoke } = createContext({ nodeSession: node });
      let active = true;
      const assertCurrent = () => {
        if (!active) {
          throw new Error("Full authority revoked");
        }
      };
      setDangerousDemoCommandRegistry([
        createDemoPolicy(async (ctx) => {
          if (!ctx.invokeNodeWithSessionFull) {
            return { ok: false, code: "APPROVAL_REQUIRED", message: "human approval required" };
          }
          return (await ctx.invokeNodeWithSessionFull({
            workspace: {
              workspaceDir: "/node/workspace",
              environmentId: "env",
              sessionId: "session",
              ownerEpoch: 1,
              sessionKey: "agent:main:session",
            },
            createParams: () => ({ authorization: "session-full" }),
          }))!;
        }),
      ]);
      const result = withPluginRuntimeGatewayRequestScope(
        {
          context,
          isWebchatConnect: () => false,
          invokeWithSessionNodeAuthority: async (_request, dispatch) => {
            assertCurrent();
            return await dispatch(assertCurrent, new AbortController().signal);
          },
        },
        () =>
          applyPluginNodeInvokePolicy({
            context,
            nodeSession: node,
            command: DEMO_COMMAND,
            params: DEMO_PARAMS,
            sessionKey: "agent:main:session",
            client: {
              internal: { pluginRuntimeOwnerId: DEMO_PLUGIN_ID },
              connect: { scopes: [] },
            } as unknown as GatewayClient,
            ...(change !== "raw"
              ? {
                  nodeInvokeStream: {
                    onProgress: () => {},
                    onDispatchReady: () => {},
                    isRuntimeCurrent: () => true,
                  },
                }
              : {}),
            isInvocationCurrent: async () => {
              await Promise.resolve();
              if (change === "permission") {
                active = false;
              }
              if (change === "plugin") {
                setActivePluginRegistry(createEmptyPluginRegistry());
              }
              if (change === "node") {
                context.nodeRegistry.get = () => ({ ...node, connId: "replacement" });
              }
              if (change === "command") {
                node.commands = [];
              }
              return true;
            },
          }),
      );
      if (change === "permission") {
        await expect(result).rejects.toThrow("Full authority revoked");
      } else {
        await expect(result).resolves.toMatchObject({ ok: change === "stream" });
      }
      if (change === "stream") {
        expect(invoke).toHaveBeenCalledOnce();
      } else {
        expect(invoke).not.toHaveBeenCalled();
      }
    },
  );
});
