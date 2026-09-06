import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveFaceTimeConfig,
  validateFaceTimeConfig,
  type FaceTimeConfig,
} from "./src/config.js";
import { inspectFaceTimeDriver, uninstallFaceTimeDriver } from "./src/driver-setup.js";
import { stopRetainedRuntime } from "./src/runtime-lifecycle.js";
import { runFaceTimeSetup } from "./src/setup.js";
import { inspectFaceTimeStaticStatus } from "./src/static-status.js";
import { createFaceTimeCallTool, resolveFaceTimeToolApproval } from "./src/tool.js";

const faceTimeConfigSchema = {
  parse(value: unknown): FaceTimeConfig {
    return resolveFaceTimeConfig(value);
  },
};

const faceTimePlugin: OpenClawPluginDefinition = definePluginEntry({
  id: "facetime",
  name: "FaceTime",
  description: "Experimental private FaceTime realtime voice carrier for OpenClaw agents",
  configSchema: faceTimeConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolveFaceTimeConfig(api.pluginConfig);
    const validation = validateFaceTimeConfig(config);
    const pluginRoot = api.rootDir ?? api.resolvePath(".");
    let runtimePromise: Promise<import("./runtime-api.js").FaceTimeRuntime> | undefined;

    const ensureRuntime = async () => {
      if (!config.enabled) {
        throw new Error("facetime disabled in plugin config");
      }
      if (!validation.valid) {
        throw new Error(validation.errors.join("; "));
      }
      runtimePromise ??= import("./runtime-api.js")
        .then(({ createFaceTimeRuntime }) =>
          createFaceTimeRuntime({
            config,
            fullConfig: api.config,
            runtime: api.runtime,
            logger: api.logger,
            pluginRoot,
          }),
        )
        .catch((error: unknown) => {
          runtimePromise = undefined;
          throw error;
        });
      return await runtimePromise;
    };

    const getStatus = async () => {
      const current = runtimePromise;
      if (current) {
        try {
          return await (await current).status();
        } catch {
          // Static status remains available after a failed or interrupted activation.
        }
      }
      return await inspectFaceTimeStaticStatus({
        config,
        configErrors: validation.errors,
        pluginRoot,
        runCommandWithTimeout: api.runtime.system.runCommandWithTimeout,
      });
    };

    api.registerTool(() => createFaceTimeCallTool({ ensureRuntime, getStatus }), {
      name: "facetime_call",
    });
    api.on("before_tool_call", (event) => {
      if (event.toolName !== "facetime_call") {
        return undefined;
      }
      return resolveFaceTimeToolApproval(event.params);
    });

    api.registerService({
      id: "facetime-runtime",
      async start() {
        if (!config.enabled || !validation.valid) {
          return;
        }
        try {
          await ensureRuntime();
        } catch (error) {
          api.logger.warn(`[facetime] startup skipped: ${formatErrorMessage(error)}`);
        }
      },
      async stop() {
        await stopRetainedRuntime(runtimePromise, (stopped) => {
          if (runtimePromise === stopped) {
            runtimePromise = undefined;
          }
        });
      },
    });

    const registerGateway = (
      name: string,
      scope: "operator.read" | "operator.write" | "operator.admin",
      handler: (options: GatewayRequestHandlerOptions) => Promise<unknown>,
    ) => {
      api.registerGatewayMethod(
        name,
        async (options: GatewayRequestHandlerOptions) => {
          try {
            options.respond(true, await handler(options));
          } catch (error) {
            options.respond(
              false,
              undefined,
              errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)),
            );
          }
        },
        { scope },
      );
    };

    registerGateway("facetime.status", "operator.read", getStatus);
    registerGateway("facetime.setup", "operator.admin", async () => {
      let runtime: import("./runtime-api.js").FaceTimeRuntime;
      try {
        runtime = await ensureRuntime();
      } catch (runtimeError) {
        return await runFaceTimeSetup({
          config,
          pluginRoot,
          runCommandWithTimeout: api.runtime.system.runCommandWithTimeout,
          runtimeError: formatErrorMessage(runtimeError),
        });
      }
      return await runtime.setup();
    });
    registerGateway("facetime.driverStatus", "operator.read", async () => ({
      status: await inspectFaceTimeDriver({
        pluginRoot,
        runCommandWithTimeout: api.runtime.system.runCommandWithTimeout,
      }),
    }));
    const installDriver = async () => ({
      ok: true,
      ...(await (await ensureRuntime()).installDriver()),
    });
    for (const name of ["facetime.installDriver", "facetime.updateDriver"]) {
      registerGateway(name, "operator.admin", installDriver);
    }
    registerGateway("facetime.uninstall", "operator.admin", async () => {
      const current = runtimePromise;
      if (current) {
        await stopRetainedRuntime(current, (stopped) => {
          if (runtimePromise === stopped) {
            runtimePromise = undefined;
          }
        });
      }
      await uninstallFaceTimeDriver({
        pluginRoot,
        runCommandWithTimeout: api.runtime.system.runCommandWithTimeout,
      });
      return {
        ok: true,
        guidance: "Quit and reopen FaceTime and Phone before re-enabling this plugin.",
      };
    });
    registerGateway(
      "facetime.preflight",
      "operator.admin",
      async () => await (await ensureRuntime()).preflight(),
    );
    registerGateway("facetime.dial", "operator.write", async ({ params }) => {
      const record = params && typeof params === "object" ? params : {};
      const handle = "handle" in record ? record.handle : undefined;
      const mode = "mode" in record ? record.mode : undefined;
      return { ok: true, ...(await (await ensureRuntime()).dial({ handle, mode })) };
    });
    registerGateway("facetime.hangup", "operator.write", async ({ params }) => {
      const callUUID =
        params && typeof params === "object" && "callUUID" in params ? params.callUUID : undefined;
      return { ok: true, ...(await (await ensureRuntime()).hangup({ callUUID })) };
    });
  },
});

export default faceTimePlugin;
