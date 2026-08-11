/**
 * Browser plugin service factory that lazily starts the control server.
 */
import { resolveBrowserControlStartupMode } from "./plugin-start-policy.js";
import {
  startLazyPluginServiceModule,
  type LazyPluginServiceHandle,
  type OpenClawPluginService,
} from "./sdk-node-runtime.js";

type BrowserControlHandle = LazyPluginServiceHandle | null;
const UNSAFE_BROWSER_CONTROL_OVERRIDE_SPECIFIER = /^(?:data|http|https|node):/i;

function validateBrowserControlOverrideSpecifier(specifier: string): string {
  const trimmed = specifier.trim();
  if (UNSAFE_BROWSER_CONTROL_OVERRIDE_SPECIFIER.test(trimmed)) {
    throw new Error(`Refusing unsafe browser control override specifier: ${trimmed}`);
  }
  return trimmed;
}

/** Creates the Browser plugin service registered by the plugin entrypoint. */
export function createBrowserPluginService(): OpenClawPluginService {
  let handle: BrowserControlHandle = null;

  return {
    id: "browser-control",
    start: async (ctx) => {
      const pageShare = await import("./browser/extension-relay/page-share.js");
      // Plugin services start only in the Gateway process. The sink marks this
      // process as able to deliver page shares to the main session.
      pageShare.setPageShareSink(pageShare.createGatewayPageShareSink());
      const startupMode = resolveBrowserControlStartupMode(
        ctx.config,
        process.env.OPENCLAW_EAGER_BROWSER_CONTROL_SERVER,
      );
      if (!startupMode) {
        return;
      }
      if (handle) {
        return;
      }
      handle = await startLazyPluginServiceModule({
        skipEnvVar: "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
        overrideEnvVar: "OPENCLAW_BROWSER_CONTROL_MODULE",
        validateOverrideSpecifier: validateBrowserControlOverrideSpecifier,
        // Keep the default module import static so compiled builds still bundle it.
        loadDefaultModule: async () =>
          startupMode === "server"
            ? await import("./server.js")
            : await import("./control-service.js"),
        startExportNames:
          startupMode === "server"
            ? ["startBrowserControlServerFromConfig", "startBrowserControlServiceFromConfig"]
            : ["startBrowserControlServiceFromConfig", "startBrowserControlServerFromConfig"],
        stopExportNames:
          startupMode === "server"
            ? ["stopBrowserControlServer", "stopBrowserControlService"]
            : ["stopBrowserControlService", "stopBrowserControlServer"],
      });
    },
    stop: async () => {
      const { setPageShareSink } = await import("./browser/extension-relay/page-share.js");
      setPageShareSink(null);
      const current = handle;
      if (current) {
        await current.stop();
        if (handle === current) {
          handle = null;
        }
        return;
      }
      const { stopBrowserControlService } = await import("./control-service.js");
      await stopBrowserControlService();
    },
  };
}
