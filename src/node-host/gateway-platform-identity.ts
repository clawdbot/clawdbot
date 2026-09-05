import { resolveMachineModelIdentifier } from "../infra/machine-model.js";

export function resolveNodeHostGatewayPlatformIdentity(
  platform: NodeJS.Platform,
  resolveModel = resolveMachineModelIdentifier,
): {
  platform: string;
  deviceFamily?: string;
  modelIdentifier?: string;
} {
  const modelIdentifier = resolveModel(platform);
  switch (platform) {
    case "darwin":
      return { platform: "macos", deviceFamily: "Mac", modelIdentifier };
    case "win32":
      return { platform: "windows", deviceFamily: "Windows", modelIdentifier };
    case "linux":
      return { platform: "linux", deviceFamily: "Linux", modelIdentifier };
    default:
      return { platform: "unknown" };
  }
}
