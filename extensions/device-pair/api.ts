// Device Pair API module exposes the plugin public contract.
export {
  approveDevicePairing,
  clearDeviceBootstrapTokens,
  issueDeviceBootstrapToken,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  listDevicePairing,
  revokeDeviceBootstrapToken,
  type DeviceBootstrapProfile,
} from "openclaw/plugin-sdk/device-bootstrap";
export { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
export {
  resolveGatewayBindUrl,
  resolveTailnetHostWithRunner,
  resolveTailscaleServeGatewayUrlsWithRunner,
} from "openclaw/plugin-sdk/core";
export { resolveAdvertisedLanHost } from "openclaw/plugin-sdk/gateway-runtime";
export {
  resolvePreferredOpenClawTmpDir,
  runPluginCommandWithTimeout,
} from "openclaw/plugin-sdk/sandbox";
export { resolveGatewayPort } from "openclaw/plugin-sdk/gateway-config-runtime";
export { renderQrPngBase64, renderQrPngDataUrl, writeQrPngTempFile } from "./qr-image.js";
