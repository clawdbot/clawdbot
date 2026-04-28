import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { evaluateGatewayAuthSurfaceStates } from "./runtime-gateway-auth-surfaces.js";

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

function envRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

function evaluate(config: OpenClawConfig, env: NodeJS.ProcessEnv = EMPTY_ENV) {
  return evaluateGatewayAuthSurfaceStates({
    config,
    env,
  });
}

describe("evaluateGatewayAuthSurfaceStates", () => {
  it("marks gateway.auth.token active when token mode is explicit", () => {
    const states = evaluate({
      gateway: {
        auth: {
          mode: "token",
          token: envRef("GW_AUTH_TOKEN"),
        },
      },
    } as OpenClawConfig);

    expect(states["gateway.auth.token"]).toMatchObject({
      hasSecretRef: true,
      active: true,
      reason: 'gateway.auth.mode is "token".',
    });
  });

  it("marks gateway.auth.token inactive when env token is configured", () => {
    const states = evaluate(
      {
        gateway: {
          auth: {
            mode: "token",
            token: envRef("GW_AUTH_TOKEN"),
          },
        },
      } as OpenClawConfig,
      { OPENCLAW_GATEWAY_TOKEN: "env-token" } as NodeJS.ProcessEnv,
    );

    expect(states["gateway.auth.token"]).toMatchObject({
      hasSecretRef: true,
      active: false,
      reason: "gateway token env var is configured.",
    });
  });

  it("marks gateway.auth.token inactive when password mode is explicit", () => {
    const states = evaluate({
      gateway: {
        auth: {
          mode: "password",
          token: envRef("GW_AUTH_TOKEN"),
        },
      },
    } as OpenClawConfig);

    expect(states["gateway.auth.token"]).toMatchObject({
      hasSecretRef: true,
      active: false,
      reason: 'gateway.auth.mode is "password".',
    });
  });

  it("marks gateway.auth.password active when password mode is explicit", () => {
    const states = evaluate({
      gateway: {
        auth: {
          mode: "password",
          password: envRef("GW_AUTH_PASSWORD"),
        },
      },
    } as OpenClawConfig);

    expect(states["gateway.auth.password"]).toMatchObject({
      hasSecretRef: true,
      active: true,
      reason: 'gateway.auth.mode is "password".',
    });
  });

  it("marks gateway.auth.password active when trusted-proxy mode is explicit", () => {
    const states = evaluate({
      gateway: {
        auth: {
          mode: "trusted-proxy",
          password: envRef("GW_AUTH_PASSWORD"),
        },
      },
    } as OpenClawConfig);

    expect(states["gateway.auth.password"]).toMatchObject({
      hasSecretRef: true,
      active: true,
      reason: "no token source can win, so password auth can win.",
    });
  });

  it("marks gateway.auth.password inactive when env token is configured", () => {
    const states = evaluate(
      {
        gateway: {
          auth: {
            password: envRef("GW_AUTH_PASSWORD"),
          },
        },
      } as OpenClawConfig,
      { OPENCLAW_GATEWAY_TOKEN: "env-token" } as NodeJS.ProcessEnv,
    );

    expect(states["gateway.auth.password"]).toMatchObject({
      hasSecretRef: true,
      active: false,
      reason: "gateway token env var is configured.",
    });
  });

  it("marks gateway.remote.token active when remote token fallback is active", () => {
    const states = evaluate({
      gateway: {
        mode: "local",
        remote: {
          token: envRef("GW_REMOTE_TOKEN"),
        },
      },
    } as OpenClawConfig);

    expect(states["gateway.remote.token"]).toMatchObject({
      hasSecretRef: true,
      active: true,
      reason: "local token auth can win and no env/auth token is configured.",
    });
  });

  it("marks gateway.remote.token inactive when token auth cannot win", () => {
    const states = evaluate({
      gateway: {
        auth: {
          mode: "password",
        },
        remote: {
          token: envRef("GW_REMOTE_TOKEN"),
        },
      },
    } as OpenClawConfig);

    expect(states["gateway.remote.token"]).toMatchObject({
      hasSecretRef: true,
      active: false,
      reason: 'token auth cannot win with gateway.auth.mode="password".',
    });
  });

  it("marks gateway.remote.token inactive when local token SecretRef is configured", () => {
    const states = evaluate({
      gateway: {
        mode: "local",
        auth: {
          mode: "token",
          token: envRef("GW_AUTH_TOKEN"),
        },
        remote: {
          token: envRef("GW_REMOTE_TOKEN"),
        },
      },
    } as OpenClawConfig);

    expect(states["gateway.remote.token"]).toMatchObject({
      hasSecretRef: true,
      active: false,
      reason: "gateway.auth.token is configured.",
    });
  });

  it("marks gateway.remote.password active when remote url is configured", () => {
    const states = evaluate({
      gateway: {
        remote: {
          url: "wss://gateway.example.com",
          password: envRef("GW_REMOTE_PASSWORD"),
        },
      },
    } as OpenClawConfig);

    expect(states["gateway.remote.password"].hasSecretRef).toBe(true);
    expect(states["gateway.remote.password"].active).toBe(true);
    expect(states["gateway.remote.password"].reason).toContain("remote surface is active:");
    expect(states["gateway.remote.password"].reason).toContain("gateway.remote.url is configured");
  });

  it("marks gateway.remote.password inactive when password auth cannot win", () => {
    const states = evaluate({
      gateway: {
        auth: {
          mode: "token",
        },
        remote: {
          password: envRef("GW_REMOTE_PASSWORD"),
        },
      },
    } as OpenClawConfig);

    expect(states["gateway.remote.password"]).toMatchObject({
      hasSecretRef: true,
      active: false,
      reason: 'password auth cannot win with gateway.auth.mode="token".',
    });
  });

  it("marks gateway.remote.password inactive as a trusted-proxy local fallback", () => {
    const states = evaluate({
      gateway: {
        mode: "local",
        auth: {
          mode: "trusted-proxy",
        },
        remote: {
          password: envRef("GW_REMOTE_PASSWORD"),
        },
      },
    } as OpenClawConfig);

    expect(states["gateway.remote.password"]).toMatchObject({
      hasSecretRef: true,
      active: false,
      reason: "remote password fallback is not active.",
    });
  });
});
