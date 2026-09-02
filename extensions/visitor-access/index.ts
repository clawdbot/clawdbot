import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { VisitorPolicyClient } from "./src/cloudflare.js";
import { visitorConfigSchema, visitorPluginSchema } from "./src/config.js";
import { visitorErrorText } from "./src/errors.js";
import { visitorRuntimeStore, type VisitorRuntime } from "./src/runtime.js";
import { createVisitorTools } from "./src/tools.js";
import { VisitorAccessService, type VisitorGrant } from "./src/visitors.js";

function registerVisitorPlugin(api: OpenClawPluginApi): void {
  if (api.registrationMode === "cli-metadata") {
    return;
  }
  for (const name of ["visitor_invite", "visitor_revoke", "visitor_list"]) {
    api.registerTool((ctx) => createVisitorTools(ctx).find((tool) => tool.name === name), { name });
  }
  if (api.registrationMode !== "full") {
    return;
  }
  const config = visitorConfigSchema.parse(api.pluginConfig);
  const lifetime = new AbortController();
  const store = api.runtime.state.openKeyedStore<VisitorGrant>({
    namespace: "visitor-grants",
    // Fixed storage bound survives config reload; maxVisitors controls admission.
    maxEntries: 500,
    overflowPolicy: "reject-new",
  });
  const service = new VisitorAccessService(
    config,
    store,
    new VisitorPolicyClient(config, fetch, lifetime.signal),
    api.logger,
    fetch,
    lifetime.signal,
  );
  const runtime: VisitorRuntime = {
    service,
    errorText: (error) => visitorErrorText(error, config.apiToken),
  };

  let interval: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<void> | undefined;
  let startupSweep: Promise<void> | undefined;
  const sweep = () => {
    sweeping ??= service
      .sweep()
      .catch((error: unknown) => {
        if (!lifetime.signal.aborted) {
          api.logger.error(
            `visitor-access sweep failed: ${visitorErrorText(error, config.apiToken)}`,
          );
        }
      })
      .finally(() => {
        sweeping = undefined;
      });
    return sweeping;
  };
  const start = () => {
    lifetime.signal.throwIfAborted();
    const active = visitorRuntimeStore.tryGetRuntime();
    if (active && active !== runtime) {
      throw new Error("A visitor-access Gateway service is already running.");
    }
    visitorRuntimeStore.setRuntime(runtime);
    interval ??= setInterval(() => {
      void sweep();
    }, 3_600_000);
    interval.unref();
    return (startupSweep ??= sweep());
  };
  api.on("gateway_start", start);
  // Services, unlike gateway hooks alone, stop on plugin hot replacement too.
  api.registerService({
    id: "visitor-access-expiry",
    start,
    async stop() {
      clearInterval(interval);
      interval = undefined;
      lifetime.abort();
      await service.waitForIdle();
      if (visitorRuntimeStore.tryGetRuntime() === runtime) {
        visitorRuntimeStore.clearRuntime();
      }
    },
  });
}

export default definePluginEntry({
  id: "visitor-access",
  name: "Visitor Access",
  description: "Internal Cloudflare Access visitor grants with managed expiry.",
  configSchema: visitorPluginSchema,
  register: registerVisitorPlugin,
});
