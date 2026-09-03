// Service activation precedes cold-start loading and the authenticated handshake.
// All managed setup observers share this platform-specific startup allowance.
export function resolveGatewayStartupTiming() {
  const windows = process.platform === "win32";
  return {
    deadlineMs: windows ? 90_000 : 45_000,
    probeTimeoutMs: windows ? 15_000 : 10_000,
  };
}
