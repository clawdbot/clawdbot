// Shared shape for the public device-pairing join shortcode.
export const DEVICE_PAIRING_JOIN_CODE_BYTES = 16;

const DEVICE_PAIRING_JOIN_CODE_RE = /^[A-Za-z0-9_-]{22}$/u;

export function isDevicePairingJoinCode(value: string): boolean {
  return DEVICE_PAIRING_JOIN_CODE_RE.test(value);
}
