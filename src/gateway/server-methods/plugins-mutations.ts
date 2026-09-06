import {
  validatePluginsInstallParams,
  validatePluginsRefreshParams,
  validatePluginsReloadParams,
  validatePluginsSetEnabledParams,
  validatePluginsUninstallParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type {
  PluginsInstallResult,
  PluginsUninstallResult,
} from "../../../packages/gateway-protocol/src/schema/plugins.js";
import {
  capturePluginRuntimeApplications,
  type PluginRuntimeApplication,
} from "../../plugins/lifecycle.js";
import {
  installManagedPlugin,
  refreshManagedPlugins,
  reloadManagedPlugin,
  setManagedPluginEnabled,
  uninstallManagedPlugin,
} from "../../plugins/management-mutations.js";
import { pluginLifecycleError } from "./plugins-lifecycle-error.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

type PluginLifecycleResult = Partial<
  Pick<PluginsInstallResult, "plugin" | "warnings"> &
    Pick<PluginsUninstallResult, "pluginId" | "removed">
> & { application?: PluginRuntimeApplication };

type PluginLifecycleOptions = Required<
  Pick<Parameters<typeof installManagedPlugin>[0], "applyRuntime" | "beforePersistentApply">
> & { signal?: AbortSignal };

function lifecycleHandler<T>(
  method: string,
  validate: Validator<T>,
  run: (params: T, lifecycle: PluginLifecycleOptions) => Promise<PluginLifecycleResult>,
): GatewayRequestHandler {
  return async ({ params, respond, context, signal, sessionMutationCommitGuard }) => {
    if (!assertValidParams(params, validate, method, respond)) {
      return;
    }
    let captured: ReturnType<typeof capturePluginRuntimeApplications> | undefined;
    try {
      const applyRuntime = context.applyPluginLifecycleChange;
      if (!applyRuntime) {
        throw new Error("Plugin lifecycle changes require a running Gateway.");
      }
      const beforePersistentApply = () => {
        signal?.throwIfAborted();
        sessionMutationCommitGuard?.();
      };
      beforePersistentApply();
      captured = capturePluginRuntimeApplications((change) => {
        beforePersistentApply();
        return applyRuntime({
          ...change,
          assertInvokerOwned: () => {
            beforePersistentApply();
            change.assertInvokerOwned?.();
          },
        });
      });
      const { application, plugin, pluginId, removed, warnings } = await run(params, {
        applyRuntime: captured.applyRuntime,
        beforePersistentApply,
        ...(signal ? { signal } : {}),
      });
      if (!application) {
        throw new Error("Plugin lifecycle did not return a runtime application receipt.");
      }
      respond(
        true,
        {
          ok: true,
          restartRequired: false,
          runtime: application,
          ...(plugin ? { plugin } : {}),
          ...(pluginId ? { pluginId } : {}),
          ...(removed ? { removed } : {}),
          ...(warnings ? { warnings } : {}),
        },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, pluginLifecycleError(error, captured?.application));
    }
  };
}

export const pluginMutationHandlers: GatewayRequestHandlers = {
  "plugins.refresh": lifecycleHandler(
    "plugins.refresh",
    validatePluginsRefreshParams,
    (_params, lifecycle) => refreshManagedPlugins(lifecycle),
  ),
  "plugins.reload": lifecycleHandler(
    "plugins.reload",
    validatePluginsReloadParams,
    (params, lifecycle) => reloadManagedPlugin({ ...params, ...lifecycle }),
  ),
  "plugins.install": lifecycleHandler(
    "plugins.install",
    validatePluginsInstallParams,
    (params, lifecycle) => installManagedPlugin({ request: params, ...lifecycle }),
  ),
  "plugins.uninstall": lifecycleHandler(
    "plugins.uninstall",
    validatePluginsUninstallParams,
    (params, lifecycle) => uninstallManagedPlugin({ ...params, ...lifecycle }),
  ),
  "plugins.setEnabled": lifecycleHandler(
    "plugins.setEnabled",
    validatePluginsSetEnabledParams,
    (params, lifecycle) => setManagedPluginEnabled({ ...params, ...lifecycle }),
  ),
};
