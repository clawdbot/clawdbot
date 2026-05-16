import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { handleAdminHttpRpcRequest } from "./src/handler.js";

export default definePluginEntry({
  id: "admin-http-rpc",
  name: "Admin HTTP RPC",
  description: "Expose selected Gateway admin RPC methods over HTTP",
  register(api) {
    api.registerHttpRoute({
      path: "/api/v1/admin/rpc",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: handleAdminHttpRpcRequest,
    });
  },
});
