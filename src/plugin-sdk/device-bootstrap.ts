// Shared bootstrap/pairing helpers for plugins that provision remote devices.

export { approveDevicePairing, listDevicePairing } from "../infra/device-pairing.js";
export {
  clearDeviceBootstrapTokens,
  issueDeviceBootstrapToken,
  revokeDeviceBootstrapToken,
} from "../infra/device-bootstrap.js";
export {
  BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
  normalizeDeviceBootstrapProfile,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  type DeviceBootstrapProfile,
  type DeviceBootstrapProfileInput,
  type DeviceBootstrapPurpose,
} from "../shared/device-bootstrap-profile.js";
