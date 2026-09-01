import {
  getHealthCheck,
  registerHealthCheck as registerPluginHealthCheck,
  type HealthCheck,
} from "openclaw/plugin-sdk/health";
import { verifyInstalledCuaDriverArtifacts } from "./driver-artifacts.js";

export const CUA_DRIVER_ARTIFACT_CHECK_ID = "cua-computer/driver-artifacts";

const cuaDriverArtifactCheck: HealthCheck = {
  id: CUA_DRIVER_ARTIFACT_CHECK_ID,
  kind: "plugin",
  description: "Verify the installed Windows/Linux CUA Driver SDK artifact.",
  source: "cua-computer",
  async detect() {
    const verification = verifyInstalledCuaDriverArtifacts();
    if (verification.ok) {
      return [];
    }
    return [
      {
        checkId: CUA_DRIVER_ARTIFACT_CHECK_ID,
        severity: "error",
        source: "cua-computer",
        message: verification.diagnostic,
        target: "@trycua/cua-driver",
        requirement: "the accepted CUA Driver SDK version and native package digests",
        fixHint: verification.fixHint,
      },
    ];
  },
};

type CuaDriverDoctorRegistrationHost = {
  readonly registerHealthCheck: (check: HealthCheck) => void;
};

const registeredHosts = new WeakSet<(check: HealthCheck) => void>();

export function registerCuaDriverDoctorChecks(host?: CuaDriverDoctorRegistrationHost): void {
  const registerHealthCheck = host?.registerHealthCheck ?? registerPluginHealthCheck;
  if (registeredHosts.has(registerHealthCheck)) {
    return;
  }
  if (
    host === undefined &&
    getHealthCheck(CUA_DRIVER_ARTIFACT_CHECK_ID) === cuaDriverArtifactCheck
  ) {
    return;
  }
  registerHealthCheck(cuaDriverArtifactCheck);
  registeredHosts.add(registerHealthCheck);
}
