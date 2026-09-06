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

export {
  isManagedUpdateRequesterOwner,
  waitForGatewayUpdateRecovery,
} from "./daemon-cli/lifecycle-context.js";
// The detached updater loads these closures before replacing its installation.
export {
  finishUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunVerification,
} from "../infra/update-run-ledger.js";
