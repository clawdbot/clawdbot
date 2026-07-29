// Public daemon CLI barrel retained for gateway service command compatibility.
export { registerDaemonCli } from "./daemon-cli/register.js";
export { addGatewayServiceCommands } from "./daemon-cli/register-service-commands.js";
export {
  runDaemonInstall,
  runDaemonRestart,
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
  runDaemonUninstall,
} from "./daemon-cli/runners.js";
export type {
  DaemonInstallOptions,
  DaemonStatusOptions,
  GatewayRpcOpts,
} from "./daemon-cli/types.js";
