// Shared shape for the public device-pairing join shortcode.
export const DEVICE_PAIRING_JOIN_CODE_BYTES = 16;

const DEVICE_PAIRING_JOIN_CODE_RE = /^[A-Za-z0-9_-]{22}$/u;

export function isDevicePairingJoinCode(value: string): boolean {
  return DEVICE_PAIRING_JOIN_CODE_RE.test(value);
}

export function parseDevicePairingJoinRequestPath(pathname: string): string | null {
  // Public endpoints may include an advertised context path. The final /j namespace
  // is the stable route contract; preserving only root /j would mint unusable URLs.
  // Terminal /j first: a context path may itself contain a /j/ segment
  // (e.g. /proxy/j/app/j), and shortcodes never contain slashes.
  if (pathname.endsWith("/j")) {
    return "";
  }
  const markerIndex = pathname.lastIndexOf("/j/");
  return markerIndex >= 0 ? pathname.slice(markerIndex + 3) : null;
}
