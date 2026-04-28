import path from "node:path";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import {
  resolvePreferredOpenClawTmpDir,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "../api.js";
import {
  resolveDiffsPluginDefaults,
  resolveDiffsPluginSecurity,
  resolveDiffsPluginViewerBaseUrl,
} from "./config.js";
import { createDiffsHttpHandler } from "./http.js";
import { DIFFS_AGENT_GUIDANCE } from "./prompt-guidance.js";
import { DiffArtifactStore } from "./store.js";
import { createDiffsTool } from "./tool.js";

export function registerDiffsPlugin(api: OpenClawPluginApi): void {
  const store = new DiffArtifactStore({
    rootDir: path.join(resolvePreferredOpenClawTmpDir(), "openclaw-diffs"),
    logger: api.logger,
  });
  const resolveCurrentPluginConfig = () =>
    resolveLivePluginConfigObject(
      api.runtime.config?.current
        ? () => api.runtime.config.current() as OpenClawConfig
        : undefined,
      "diffs",
      api.pluginConfig as Record<string, unknown>,
    ) ?? {};
  const resolveCurrentAccessConfig = () => {
    const currentConfig = (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;
    const pluginConfig = resolveCurrentPluginConfig();
    return {
      allowRemoteViewer: resolveDiffsPluginSecurity(pluginConfig).allowRemoteViewer,
      trustedProxies: currentConfig.gateway?.trustedProxies,
      allowRealIpFallback: currentConfig.gateway?.allowRealIpFallback === true,
    };
  };
  const initialAccessConfig = resolveCurrentAccessConfig();

  api.registerTool(
    (ctx) => {
      const pluginConfig = resolveCurrentPluginConfig();
      return createDiffsTool({
        api,
        store,
        defaults: resolveDiffsPluginDefaults(pluginConfig),
        viewerBaseUrl: resolveDiffsPluginViewerBaseUrl(pluginConfig),
        context: ctx,
      });
    },
    {
      name: "diffs",
    },
  );
  api.registerHttpRoute({
    path: "/plugins/diffs",
    auth: "plugin",
    match: "prefix",
    handler: createDiffsHttpHandler({
      store,
      logger: api.logger,
      allowRemoteViewer: initialAccessConfig.allowRemoteViewer,
      trustedProxies: initialAccessConfig.trustedProxies,
      allowRealIpFallback: initialAccessConfig.allowRealIpFallback,
      resolveAccessConfig: resolveCurrentAccessConfig,
    }),
  });
  api.on("before_prompt_build", async () => ({
    prependSystemContext: DIFFS_AGENT_GUIDANCE,
  }));
}
