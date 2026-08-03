// Re-export the gateway-client device auth helpers from the server package so
// gateway HTTP code and tests share the exact payload normalization contract.
export {
  buildDeviceAuthPayload,
  buildDeviceAuthPayloadV3,
  normalizeDeviceMetadataForAuth,
} from "../../packages/gateway-client/src/device-auth.js";
