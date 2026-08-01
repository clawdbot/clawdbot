import type { OpenClawPluginApi } from "./plugin-api.types.js";
import type { OpenClawPluginConfigSchema } from "./plugin-config-schema.types.js";
import type { PluginKind } from "./plugin-kind.types.js";
import type {
  OpenClawPluginReloadRegistration,
  OpenClawPluginSecurityAuditCollector,
} from "./plugin-registration.types.js";
import type { OpenClawPluginNodeHostCommand } from "./types.node-host.js";

/** Module-level plugin definition loaded from a native plugin entry file. */
export type OpenClawPluginDefinition = {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  /**
   * @deprecated Declare exclusive plugin kind in `openclaw.plugin.json` via
   * manifest `kind`. Runtime-exported `kind` is kept as a compatibility
   * fallback for older plugins and may require loading plugin runtime on
   * metadata-only command paths.
   */
  kind?: PluginKind | PluginKind[];
  configSchema?: OpenClawPluginConfigSchema;
  reload?: OpenClawPluginReloadRegistration;
  nodeHostCommands?: OpenClawPluginNodeHostCommand[];
  securityAuditCollectors?: OpenClawPluginSecurityAuditCollector[];
  register?: (api: OpenClawPluginApi) => void;
};

export type OpenClawPluginModule = OpenClawPluginDefinition | ((api: OpenClawPluginApi) => void);
