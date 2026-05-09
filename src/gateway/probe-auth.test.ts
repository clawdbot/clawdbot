import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveGatewayProbeAuthSafe,
  resolveGatewayProbeAuthSafeWithSecretInputs,
  resolveGatewayProbeTarget,
  resolveGatewayProbeAuthWithSecretInputs,
} from "./probe-auth.js";

function expectUnresolvedProbeTokenWarning(cfg: OpenClawConfig) {
  const result = resolveGatewayProbeAuthSafe({
    cfg,
    mode: "local",
    env: {} as NodeJS.ProcessEnv,
  });

  expect(result.auth).toStrictEqual({});
  expect(result.warning).toContain("gateway.auth.token");
  expect(result.warning).toContain("unresolved");
}

describe("resolveGatewayProbeAuthSafe", () => {
  it("returns probe auth credentials when available", () => {
    const result = resolveGatewayProbeAuthSafe({
      cfg: {
        gateway: {
          auth: {
            token: "token-value",
          },
        },
      } as OpenClawConfig,
      mode: "local",
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      auth: {
        token: "token-value",
        password: undefined,
      },
    });
  });

  it("returns warning and empty auth when token SecretRef is unresolved", () => {
    expectUnresolvedProbeTokenWarning({
      gateway: {
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as OpenClawConfig);
  });

  it("does not fall through to remote token when local token SecretRef is unresolved", () => {
    expectUnresolvedProbeTokenWarning({
      gateway: {
        mode: "local",
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
        },
        remote: {
          token: "remote-token",
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as OpenClawConfig);
  });

  it("does not fall through to remote credentials for local probes", () => {
    const result = resolveGatewayProbeAuthSafe({
      cfg: {
        gateway: {
          mode: "local",
          remote: {
            url: "wss://gateway.example",
            token: "remote-token",
            password: "remote-password", // pragma: allowlist secret
          },
        },
      } as OpenClawConfig,
      mode: "local",
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      auth: {
        token: undefined,
        password: undefined,
      },
    });
  });

  it("ignores unresolved local token SecretRef in remote mode when remote-only auth is requested", () => {
    const result = resolveGatewayProbeAuthSafe({
      cfg: {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example",
          },
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "MISSING_LOCAL_TOKEN" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      mode: "remote",
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      auth: {
        token: undefined,
        password: undefined,
      },
    });
  });
});

describe("resolveGatewayProbeTarget", () => {
  it("falls back to local probe mode when remote mode is configured without remote url", () => {
    expect(
      resolveGatewayProbeTarget({
        gateway: {
          mode: "remote",
        },
      } as OpenClawConfig),
    ).toEqual({
      gatewayMode: "remote",
      mode: "local",
      remoteUrlMissing: true,
    });
  });

  it("keeps remote probe mode when remote url is configured", () => {
    expect(
      resolveGatewayProbeTarget({
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example",
          },
        },
      } as OpenClawConfig),
    ).toEqual({
      gatewayMode: "remote",
      mode: "remote",
      remoteUrlMissing: false,
    });
  });
});

describe("resolveGatewayProbeAuthSafeWithSecretInputs", () => {
  it("resolves env SecretRef token via async secret-inputs path", async () => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      mode: "local",
      env: {
        OPENCLAW_GATEWAY_TOKEN: "test-token-from-env",
      } as NodeJS.ProcessEnv,
    });

    expect(result.warning).toBeUndefined();
    expect(result.auth).toEqual({
      token: "test-token-from-env",
      password: undefined,
    });
  });

  it("returns empty auth without warning for gateway.remote SecretRefs in local probes", async () => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: {
        gateway: {
          mode: "local",
          remote: {
            url: "wss://gateway.example",
            token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      mode: "local",
      env: {
        REMOTE_GATEWAY_TOKEN: "remote-token",
      } as NodeJS.ProcessEnv,
    });

    expect(result.warning).toBeUndefined();
    expect(result.auth).toEqual({
      token: undefined,
      password: undefined,
    });
  });

  it("returns warning and empty auth when SecretRef cannot be resolved via async path", async () => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "MISSING_TOKEN_XYZ" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      mode: "local",
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result.auth).toStrictEqual({});
    expect(result.warning).toContain("gateway.auth.token");
    expect(result.warning).toContain("unresolved");
  });
});

describe("resolveGatewayProbeAuthWithSecretInputs", () => {
  it("resolves local probe SecretRef values before shared credential selection", async () => {
    const auth = await resolveGatewayProbeAuthWithSecretInputs({
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "DAEMON_GATEWAY_TOKEN" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      mode: "local",
      env: {
        DAEMON_GATEWAY_TOKEN: "resolved-daemon-token",
      } as NodeJS.ProcessEnv,
    });

    expect(auth).toEqual({
      token: "resolved-daemon-token",
      password: undefined,
    });
  });
});
