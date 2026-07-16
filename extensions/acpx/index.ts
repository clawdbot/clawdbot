import { createAcpxRuntimeService } from "./register.runtime.js";
import { tryDispatchAcpReplyHook, type OpenClawPluginApi } from "./runtime-api.js";
import { createAcpxPluginConfigSchema } from "./src/config-schema.js";

const plugin = {
  id: "acpx",
  name: "ACPX Runtime",
  description: "Embedded ACP runtime backend with plugin-owned session and transport management.",
  configSchema: () => createAcpxPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerService(
      createAcpxRuntimeService({
        pluginConfig: api.pluginConfig,
      }),
    );
    api.on("reply_dispatch", tryDispatchAcpReplyHook);
  },
};

export default plugin;
