/** Linux systemd user service installer, parser, and lifecycle controls. */
export {
  isNonFatalSystemdInstallProbeError,
  hasSudoToRootSystemdUserManagerMismatch,
  isSystemdUnitActive,
  isSystemdUserServiceAvailable,
  resolveSystemdUserServiceAccount,
  type SystemdUnitScope,
} from "./systemd-exec.js";
export {
  installSystemdService,
  stageSystemdService,
  uninstallSystemdService,
} from "./systemd-install.js";
export {
  restartSystemdService,
  startSystemdService,
  stopSystemdService,
  uninstallLegacySystemdUnits,
  uninstallUserSystemdGatewayUnit,
} from "./systemd-lifecycle.js";
export { enableSystemdUserLinger, readSystemdUserLingerStatus } from "./systemd-linger.js";
export { isSystemdServiceEnabled, readSystemdServiceRuntime } from "./systemd-runtime.js";
export { readSystemdServiceExecStart } from "./systemd-service-files.js";
export {
  findInstalledSystemdGatewayScope,
  findSystemdGatewayInstallation,
  formatDuelingScopesWarning,
  isSystemUnitActiveAndEnabled,
} from "./systemd-scope.js";
