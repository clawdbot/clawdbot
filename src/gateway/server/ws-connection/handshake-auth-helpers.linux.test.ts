// Linux native-app admission tests: openclaw-linux joins the native UI client class,
// pairing auto-approves only for direct-local connections.
import { describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams } from "../../../../packages/gateway-protocol/src/schema.js";
import {
  isNativeAppUiClient,
  resolvePairingLocality,
  shouldAllowSilentLocalPairing,
} from "./handshake-auth-helpers.js";

const LINUX_NATIVE_CONNECT_PARAMS = {
  client: {
    id: GATEWAY_CLIENT_IDS.LINUX_APP,
    mode: GATEWAY_CLIENT_MODES.UI,
  },
} as ConnectParams;

describe("linux native-app handshake admission", () => {
  it("auto-approves local openclaw-linux pairing and keeps remote pairing explicit", () => {
    expect(isNativeAppUiClient(LINUX_NATIVE_CONNECT_PARAMS.client)).toBe(true);
    const locality = resolvePairingLocality({
      connectParams: LINUX_NATIVE_CONNECT_PARAMS,
      isLocalClient: true,
      requestHost: "127.0.0.1:18789",
      remoteAddress: "127.0.0.1",
      hasProxyHeaders: false,
      hasBrowserOriginHeader: false,
      sharedAuthOk: true,
      authMethod: "token",
    });
    expect(locality).toBe("direct_local");
    expect(
      shouldAllowSilentLocalPairing({
        locality,
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        isNativeAppUi: true,
        reason: "not-paired",
      }),
    ).toBe(true);
    expect(
      shouldAllowSilentLocalPairing({
        locality,
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        isNativeAppUi: true,
        reason: "metadata-upgrade",
      }),
    ).toBe(true);
    expect(
      shouldAllowSilentLocalPairing({
        locality: "remote",
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        isNativeAppUi: true,
        reason: "not-paired",
      }),
    ).toBe(false);
  });
});
