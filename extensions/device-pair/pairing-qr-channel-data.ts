// Private device-pair -> Gateway live-display envelope.
// Keep this local so pairing QR metadata does not become public Plugin SDK API.
const DEVICE_PAIR_PAIRING_QR_CHANNEL_DATA_KEY = "openclawPairingQr";

type DevicePairPairingQrChannelData = {
  setupCode: string;
  expiresAtMs: number;
};

export function buildDevicePairPairingQrChannelData(
  params: DevicePairPairingQrChannelData,
): Record<string, unknown> {
  return {
    [DEVICE_PAIR_PAIRING_QR_CHANNEL_DATA_KEY]: {
      setupCode: params.setupCode,
      expiresAtMs: params.expiresAtMs,
    },
  };
}
