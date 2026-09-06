import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { installManagedPlugin } from "../../plugins/management-mutations.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

const managementMocks = vi.hoisted(() => ({
  install: vi.fn(),
  refreshMetadata: vi.fn(),
  reload: vi.fn(),
  setEnabled: vi.fn(),
  uninstall: vi.fn(),
}));
vi.mock("../../plugins/management-mutations.js", () => ({
  installManagedPlugin: managementMocks.install,
  refreshManagedPlugins: managementMocks.refreshMetadata,
  reloadManagedPlugin: managementMocks.reload,
  setManagedPluginEnabled: managementMocks.setEnabled,
  uninstallManagedPlugin: managementMocks.uninstall,
}));
vi.mock("../../plugins/catalog-search.js", () => ({ searchInstallablePluginPackages: vi.fn() }));

const { pluginMutationHandlers: pluginsHandlers } = await import("./plugins-mutations.js");
const application = { operationId: "test-operation", generation: 42, pluginIds: ["workboard"] };
const applyRuntime = vi.fn<NonNullable<GatewayRequestContext["applyPluginLifecycleChange"]>>();
const context: Pick<GatewayRequestContext, "applyPluginLifecycleChange"> = {
  applyPluginLifecycleChange: applyRuntime,
};
const lifecycleRequests = [
  {
    method: "plugins.install",
    params: { source: "official", pluginId: "workboard" },
    operation: managementMocks.install,
  },
  {
    method: "plugins.setEnabled",
    params: { pluginId: "workboard", enabled: false },
    operation: managementMocks.setEnabled,
  },
  {
    method: "plugins.uninstall",
    params: { pluginId: "workboard" },
    operation: managementMocks.uninstall,
  },
  {
    method: "plugins.reload",
    params: { pluginId: "workboard" },
    operation: managementMocks.reload,
  },
  { method: "plugins.refresh", params: {}, operation: managementMocks.refreshMetadata },
] as const;
type ManagedMutationOptions = Pick<
  Parameters<typeof installManagedPlugin>[0],
  "applyRuntime" | "beforePersistentApply" | "signal"
>;

async function callHandler(
  method: string,
  params: Record<string, unknown>,
  invocation: Pick<GatewayRequestHandlerOptions, "signal" | "sessionMutationCommitGuard">,
) {
  let ok: boolean | null = null;
  let error: ErrorShape | undefined;
  await expectDefined(
    pluginsHandlers[method],
    "plugin lifecycle handler",
  )({
    ...invocation,
    req: { type: "req", id: "plugin-lifecycle", method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    // This fixture supplies the sole Gateway capability consumed by these lifecycle handlers.
    context: context as GatewayRequestContext,
    respond: (success, _result, requestError) => {
      ok = success;
      error = requestError;
    },
  });
  return { ok, error };
}

describe("plugin lifecycle invoker ownership", () => {
  beforeEach(() => {
    applyRuntime.mockReset().mockResolvedValue(application);
    for (const operation of Object.values(managementMocks)) {
      operation.mockReset();
    }
  });

  it("preserves the management lease guard while the request remains open", async () => {
    const controller = new AbortController();
    const requestGuard = vi.fn();
    const entered = createDeferred();
    const released = createDeferred();
    const publish = vi.fn();
    const failure = new Error("plugin mutation lease lost");
    let leaseOwned = true;
    applyRuntime.mockImplementation(
      async (change: Parameters<NonNullable<ManagedMutationOptions["applyRuntime"]>>[0]) => {
        entered.resolve();
        await released.promise;
        change.assertInvokerOwned?.();
        publish();
        return application;
      },
    );
    managementMocks.reload.mockImplementation(async (options: ManagedMutationOptions) => ({
      application: await expectDefined(
        options.applyRuntime,
        "managed runtime apply",
      )({
        config: {},
        pluginIds: ["workboard"],
        reason: "reload",
        assertInvokerOwned: () => {
          if (!leaseOwned) {
            throw failure;
          }
        },
      }),
    }));
    const pending = callHandler(
      "plugins.reload",
      { pluginId: "workboard" },
      {
        signal: controller.signal,
        sessionMutationCommitGuard: requestGuard,
      },
    );
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("reload completed before queued publication");
        }),
      ]);
      leaseOwned = false;
      released.resolve();
      expect(await pending).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: failure.message },
      });
      expect(controller.signal.aborted).toBe(false);
      expect(requestGuard).toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      released.resolve();
      await pending;
    }
  });
  describe.each(["signal", "guard"] as const)("closed %s", (fence) => {
    const createInvocation = () => {
      const controller = new AbortController();
      const failure = new Error(
        fence === "signal" ? "plugin request aborted" : "plugin mutation owner closed",
      );
      let open = true;
      return {
        failure,
        invocation: {
          signal: controller.signal,
          sessionMutationCommitGuard: () => {
            if (!open) {
              throw failure;
            }
          },
        },
        close: () => {
          if (fence === "signal") {
            controller.abort(failure);
          } else {
            open = false;
          }
        },
      };
    };

    it.each(lifecycleRequests)(
      "rejects $method before management dispatch",
      async ({ method, params, operation }) => {
        const owner = createInvocation();
        operation.mockResolvedValue({ application });
        owner.close();
        expect(await callHandler(method, params, owner.invocation)).toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE", message: owner.failure.message },
        });
        expect(operation).not.toHaveBeenCalled();
        expect(applyRuntime).not.toHaveBeenCalled();
      },
    );

    it.each(
      lifecycleRequests.flatMap(({ method, params, operation }) =>
        (["persistence", "runtime", "publication"] as const).map((checkpoint) => ({
          method,
          params,
          operation,
          checkpoint,
        })),
      ),
    )(
      "rejects retained $method $checkpoint work after an await",
      async ({ method, params, operation, checkpoint }) => {
        const owner = createInvocation();
        const paused = createDeferred();
        const persist = vi.fn();
        if (checkpoint === "publication") {
          applyRuntime.mockImplementation(
            async (change: Parameters<NonNullable<ManagedMutationOptions["applyRuntime"]>>[0]) => {
              await paused.promise;
              change.assertInvokerOwned?.();
              persist();
              return application;
            },
          );
        }
        operation.mockImplementation(async (options: ManagedMutationOptions) => {
          if (checkpoint !== "publication") {
            await paused.promise;
          }
          if (checkpoint === "persistence") {
            options.beforePersistentApply?.();
            persist();
            return { application };
          }
          return {
            application: await expectDefined(
              options.applyRuntime,
              "managed runtime apply",
            )({
              config: {},
              pluginIds: ["workboard"],
              reason: "reload",
            }),
          };
        });
        const pending = callHandler(method, params, owner.invocation);
        try {
          expect(operation).toHaveBeenCalledOnce();
          owner.close();
          paused.resolve();
          expect(await pending).toMatchObject({
            ok: false,
            error: { code: "UNAVAILABLE", message: owner.failure.message },
          });
          expect(persist).not.toHaveBeenCalled();
          expect(applyRuntime).toHaveBeenCalledTimes(checkpoint === "publication" ? 1 : 0);
          expect(operation).toHaveBeenCalledWith(
            expect.objectContaining({
              signal: owner.invocation.signal,
              beforePersistentApply: expect.any(Function),
              applyRuntime: expect.any(Function),
            }),
          );
        } finally {
          paused.resolve();
          await pending;
        }
      },
    );
  });
});
