import { describe, expect, it } from "vitest";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../../protocol/client-info.js";
import type { ConnectParams } from "../../protocol/schema/types.js";
import {
  BROWSER_ORIGIN_RATE_LIMIT_KEY_PREFIX,
  BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP,
  resolveHandshakeBrowserSecurityContext,
  resolvePairingLocality,
  resolveUnauthorizedHandshakeContext,
  shouldAllowSilentLocalPairing,
  shouldSkipLocalBackendSelfPairing,
} from "./handshake-auth-helpers.js";

function createRateLimiter(): AuthRateLimiter {
  return {
    check: () => ({ allowed: true, remaining: 1, retryAfterMs: 0 }),
    reset: () => {},
    recordFailure: () => {},
    size: () => 0,
    prune: () => {},
    dispose: () => {},
  };
}

describe("handshake auth helpers", () => {
  it("pins browser-origin loopback clients to the synthetic rate-limit ip", () => {
    const rateLimiter = createRateLimiter();
    const browserRateLimiter = createRateLimiter();
    const resolved = resolveHandshakeBrowserSecurityContext({
      requestOrigin: "https://app.example",
      clientIp: "127.0.0.1",
      rateLimiter,
      browserRateLimiter,
    });

    expect(resolved).toMatchObject({
      hasBrowserOriginHeader: true,
      enforceOriginCheckForAnyClient: true,
      rateLimitClientIp: `${BROWSER_ORIGIN_RATE_LIMIT_KEY_PREFIX}https://app.example`,
      authRateLimiter: browserRateLimiter,
    });
  });

  it("falls back to the legacy synthetic ip when the browser origin is invalid", () => {
    const resolved = resolveHandshakeBrowserSecurityContext({
      requestOrigin: "not a url",
      clientIp: "127.0.0.1",
    });

    expect(resolved.rateLimitClientIp).toBe(BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP);
  });

  it("recommends device-token retry only for shared-token mismatch with device identity", () => {
    const resolved = resolveUnauthorizedHandshakeContext({
      connectAuth: { token: "shared-token" },
      failedAuth: { ok: false, reason: "token_mismatch" },
      hasDeviceIdentity: true,
    });

    expect(resolved).toEqual({
      authProvided: "token",
      canRetryWithDeviceToken: true,
      recommendedNextStep: "retry_with_device_token",
    });
  });

  it("treats explicit device-token mismatch as credential update guidance", () => {
    const resolved = resolveUnauthorizedHandshakeContext({
      connectAuth: { deviceToken: "device-token" },
      failedAuth: { ok: false, reason: "device_token_mismatch" },
      hasDeviceIdentity: true,
    });

    expect(resolved).toEqual({
      authProvided: "device-token",
      canRetryWithDeviceToken: false,
      recommendedNextStep: "update_auth_credentials",
    });
  });

  it("allows silent local pairing for not-paired, scope-upgrade and role-upgrade", () => {
    expect(
      shouldAllowSilentLocalPairing({
        locality: "direct_local",
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        reason: "not-paired",
      }),
    ).toBe(true);
    expect(
      shouldAllowSilentLocalPairing({
        locality: "direct_local",
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        reason: "role-upgrade",
      }),
    ).toBe(true);
    expect(
      shouldAllowSilentLocalPairing({
        locality: "direct_local",
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        reason: "scope-upgrade",
      }),
    ).toBe(true);
    expect(
      shouldAllowSilentLocalPairing({
        locality: "browser_container_local",
        hasBrowserOriginHeader: true,
        isControlUi: true,
        isWebchat: true,
        reason: "not-paired",
      }),
    ).toBe(true);
    expect(
      shouldAllowSilentLocalPairing({
        locality: "direct_local",
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        reason: "metadata-upgrade",
      }),
    ).toBe(false);
  });
  it("rejects silent role-upgrade for remote clients", () => {
    expect(
      shouldAllowSilentLocalPairing({
        locality: "remote",
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        reason: "role-upgrade",
      }),
    ).toBe(false);
  });

  it("classifies direct local requests ahead of any Docker CLI fallback", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      },
    } as ConnectParams;
    expect(
      resolvePairingLocality({
        connectParams,
        isLocalClient: true,
        requestHost: "gateway.example",
        remoteAddress: "203.0.113.20",
        hasProxyHeaders: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authMethod: "token",
      }),
    ).toBe("direct_local");
  });

  it("classifies Docker-published loopback Control UI as browser-container-local", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    } as ConnectParams;
    expect(
      resolvePairingLocality({
        connectParams,
        isLocalClient: false,
        requestHost: "127.0.0.1:18789",
        requestOrigin: "http://127.0.0.1:18789",
        remoteAddress: "172.17.0.1",
        hasProxyHeaders: false,
        hasBrowserOriginHeader: true,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe("browser_container_local");
    expect(
      resolvePairingLocality({
        connectParams,
        isLocalClient: false,
        requestHost: "localhost:18789",
        requestOrigin: "http://localhost:18789",
        remoteAddress: "172.17.0.1",
        hasProxyHeaders: false,
        hasBrowserOriginHeader: true,
        sharedAuthOk: true,
        authMethod: "password",
      }),
    ).toBe("browser_container_local");
  });

  it("keeps Docker-published non-loopback Control UI origins remote", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    } as ConnectParams;
    const base = {
      connectParams,
      isLocalClient: false,
      remoteAddress: "172.17.0.1",
      hasProxyHeaders: false,
      hasBrowserOriginHeader: true,
      sharedAuthOk: true,
      authMethod: "token" as const,
    };

    expect(
      resolvePairingLocality({
        ...base,
        requestHost: "192.168.1.10:18789",
        requestOrigin: "http://192.168.1.10:18789",
      }),
    ).toBe("remote");
    expect(
      resolvePairingLocality({
        ...base,
        requestHost: "127.0.0.1:18789",
        requestOrigin: "https://app.example",
      }),
    ).toBe("remote");
    expect(
      resolvePairingLocality({
        ...base,
        requestHost: "127.0.0.1:18789",
        requestOrigin: "http://127.0.0.1:18789",
        hasProxyHeaders: true,
      }),
    ).toBe("remote");
    expect(
      resolvePairingLocality({
        ...base,
        requestHost: "127.0.0.1:18789",
        requestOrigin: "http://127.0.0.1:18789",
        sharedAuthOk: false,
      }),
    ).toBe("remote");
  });

  it("keeps non-Control-UI clients remote for browser-container-local conditions", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
    } as ConnectParams;
    expect(
      resolvePairingLocality({
        connectParams,
        isLocalClient: false,
        requestHost: "127.0.0.1:18789",
        requestOrigin: "http://127.0.0.1:18789",
        remoteAddress: "172.17.0.1",
        hasProxyHeaders: false,
        hasBrowserOriginHeader: true,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe("remote");
  });

  it("classifies CLI loopback/private-host connects as cli_container_local only with shared auth", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      },
    } as ConnectParams;
    expect(
      resolvePairingLocality({
        connectParams,
        isLocalClient: false,
        requestHost: "172.17.0.2:18789",
        remoteAddress: "127.0.0.1",
        hasProxyHeaders: false,
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe("cli_container_local");
    expect(
      resolvePairingLocality({
        connectParams,
        isLocalClient: false,
        requestHost: "172.17.0.2:18789",
        remoteAddress: "127.0.0.1",
        hasProxyHeaders: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe("remote");
    expect(
      resolvePairingLocality({
        connectParams,
        isLocalClient: false,
        requestHost: "gateway.example",
        remoteAddress: "127.0.0.1",
        hasProxyHeaders: false,
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe("remote");
    expect(
      resolvePairingLocality({
        connectParams,
        isLocalClient: false,
        requestHost: "172.17.0.2:18789",
        remoteAddress: "127.0.0.1",
        hasProxyHeaders: false,
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authMethod: "device-token",
      }),
    ).toBe("remote");
  });

  it("classifies non-CLI Docker-published loopback clients as shared_secret_loopback_local when auth is token/password", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
    } as ConnectParams;
    expect(
      resolvePairingLocality({
        connectParams,
        isLocalClient: false,
        requestHost: "172.17.0.2:18789",
        remoteAddress: "127.0.0.1",
        hasProxyHeaders: false,
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe("shared_secret_loopback_local");
  });

  it("skips backend self-pairing only for direct-local backend clients", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
    } as ConnectParams;
    expect(
      shouldSkipLocalBackendSelfPairing({
        connectParams,
        locality: "direct_local",
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe(true);
    expect(
      shouldSkipLocalBackendSelfPairing({
        connectParams,
        locality: "shared_secret_loopback_local",
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe(true);
    expect(
      shouldSkipLocalBackendSelfPairing({
        connectParams,
        locality: "remote",
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe(false);
    expect(
      shouldSkipLocalBackendSelfPairing({
        connectParams,
        locality: "remote",
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authMethod: "password",
      }),
    ).toBe(false);
    expect(
      shouldSkipLocalBackendSelfPairing({
        connectParams,
        locality: "direct_local",
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authMethod: "device-token",
      }),
    ).toBe(true);
    expect(
      shouldSkipLocalBackendSelfPairing({
        connectParams,
        locality: "remote",
        hasBrowserOriginHeader: false,
        sharedAuthOk: false,
        authMethod: "device-token",
      }),
    ).toBe(false);
    expect(
      shouldSkipLocalBackendSelfPairing({
        connectParams,
        locality: "cli_container_local",
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe(false);
  });

  it("does not skip backend self-pairing for CLI clients", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      },
    } as ConnectParams;
    expect(
      shouldSkipLocalBackendSelfPairing({
        connectParams,
        locality: "direct_local",
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe(false);
  });

  it("rejects pairing bypass when browser origin header is present", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
    } as ConnectParams;
    expect(
      shouldSkipLocalBackendSelfPairing({
        connectParams,
        locality: "direct_local",
        hasBrowserOriginHeader: true,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe(false);
  });

  it("classifies non-CLI loopback + shared-secret clients as shared_secret_loopback_local", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.NODE_HOST,
        mode: GATEWAY_CLIENT_MODES.NODE,
      },
    } as ConnectParams;
    expect(
      resolvePairingLocality({
        connectParams,
        isLocalClient: false,
        requestHost: "127.0.0.1:18789",
        remoteAddress: "127.0.0.1",
        hasProxyHeaders: false,
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe("shared_secret_loopback_local");
  });

  it("keeps non-CLI loopback clients remote without shared-secret auth", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.NODE_HOST,
        mode: GATEWAY_CLIENT_MODES.NODE,
      },
    } as ConnectParams;
    const base = {
      connectParams,
      isLocalClient: false,
      requestHost: "127.0.0.1:18789",
      remoteAddress: "127.0.0.1",
      hasProxyHeaders: false,
      hasBrowserOriginHeader: false,
    } as const;

    expect(
      resolvePairingLocality({
        ...base,
        sharedAuthOk: false,
        authMethod: "token",
      }),
    ).toBe("remote");
    expect(
      resolvePairingLocality({
        ...base,
        sharedAuthOk: true,
        authMethod: "device-token",
      }),
    ).toBe("remote");
    expect(
      resolvePairingLocality({
        ...base,
        remoteAddress: "192.168.1.10",
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe("remote");
    expect(
      resolvePairingLocality({
        ...base,
        hasProxyHeaders: true,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe("remote");
    expect(
      resolvePairingLocality({
        ...base,
        hasBrowserOriginHeader: true,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe("remote");
  });

  it("keeps shared-secret loopback clients remote when forwarded headers were present", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.NODE_HOST,
        mode: GATEWAY_CLIENT_MODES.NODE,
      },
    } as ConnectParams;

    expect(
      resolvePairingLocality({
        connectParams,
        isLocalClient: false,
        requestHost: "127.0.0.1:18789",
        remoteAddress: "127.0.0.1",
        hasProxyHeaders: true,
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe("remote");
  });

  it("allows silent scope-upgrade, role-upgrade, and metadata-upgrade for shared_secret_loopback_local", () => {
    expect(
      shouldAllowSilentLocalPairing({
        locality: "shared_secret_loopback_local",
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        reason: "scope-upgrade",
      }),
    ).toBe(true);
    expect(
      shouldAllowSilentLocalPairing({
        locality: "shared_secret_loopback_local",
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        reason: "role-upgrade",
      }),
    ).toBe(true);
    // metadata-upgrade now auto-approves for shared_secret_loopback_local
    // (extended allowlist — see shouldAllowSilentLocalPairing).
    expect(
      shouldAllowSilentLocalPairing({
        locality: "shared_secret_loopback_local",
        hasBrowserOriginHeader: false,
        isControlUi: false,
        isWebchat: false,
        reason: "metadata-upgrade",
      }),
    ).toBe(true);
  });

  describe("shouldAllowSilentLocalPairing — metadata-upgrade reason", () => {
    it("allows silent metadata-upgrade for direct local native app clients without browser origin", () => {
      expect(
        shouldAllowSilentLocalPairing({
          locality: "direct_local",
          hasBrowserOriginHeader: false,
          isControlUi: false,
          isWebchat: false,
          isNativeAppUi: true,
          reason: "metadata-upgrade",
        }),
      ).toBe(true);
    });

    it("still requires approval for direct local node metadata-upgrade", () => {
      expect(
        shouldAllowSilentLocalPairing({
          locality: "direct_local",
          hasBrowserOriginHeader: false,
          isControlUi: false,
          isWebchat: false,
          reason: "metadata-upgrade",
        }),
      ).toBe(false);
    });

    it("allows silent metadata-upgrade for cli_container_local CLI clients", () => {
      expect(
        shouldAllowSilentLocalPairing({
          locality: "cli_container_local",
          hasBrowserOriginHeader: false,
          isControlUi: false,
          isWebchat: false,
          reason: "metadata-upgrade",
        }),
      ).toBe(true);
    });

    it("allows silent metadata-upgrade for shared_secret_loopback_local CLI clients", () => {
      expect(
        shouldAllowSilentLocalPairing({
          locality: "shared_secret_loopback_local",
          hasBrowserOriginHeader: false,
          isControlUi: false,
          isWebchat: false,
          reason: "metadata-upgrade",
        }),
      ).toBe(true);
    });

    it("still requires approval for metadata-upgrade from remote clients", () => {
      expect(
        shouldAllowSilentLocalPairing({
          locality: "remote",
          hasBrowserOriginHeader: false,
          isControlUi: false,
          isWebchat: false,
          reason: "metadata-upgrade",
        }),
      ).toBe(false);
    });

    it("still requires approval for metadata-upgrade from browser_container_local (Control UI)", () => {
      expect(
        shouldAllowSilentLocalPairing({
          locality: "browser_container_local",
          hasBrowserOriginHeader: true,
          isControlUi: true,
          isWebchat: false,
          reason: "metadata-upgrade",
        }),
      ).toBe(false);
    });

    it("still requires approval for direct local Browser or Control UI metadata-upgrade", () => {
      expect(
        shouldAllowSilentLocalPairing({
          locality: "direct_local",
          hasBrowserOriginHeader: true,
          isControlUi: true,
          isWebchat: false,
          reason: "metadata-upgrade",
        }),
      ).toBe(false);
      expect(
        shouldAllowSilentLocalPairing({
          locality: "direct_local",
          hasBrowserOriginHeader: true,
          isControlUi: false,
          isWebchat: true,
          reason: "metadata-upgrade",
        }),
      ).toBe(false);
    });
  });

  it("prefers cli_container_local over shared_secret_loopback_local for CLI clients", () => {
    const connectParams = {
      client: {
        id: GATEWAY_CLIENT_IDS.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      },
    } as ConnectParams;
    expect(
      resolvePairingLocality({
        connectParams,
        isLocalClient: false,
        requestHost: "127.0.0.1:18789",
        remoteAddress: "127.0.0.1",
        hasProxyHeaders: false,
        hasBrowserOriginHeader: false,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe("cli_container_local");
  });
});
