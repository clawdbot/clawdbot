/**
 * Browser plugin service factory that lazily starts the control server.
 */
import {
  startLazyPluginServiceModule,
  type LazyPluginServiceHandle,
  type OpenClawPluginService,
} from "./sdk-node-runtime.js";

type BrowserControlHandle = LazyPluginServiceHandle | null;
const EAGER_BROWSER_CONTROL_SERVICE_ENV = "OPENCLAW_EAGER_BROWSER_CONTROL_SERVER";
const UNSAFE_BROWSER_CONTROL_OVERRIDE_SPECIFIER = /^(?:data|http|https|node):/i;

function isTruthyEnvValue(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/iu.test(value?.trim() ?? "");
}

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
    start: async () => {
      if (!isTruthyEnvValue(process.env[EAGER_BROWSER_CONTROL_SERVICE_ENV])) {
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
        loadDefaultModule: async () => await import("./server.js"),
        startExportNames: [
          "startBrowserControlServiceFromConfig",
          "startBrowserControlServerFromConfig",
        ],
        stopExportNames: ["stopBrowserControlService", "stopBrowserControlServer"],
      });
    },
    stop: async () => {
      const current = handle;
      handle = null;
      if (current) {
        await current.stop().catch(() => {});
        return;
      }
      const { stopBrowserControlService } = await import("./control-service.js");
      await stopBrowserControlService().catch(() => {});
    },
  };
}
