// Credential precedence parity tests keep call, probe, status, and auth surfaces
// aligned on local/remote gateway token and password resolution.
import { describe, expect, it } from "vitest";
import { resolveGatewayProbeAuth as resolveStatusGatewayProbeAuth } from "../commands/status.gateway-probe.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayAuth } from "./auth.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";
import { resolveGatewayProbeAuth } from "./probe-auth.js";

type ExpectedCredentialSet = {
  call: { token?: string; password?: string };
  probe: { token?: string; password?: string };
  status: { token?: string; password?: string };
  auth: { token?: string; password?: string };
};

type TestCase = {
  name: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  expected: ExpectedCredentialSet;
};

const gatewayEnv = {
  OPENCLAW_GATEWAY_TOKEN: "env-token", // pragma: allowlist secret
  OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
} as NodeJS.ProcessEnv;

function makeRemoteGatewayConfig(remote: { token?: string; password?: string }): OpenClawConfig {
  return {
    gateway: {
      mode: "remote",
      remote,
      auth: {
        token: "local-token",
        password: "local-password", // pragma: allowlist secret
      },
    },
  } as OpenClawConfig;
}

function withGatewayAuthEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const keys = [
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
    "OPENCLAW_SERVICE_KIND",
  ] as const;
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    const nextValue = env[key];
    if (typeof nextValue === "string") {
      process.env[key] = nextValue;
    } else {
      delete process.env[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (typeof value === "string") {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  }
}

describe("gateway credential precedence coverage", () => {
  const cases: TestCase[] = [
    {
      name: "local mode: env overrides config for call/probe/status, auth remains config-first",
      cfg: {
        gateway: {
          mode: "local",
          auth: {
            token: "config-token",
            password: "config-password", // pragma: allowlist secret
          },
        },
      } as OpenClawConfig,
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token", // pragma: allowlist secret
        OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      expected: {
        call: { token: "env-token", password: "env-password" }, // pragma: allowlist secret
        probe: { token: "env-token", password: "env-password" }, // pragma: allowlist secret
        status: { token: "config-token", password: "config-password" }, // pragma: allowlist secret
        auth: { token: "config-token", password: "config-password" }, // pragma: allowlist secret
      },
    },
    {
      name: "remote mode with remote token configured",
      cfg: makeRemoteGatewayConfig({
        token: "remote-token",
        password: "remote-password", // pragma: allowlist secret
      }),
      env: gatewayEnv,
      expected: {
        call: { token: "remote-token", password: "env-password" }, // pragma: allowlist secret
        probe: { token: "remote-token", password: "env-password" }, // pragma: allowlist secret
        status: { token: "local-token", password: "local-password" }, // pragma: allowlist secret
        auth: { token: "local-token", password: "local-password" }, // pragma: allowlist secret
      },
    },
    {
      name: "remote mode without remote token keeps remote probe/status strict",
      cfg: makeRemoteGatewayConfig({
        password: "remote-password", // pragma: allowlist secret
      }),
      env: gatewayEnv,
      expected: {
        call: { token: "env-token", password: "env-password" }, // pragma: allowlist secret
        probe: { token: undefined, password: "env-password" }, // pragma: allowlist secret
        status: { token: "local-token", password: "local-password" }, // pragma: allowlist secret
        auth: { token: "local-token", password: "local-password" }, // pragma: allowlist secret
      },
    },
    {
      name: "local mode in gateway service runtime uses config-first token precedence",
      cfg: {
        gateway: {
          mode: "local",
          auth: {
            token: "config-token",
            password: "config-password", // pragma: allowlist secret
          },
        },
      } as OpenClawConfig,
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
        OPENCLAW_SERVICE_KIND: "gateway",
      } as NodeJS.ProcessEnv,
      expected: {
        call: { token: "config-token", password: "env-password" }, // pragma: allowlist secret
        probe: { token: "config-token", password: "env-password" }, // pragma: allowlist secret
        status: { token: "config-token", password: "config-password" }, // pragma: allowlist secret
        auth: { token: "config-token", password: "config-password" }, // pragma: allowlist secret
      },
    },
  ];

  it.each(cases)("$name", async ({ cfg, env, expected }) => {
    const mode = cfg.gateway?.mode === "remote" ? "remote" : "local";
    const call = resolveGatewayCredentialsFromConfig({
      cfg,
      env,
    });
    const probe = resolveGatewayProbeAuth({
      cfg,
      mode,
      env,
    });
    const status = await withGatewayAuthEnv(env, () => resolveStatusGatewayProbeAuth(cfg));
    const auth = resolveGatewayAuth({
      authConfig: cfg.gateway?.auth,
      env,
    });

    expect(call).toEqual(expected.call);
    expect(probe).toEqual(expected.probe);
    expect(status).toEqual(expected.status);
    expect({ token: auth.token, password: auth.password }).toEqual(expected.auth);
  });
});
