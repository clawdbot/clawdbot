export function resolveNodeHostGatewayPlatformIdentity(platform: NodeJS.Platform): {
  platform: string;
  deviceFamily?: string;
} {
  switch (platform) {
    case "darwin":
      return { platform: "macos", deviceFamily: "Mac" };
    case "win32":
      return { platform: "windows", deviceFamily: "Windows" };
    case "linux":
      return { platform: "linux", deviceFamily: "Linux" };
    default:
      return { platform: "unknown" };
  }
}
