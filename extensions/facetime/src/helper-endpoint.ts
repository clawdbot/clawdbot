import endpoint from "../helper-endpoint.json" with { type: "json" };

type FaceTimeHelperEndpoint = { host: "127.0.0.1"; port: number };

export function resolveFaceTimeHelperEndpoint(
  uid = typeof process.getuid === "function" ? process.getuid() : 501,
): FaceTimeHelperEndpoint {
  if (
    endpoint.host !== "127.0.0.1" ||
    !Number.isSafeInteger(endpoint.basePort) ||
    !Number.isSafeInteger(endpoint.maxPort) ||
    endpoint.basePort < 1024 ||
    endpoint.maxPort > 65_535 ||
    endpoint.basePort > endpoint.maxPort ||
    !Number.isSafeInteger(uid)
  ) {
    throw new Error("Invalid FaceTime loopback helper endpoint contract");
  }
  return {
    host: endpoint.host,
    port: Math.min(Math.max(endpoint.basePort + uid - 501, endpoint.basePort), endpoint.maxPort),
  };
}
