import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { buildBrowserExtensionPairing } from "./extension-pairing.js";

export function buildBrowserNativeHostPairing() {
  return buildBrowserExtensionPairing({
    cfg: getRuntimeConfig(),
    localTransport: "gateway",
  });
}
