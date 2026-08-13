// Shared shape for the public device-pairing join shortcode.
export const DEVICE_PAIRING_JOIN_CODE_BYTES = 16;

const DEVICE_PAIRING_JOIN_CODE_RE = /^[A-Za-z0-9_-]{22}$/u;

export function isDevicePairingJoinCode(value: string): boolean {
  return DEVICE_PAIRING_JOIN_CODE_RE.test(value);
}

export function parseDevicePairingJoinRequestPath(pathname: string): string | null {
  // Public endpoints may include an advertised context path. The final /j namespace
  // is the stable route contract; preserving only root /j would mint unusable URLs.
  const markerIndex = pathname.lastIndexOf("/j");
  if (markerIndex < 0) {
    return null;
  }
  const routePath = pathname.slice(markerIndex);
  if (routePath === "/j") {
    return "";
  }
  return routePath.startsWith("/j/") ? routePath.slice(3) : null;
}
