// Handshake auth helper tests cover browser-origin security, pairing locality, and auth error details.
import { describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams } from "../../../../packages/gateway-protocol/src/schema.js";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import {
  BROWSER_ORIGIN_RATE_LIMIT_KEY_PREFIX,
  BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP,
  resolveHandshakeBrowserSecurityContext,
  resolvePairingLocality,
  resolveUnauthorizedHandshakeContext,
  shouldAllowSilentLocalPairing,
  shouldSkipLocalBackendSelfPairing,
} from "./handshake-auth-helpers.js";

type PairingLocalityParams = Parameters<typeof resolvePairingLocality>[0];
type PairingLocalityOverrides = {
  connectParams?: ConnectParams;
  isLocalClient?: boolean;
  requestHost?: string;
  requestOrigin?: string;
  remoteAddress?: string;
  hasProxyHeaders?: boolean;
  hasBrowserOriginHeader?: boolean;
  sharedAuthOk?: boolean;
  authMethod?: PairingLocalityParams["authMethod"];
};
type SilentLocalPairingParams = Parameters<typeof shouldAllowSilentLocalPairing>[0];
type BackendSelfPairingParams = Parameters<typeof shouldSkipLocalBackendSelfPairing>[0];

const CONTROL_UI_WEBCHAT_CONNECT_PARAMS = {
  client: {
    id: GATEWAY_CLIENT_IDS.CONTROL_UI,
    mode: GATEWAY_CLIENT_MODES.WEBCHAT,
  },
} as ConnectParams;

const GATEWAY_BACKEND_CONNECT_PARAMS = {
  client: {
    id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
  },
} as ConnectParams;

const NODE_HOST_CONNECT_PARAMS = {
  client: {
    id: GATEWAY_CLIENT_IDS.NODE_HOST,
    mode: GATEWAY_CLIENT_MODES.NODE,
  },
} as ConnectParams;

const CLI_CONNECT_PARAMS = {
  client: {
    id: GATEWAY_CLIENT_IDS.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  },
} as ConnectParams;

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

function resolveDockerPublishedBrowserLocality(overrides: PairingLocalityOverrides = {}) {
  return resolvePairingLocality({
    connectParams: overrides.connectParams ?? CONTROL_UI_WEBCHAT_CONNECT_PARAMS,
    isLocalClient: overrides.isLocalClient ?? false,
    requestHost: overrides.requestHost ?? "127.0.0.1:18789",
    requestOrigin: overrides.requestOrigin ?? "http://127.0.0.1:18789",
    remoteAddress: overrides.remoteAddress ?? "172.17.0.1",
    hasProxyHeaders: overrides.hasProxyHeaders ?? false,
    hasBrowserOriginHeader: overrides.hasBrowserOriginHeader ?? true,
    sharedAuthOk: overrides.sharedAuthOk ?? true,
    authMethod: overrides.authMethod ?? "token",
  });
}

function resolveLoopbackLocality(
  connectParams: ConnectParams,
  overrides: PairingLocalityOverrides = {},
  requestHost = "127.0.0.1:18789",
) {
  return resolvePairingLocality({
    connectParams: overrides.connectParams ?? connectParams,
    isLocalClient: overrides.isLocalClient ?? false,
    requestHost: overrides.requestHost ?? requestHost,
    requestOrigin: overrides.requestOrigin,
    remoteAddress: overrides.remoteAddress ?? "127.0.0.1",
    hasProxyHeaders: overrides.hasProxyHeaders ?? false,
    hasBrowserOriginHeader: overrides.hasBrowserOriginHeader ?? false,
    sharedAuthOk: overrides.sharedAuthOk ?? true,
    authMethod: overrides.authMethod ?? "token",
  });
}

function resolveNodeLoopbackLocality(overrides: PairingLocalityOverrides = {}) {
  return resolveLoopbackLocality(NODE_HOST_CONNECT_PARAMS, overrides);
}

function resolveCliLoopbackLocality(overrides: PairingLocalityOverrides = {}) {
  return resolveLoopbackLocality(CLI_CONNECT_PARAMS, overrides, "172.17.0.2:18789");
}

