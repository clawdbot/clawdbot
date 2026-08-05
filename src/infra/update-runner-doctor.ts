import { compareSemverStrings } from "./update-check.js";

const UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV =
  "OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR";
const UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV =
  "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE";
const UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART_ENV =
  "OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART";
const UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR_ENV =
  "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR";
const UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION_ENV =
  "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION";
const UPDATE_DOCTOR_SERVICE_REPAIR_POLICY_ENV = "OPENCLAW_SERVICE_REPAIR_POLICY";
const EXTERNAL_SERVICE_REPAIR_POLICY_MIN_VERSION = "2026.4.25-beta.1";

export function resolveUpdateDoctorExecutionPolicy(params: {
  targetVersion: string | null;
  allowGatewayServiceRepair: boolean;
}): { fix: boolean; serviceRepairPolicy?: "external" } {
  if (params.allowGatewayServiceRepair) {
    return { fix: true };
  }
  const support = compareSemverStrings(
    params.targetVersion,
    EXTERNAL_SERVICE_REPAIR_POLICY_MIN_VERSION,
  );
  if (support !== null && support >= 0) {
    return { fix: true, serviceRepairPolicy: "external" };
  }
  // Older targets ignore ownership markers and the external-service policy.
  return { fix: false };
}

export function buildUpdateDoctorEnv(params: {
  allowGatewayServiceRepair: boolean;
  allowGatewayActivation: boolean;
  serviceRepairPolicy?: "external";
  deferConfiguredPluginInstallRepair?: boolean;
  compatibilityHostVersion?: string | null;
}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    ...(params.deferConfiguredPluginInstallRepair
      ? { [UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]: "1" }
      : {}),
    [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
    [UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART_ENV]: "1",
    [UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR_ENV]: params.allowGatewayServiceRepair ? "1" : "0",
    [UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION_ENV]: params.allowGatewayActivation ? "1" : "0",
    ...(params.serviceRepairPolicy
      ? { [UPDATE_DOCTOR_SERVICE_REPAIR_POLICY_ENV]: params.serviceRepairPolicy }
      : {}),
    ...(params.compatibilityHostVersion
      ? { OPENCLAW_COMPATIBILITY_HOST_VERSION: params.compatibilityHostVersion }
      : {}),
  };
}
