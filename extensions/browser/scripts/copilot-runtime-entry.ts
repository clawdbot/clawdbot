// Browser copilot runtime bundle entry. Keep this list narrow: the extension
// consumes the canonical Gateway auth/wire engines plus the Ed25519 primitive
// needed below Chrome's native WebCrypto support floor.
export {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
  GatewayBrowserDeviceAuthLifecycle,
  GatewayProtocolClient,
  GatewayProtocolRequestError,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "@openclaw/gateway-client/browser";
export { getPublicKeyAsync, signAsync, utils as ed25519Utils } from "@noble/ed25519";
