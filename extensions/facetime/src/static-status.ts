import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { FaceTimeConfig } from "./config.js";
import { inspectFaceTimeDriver, type FaceTimeDriverStatus } from "./driver-setup.js";
import { inspectFaceTimeArtifacts } from "./plugin-paths.js";

export type FaceTimeStaticStatus = {
  enabled: boolean;
  activation: "inactive";
  configValid: boolean;
  configErrors: string[];
  artifacts: Awaited<ReturnType<typeof inspectFaceTimeArtifacts>>;
  driverStatus?: FaceTimeDriverStatus;
  driverError?: string;
  note: string;
};

export async function inspectFaceTimeStaticStatus(params: {
  config: FaceTimeConfig;
  configErrors: string[];
  pluginRoot: string;
  runCommandWithTimeout: PluginRuntime["system"]["runCommandWithTimeout"];
}): Promise<FaceTimeStaticStatus> {
  const [artifacts, driver] = await Promise.all([
    inspectFaceTimeArtifacts({}),
    inspectFaceTimeDriver(params).then(
      (status) => ({ status }),
      (error: unknown) => ({ error: formatErrorMessage(error) }),
    ),
  ]);
  return {
    enabled: params.config.enabled,
    activation: "inactive",
    configValid: params.configErrors.length === 0,
    configErrors: params.configErrors,
    artifacts,
    driverStatus: "status" in driver ? driver.status : undefined,
    driverError: "error" in driver ? driver.error : undefined,
    note: "Static inspection only; helper, carrier, model media, and remote audibility were not activated or tested.",
  };
}