function allowSilentLocalPairing(overrides: Partial<SilentLocalPairingParams>) {
  return shouldAllowSilentLocalPairing({
    locality: "direct_local",
    hasBrowserOriginHeader: false,
    isControlUi: false,
    isWebchat: false,
    reason: "not-paired",
    ...overrides,
  });
}

function skipBackendSelfPairing(overrides: Partial<BackendSelfPairingParams> = {}) {
  return shouldSkipLocalBackendSelfPairing({
    connectParams: GATEWAY_BACKEND_CONNECT_PARAMS,
    locality: "direct_local",
    hasBrowserOriginHeader: false,
    sharedAuthOk: true,
    authMethod: "token",
    ...overrides,
  });
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

    expect(resolved.hasBrowserOriginHeader).toBe(true);
    expect(resolved.enforceOriginCheckForAnyClient).toBe(true);
    expect(resolved.rateLimitClientIp).toBe(
      `${BROWSER_ORIGIN_RATE_LIMIT_KEY_PREFIX}https://app.example`,
    );
    expect(resolved.authRateLimiter).toBe(browserRateLimiter);
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

  it("treats device-token scope mismatch as configuration review guidance", () => {
    const resolved = resolveUnauthorizedHandshakeContext({
      connectAuth: { deviceToken: "device-token" },
      failedAuth: { ok: false, reason: "scope_mismatch" },
      hasDeviceIdentity: true,
    });

    expect(resolved).toEqual({
      authProvided: "device-token",
      canRetryWithDeviceToken: false,
      recommendedNextStep: "review_auth_configuration",
    });
  });

  it("allows silent local pairing for not-paired, scope-upgrade and role-upgrade", () => {
    expect(
      allowSilentLocalPairing({
        reason: "not-paired",
      }),
    ).toBe(true);
    expect(
      allowSilentLocalPairing({
        reason: "role-upgrade",
      }),
    ).toBe(true);
    expect(
      allowSilentLocalPairing({
        reason: "scope-upgrade",
      }),
    ).toBe(true);
    expect(
      allowSilentLocalPairing({
        reason: "metadata-upgrade",
      }),
    ).toBe(false);
  });

  it("allows Control UI or WebChat browser-origin pairing but keeps other browser-origin clients explicit", () => {
    expect(
      allowSilentLocalPairing({
        locality: "browser_container_local",
        hasBrowserOriginHeader: true,
        isControlUi: true,
        isWebchat: true,
        reason: "not-paired",
      }),
    ).toBe(true);
    expect(
      allowSilentLocalPairing({
        locality: "shared_secret_loopback_local",
        hasBrowserOriginHeader: true,
        isWebchat: true,
        reason: "scope-upgrade",
      }),
    ).toBe(true);
    expect(
      allowSilentLocalPairing({
        locality: "shared_secret_loopback_local",
        hasBrowserOriginHeader: true,
        reason: "scope-upgrade",
      }),
    ).toBe(false);
  });

  it("rejects silent role-upgrade for remote clients", () => {
    expect(
      allowSilentLocalPairing({
        locality: "remote",
        reason: "role-upgrade",
      }),
    ).toBe(false);
  });

  it("allows Control UI browser-origin local pairing for fresh pairing and upgrades", () => {
    for (const locality of ["direct_local", "browser_container_local"] as const) {
      expect(
        allowSilentLocalPairing({
          locality,
          hasBrowserOriginHeader: true,
          isControlUi: true,
          isWebchat: true,
          reason: "not-paired",
        }),
      ).toBe(true);
      expect(
        allowSilentLocalPairing({
          locality,
          hasBrowserOriginHeader: true,
          isControlUi: true,
          isWebchat: true,
          reason: "role-upgrade",
        }),
      ).toBe(true);
    }
  });

  it("classifies direct local requests ahead of any Docker CLI fallback", () => {
    expect(
      resolvePairingLocality({
        connectParams: CLI_CONNECT_PARAMS,
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
    expect(resolveDockerPublishedBrowserLocality()).toBe("browser_container_local");
    expect(
      resolveDockerPublishedBrowserLocality({
        requestHost: "localhost:18789",
        requestOrigin: "http://localhost:18789",
        authMethod: "password",
      }),
    ).toBe("browser_container_local");
  });

  it("keeps Docker-published non-loopback Control UI origins remote", () => {
    expect(
      resolveDockerPublishedBrowserLocality({
        requestHost: "192.168.1.10:18789",
        requestOrigin: "http://192.168.1.10:18789",
      }),
    ).toBe("remote");
    expect(
      resolveDockerPublishedBrowserLocality({
        requestOrigin: "https://app.example",
      }),
    ).toBe("remote");
    expect(
      resolveDockerPublishedBrowserLocality({
        hasProxyHeaders: true,
      }),
    ).toBe("remote");
    expect(
      resolveDockerPublishedBrowserLocality({
        sharedAuthOk: false,
      }),
    ).toBe("remote");
  });

  it("keeps non-Control-UI clients remote for browser-container-local conditions", () => {
    expect(
      resolveDockerPublishedBrowserLocality({
        connectParams: GATEWAY_BACKEND_CONNECT_PARAMS,
      }),
    ).toBe("remote");
  });

  it("classifies CLI loopback/private-host connects as cli_container_local only with shared auth", () => {
    expect(resolveCliLoopbackLocality()).toBe("cli_container_local");
    expect(
      resolveCliLoopbackLocality({
        hasProxyHeaders: true,
      }),
    ).toBe("remote");
    expect(
      resolveCliLoopbackLocality({
        requestHost: "gateway.example",
      }),
    ).toBe("remote");
    expect(
      resolveCliLoopbackLocality({
        authMethod: "device-token",
      }),
    ).toBe("remote");
  });

  it("classifies non-CLI Docker-published loopback clients as shared_secret_loopback_local when auth is token/password", () => {
    expect(
      resolvePairingLocality({
        connectParams: GATEWAY_BACKEND_CONNECT_PARAMS,
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
    expect(skipBackendSelfPairing()).toBe(true);
    expect(
      skipBackendSelfPairing({
        locality: "shared_secret_loopback_local",
      }),
    ).toBe(true);
    expect(
      skipBackendSelfPairing({
        locality: "remote",
      }),
    ).toBe(false);
    expect(
      skipBackendSelfPairing({
        locality: "remote",
        authMethod: "password",
      }),
    ).toBe(false);
    expect(
      skipBackendSelfPairing({
        sharedAuthOk: false,
        authMethod: "device-token",
      }),
    ).toBe(true);
    expect(
      skipBackendSelfPairing({
        locality: "remote",
        sharedAuthOk: false,
        authMethod: "device-token",
      }),
    ).toBe(false);
    expect(
      skipBackendSelfPairing({
        locality: "cli_container_local",
      }),
    ).toBe(false);
  });

  it("does not skip backend self-pairing for CLI clients", () => {
    expect(
      skipBackendSelfPairing({
        connectParams: CLI_CONNECT_PARAMS,
      }),
    ).toBe(false);
  });

  it("rejects pairing bypass when browser origin header is present", () => {
    expect(
      skipBackendSelfPairing({
        hasBrowserOriginHeader: true,
      }),
    ).toBe(false);
  });

  it("skips backend self-pairing when auth mode is none (scoped, sharedAuthOk-independent)", () => {
    // auth:none on local backend skips regardless of sharedAuthOk
    expect(
      skipBackendSelfPairing({
        authMethod: "none",
      }),
    ).toBe(true);
    expect(
      skipBackendSelfPairing({
        locality: "shared_secret_loopback_local",
        authMethod: "none",
      }),
    ).toBe(true);
    // sharedAuthOk=false is fine for auth:none on local backend
    expect(
      skipBackendSelfPairing({
        sharedAuthOk: false,
        authMethod: "none",
      }),
    ).toBe(true);
    // Remote connections with auth:none should NOT skip
    expect(
      skipBackendSelfPairing({
        locality: "remote",
        authMethod: "none",
      }),
    ).toBe(false);
    // Browser origin with auth:none should NOT skip
    expect(
      skipBackendSelfPairing({
        hasBrowserOriginHeader: true,
        sharedAuthOk: false,
        authMethod: "none",
      }),
    ).toBe(false);
  });

  it("classifies non-CLI loopback + shared-secret clients as shared_secret_loopback_local", () => {
    expect(resolveNodeLoopbackLocality()).toBe("shared_secret_loopback_local");
  });

  it("keeps non-CLI loopback clients remote without shared-secret auth", () => {
    expect(
      resolveNodeLoopbackLocality({
        sharedAuthOk: false,
        authMethod: "token",
      }),
    ).toBe("remote");
    expect(
      resolveNodeLoopbackLocality({
        sharedAuthOk: true,
        authMethod: "device-token",
      }),
    ).toBe("remote");
    expect(
      resolveNodeLoopbackLocality({
        remoteAddress: "192.168.1.10",
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe("remote");
    expect(
      resolveNodeLoopbackLocality({
        hasProxyHeaders: true,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe("remote");
    expect(
      resolveNodeLoopbackLocality({
        hasBrowserOriginHeader: true,
        sharedAuthOk: true,
        authMethod: "token",
      }),
    ).toBe("remote");
  });

  it("keeps shared-secret loopback clients remote when forwarded headers were present", () => {
    expect(
      resolveNodeLoopbackLocality({
        hasProxyHeaders: true,
      }),
    ).toBe("remote");
  });

  it("allows silent scope-upgrade, role-upgrade, and metadata-upgrade for shared_secret_loopback_local", () => {
    expect(
      allowSilentLocalPairing({
        locality: "shared_secret_loopback_local",
        reason: "scope-upgrade",
      }),
    ).toBe(true);
    expect(
      allowSilentLocalPairing({
        locality: "shared_secret_loopback_local",
        reason: "role-upgrade",
      }),
    ).toBe(true);
    // metadata-upgrade now auto-approves for shared_secret_loopback_local
    // (extended allowlist — see shouldAllowSilentLocalPairing).
    expect(
      allowSilentLocalPairing({
        locality: "shared_secret_loopback_local",
        reason: "metadata-upgrade",
      }),
    ).toBe(true);
  });

  describe("shouldAllowSilentLocalPairing — metadata-upgrade reason", () => {
    it("allows silent metadata-upgrade for direct local native app clients without browser origin", () => {
      expect(
        allowSilentLocalPairing({
          isNativeAppUi: true,
          reason: "metadata-upgrade",
        }),
      ).toBe(true);
    });

    it("still requires approval for direct local node metadata-upgrade", () => {
      expect(
        allowSilentLocalPairing({
          reason: "metadata-upgrade",
        }),
      ).toBe(false);
    });

    it("allows silent metadata-upgrade for cli_container_local CLI clients", () => {
      expect(
        allowSilentLocalPairing({
          locality: "cli_container_local",
          reason: "metadata-upgrade",
        }),
      ).toBe(true);
    });

    it("allows silent metadata-upgrade for shared_secret_loopback_local CLI clients", () => {
      expect(
        allowSilentLocalPairing({
          locality: "shared_secret_loopback_local",
          reason: "metadata-upgrade",
        }),
      ).toBe(true);
    });

    it("still requires approval for metadata-upgrade from remote clients", () => {
      expect(
        allowSilentLocalPairing({
          locality: "remote",
          reason: "metadata-upgrade",
        }),
      ).toBe(false);
    });

    it("still requires approval for metadata-upgrade from browser_container_local (Control UI)", () => {
      expect(
        allowSilentLocalPairing({
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
        allowSilentLocalPairing({
          hasBrowserOriginHeader: true,
          isControlUi: true,
          reason: "metadata-upgrade",
        }),
      ).toBe(false);
      expect(
        allowSilentLocalPairing({
          hasBrowserOriginHeader: true,
          isWebchat: true,
          reason: "metadata-upgrade",
        }),
      ).toBe(false);
    });
  });

  it("prefers cli_container_local over shared_secret_loopback_local for CLI clients", () => {
    expect(
      resolveCliLoopbackLocality({
        requestHost: "127.0.0.1:18789",
      }),
    ).toBe("cli_container_local");
  });
});
