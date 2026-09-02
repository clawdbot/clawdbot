/**
 * Shared CLI helpers only; Browser runtime imports belong to the lazy command leaves.
 */
export {
  formatCliCommand,
  formatHelpExamples,
  inheritOptionFromParent,
  runCommandWithRuntime,
  theme,
} from "openclaw/plugin-sdk/cli-runtime";
export {
  addGatewayClientOptions,
  callGatewayFromCli,
  type GatewayRpcOpts,
} from "openclaw/plugin-sdk/gateway-runtime";
export { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
export { danger, defaultRuntime, info } from "openclaw/plugin-sdk/runtime-env";
export { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
export { parseBooleanValue } from "openclaw/plugin-sdk/string-coerce-runtime";
export { shortenHomePath } from "openclaw/plugin-sdk/text-utility-runtime";
