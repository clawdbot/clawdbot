// Tests setup code generation and environment-derived defaults.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretInput } from "../config/types.secrets.js";
import { captureEnv } from "../test-utils/env.js";

vi.mock("../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: vi.fn(async () => ({
    token: "bootstrap-123",
    expiresAtMs: 123,
  })),
}));

const { encodePairingSetupCode, resolvePairingSetupFromConfig } = await import("./setup-code.js");
const { issueDeviceBootstrapToken: issueDeviceBootstrapTokenMock } =
  await import("../infra/device-bootstrap.js");

describe("pairing setup code", () => {
  type ResolvedSetup = Awaited<ReturnType<typeof resolvePairingSetupFromConfig>>;
  type ResolveSetupConfig = Parameters<typeof resolvePairingSetupFromConfig>[0];
  type ResolveSetupOptions = Parameters<typeof resolvePairingSetupFromConfig>[1];
  type ResolveSetupEnv = NonNullable<ResolveSetupOptions>["env"];
  const defaultEnvSecretProviderConfig = {
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
  } as const;
  const gatewayPasswordSecretRef: SecretInput = {
    source: "env",
    provider: "default",
    id: "GW_PASSWORD",
  };
  const missingGatewayTokenSecretRef: SecretInput = {
    source: "env",
    provider: "default",
    id: "MISSING_GW_TOKEN",
  };

  function createCustomGatewayConfig(
    auth: NonNullable<ResolveSetupConfig["gateway"]>["auth"],
    config: Omit<ResolveSetupConfig, "gateway"> = {},
  ): ResolveSetupConfig {
    return {
      ...config,
      gateway: {
        bind: "custom",
        customBindHost: "127.0.0.1",
        auth,
      },
    };
  }

  function createTailnetDnsRunner() {
    return vi.fn(async () => ({
      code: 0,
      stdout: '{"Self":{"DNSName":"mb-server.tailnet.ts.net."}}',
      stderr: "",
    }));
  }

  function createTailnetIpRunner() {
    return vi.fn(async () => ({
      code: 0,
      stdout: '{"Self":{"TailscaleIPs":["100.64.0.9"]}}',
      stderr: "",
    }));
  }

  function createNoRouteRunner() {
    return vi.fn(async () => ({
      code: 1,
      stdout: "",
      stderr: "",
    }));
  }

  function createDefaultRouteRunner(interfaceName: string) {
    const stdout =
      process.platform === "win32"
        ? JSON.stringify({ InterfaceAlias: interfaceName })
        : process.platform === "linux"
          ? `default via 10.211.55.1 dev ${interfaceName} proto dhcp metric 100\n`
          : `   route to: default\ninterface: ${interfaceName}\n`;
    return vi.fn(async () => ({
      code: 0,
      stdout,
      stderr: "",
    }));
  }

  function createIpv4NetworkInterfaces(
    address: string,
  ): ReturnType<NonNullable<NonNullable<ResolveSetupOptions>["networkInterfaces"]>> {
    return {
      en0: [
        {
          address,
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.0",
          mac: "00:00:00:00:00:00",
          cidr: `${address}/24`,
        },
      ],
    };
  }

  function expectResolvedSetupOk(
    resolved: ResolvedSetup,
    params: {
      authLabel: string;
      url?: string;
      urls?: string[];
      urlSource?: string;
      bootstrapProfile?: { roles: string[]; scopes: string[] };
    },
  ) {
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error("expected setup resolution to succeed");
    }
    expect(resolved.authLabel).toBe(params.authLabel);
    expect(resolved.payload.bootstrapToken).toBe("bootstrap-123");
    expect(issueDeviceBootstrapTokenMock).toHaveBeenCalledWith({
      baseDir: undefined,
      profile: params.bootstrapProfile ?? {
        roles: ["node", "operator"],
        scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
      },
    });
    if (params.url) {
      expect(resolved.payload.url).toBe(params.url);
    }
    if (params.urls) {
      expect(resolved.payload.urls).toEqual(params.urls);
    }
    if (params.urlSource) {
      expect(resolved.urlSource).toBe(params.urlSource);
    }
  }

  function expectResolvedSetupError(resolved: ResolvedSetup, snippet: string) {
    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      throw new Error("expected setup resolution to fail");
    }
    expect(resolved.error).toContain(snippet);
  }

  async function expectResolvedSetupSuccessCase(params: {
    config: ResolveSetupConfig;
    options?: ResolveSetupOptions;
    expected: {
      authLabel: string;
      url: string;
      urls?: string[];
      urlSource: string;
      bootstrapProfile?: { roles: string[]; scopes: string[] };
    };
    runCommandWithTimeout?: ReturnType<typeof vi.fn>;
    expectedRunCommandCalls?: number;
  }) {
    const resolved = await resolvePairingSetupFromConfig(params.config, params.options);
    expectResolvedSetupOk(resolved, params.expected);
    if (params.runCommandWithTimeout) {
      expect(params.runCommandWithTimeout).toHaveBeenCalledTimes(
        params.expectedRunCommandCalls ?? 0,
      );
    }
  }

  async function expectResolvedSetupFailureCase(params: {
    config: ResolveSetupConfig;
    options?: ResolveSetupOptions;
    expectedError: string;
  }) {
    try {
      const resolved = await resolvePairingSetupFromConfig(params.config, params.options);
      expectResolvedSetupError(resolved, params.expectedError);
    } catch (error) {
      expect(String(error)).toContain(params.expectedError);
    }
  }

  async function expectResolveCustomGatewayRejects(params: {
    auth: NonNullable<ResolveSetupConfig["gateway"]>["auth"];
    env?: ResolveSetupEnv;
    config?: Omit<ResolveSetupConfig, "gateway">;
    expectedError: RegExp | string;
  }) {
    await expect(
      resolveCustomGatewaySetup({
        auth: params.auth,
        env: params.env,
        config: params.config,
      }),
    ).rejects.toThrow(params.expectedError);
  }

  async function expectResolvedCustomGatewaySetupOk(params: {
    auth: NonNullable<ResolveSetupConfig["gateway"]>["auth"];
    env?: ResolveSetupEnv;
    config?: Omit<ResolveSetupConfig, "gateway">;
    expectedAuthLabel: string;
  }) {
    const resolved = await resolveCustomGatewaySetup({
      auth: params.auth,
      env: params.env,
      config: params.config,
    });
    expectResolvedSetupOk(resolved, { authLabel: params.expectedAuthLabel });
  }

  let gatewayEnvSnapshot: ReturnType<typeof captureEnv> | undefined;

  beforeEach(() => {
    gatewayEnvSnapshot = captureEnv([
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
      "OPENCLAW_GATEWAY_PORT",
    ]);
    process.env.OPENCLAW_GATEWAY_TOKEN = "";
    process.env.OPENCLAW_GATEWAY_PASSWORD = "";
    process.env.OPENCLAW_GATEWAY_PORT = "";
  });

  beforeEach(() => {
    vi.mocked(issueDeviceBootstrapTokenMock).mockClear();
  });

  afterEach(() => {
    gatewayEnvSnapshot?.restore();
    gatewayEnvSnapshot = undefined;
  });

  it.each([
    {
      name: "encodes payload as base64url JSON",
      payload: {
        url: "wss://gateway.example.com:443",
        bootstrapToken: "abc",
      },
      expected:
        "eyJ1cmwiOiJ3c3M6Ly9nYXRld2F5LmV4YW1wbGUuY29tOjQ0MyIsImJvb3RzdHJhcFRva2VuIjoiYWJjIn0",
    },
  ] as const)("$name", ({ payload, expected }) => {
    expect(encodePairingSetupCode(payload)).toBe(expected);
  });

  it("normalizes bare publicUrl host ports for setup code payloads", async () => {
    await expectResolvedSetupSuccessCase({
      config: createCustomGatewayConfig({ mode: "token", token: "tok_123" }),
      options: {
        forceSecure: true,
        publicUrl: "gateway.example.test:18789/setup",
      },
      expected: {
        authLabel: "token",
        url: "wss://gateway.example.test:18789",
        urlSource: "plugins.entries.device-pair.config.publicUrl",
      },
    });
  });

  it("issues a node-only bootstrap profile for companion setup", async () => {
    await expectResolvedSetupSuccessCase({
      config: createCustomGatewayConfig({ mode: "token", token: "tok_123" }),
      options: {
        forceSecure: true,
        publicUrl: "gateway.example.test:18789/setup",
        bootstrapProfile: { roles: ["node"], scopes: [] },
      },
      expected: {
        authLabel: "token",
        url: "wss://gateway.example.test:18789",
        urlSource: "plugins.entries.device-pair.config.publicUrl",
        bootstrapProfile: { roles: ["node"], scopes: [] },
      },
    });
  });

  it("rejects invalid gateway.remote.url before falling back to bind-derived setup urls", async () => {
    await expectResolvedSetupFailureCase({
      config: {
        gateway: {
          bind: "custom",
          customBindHost: "127.0.0.1",
          remote: { url: "http://localhost:notaport" },
          auth: { mode: "token", token: "tok_123" },
        },
      },
      options: {
        preferRemoteUrl: true,
      },
      expectedError: "Configured gateway.remote.url is invalid.",
    });
    expect(issueDeviceBootstrapTokenMock).not.toHaveBeenCalled();
  });

  it.each([
    "localhost:notaport",
    "http://localhost:notaport",
    "http:gateway.example.test",
    "ws:gateway.example.test",
    "http:/localhost:notaport",
    "ftp:/gateway.example.test",
    "mailto:foo@example.com",
    "ws://user:pass@gateway.example.test:18789",
  ])("rejects invalid publicUrl %s before issuing setup code payloads", async (publicUrl) => {
    await expectResolvedSetupFailureCase({
      config: createCustomGatewayConfig({ mode: "token", token: "tok_123" }),
      options: {
        forceSecure: true,
        publicUrl,
      },
      expectedError: "Configured publicUrl is invalid.",
    });
    expect(issueDeviceBootstrapTokenMock).not.toHaveBeenCalled();
  });

  async function resolveCustomGatewaySetup(params: {
    auth: NonNullable<ResolveSetupConfig["gateway"]>["auth"];
    env?: ResolveSetupEnv;
    config?: Omit<ResolveSetupConfig, "gateway">;
  }) {
    return await resolvePairingSetupFromConfig(
      createCustomGatewayConfig(params.auth, params.config),
      {
        env: params.env ?? {},
      },
    );
  }

  it.each([
    {
      name: "resolves gateway.auth.password SecretRef for pairing payload",
      auth: {
        mode: "password",
        password: gatewayPasswordSecretRef,
      } as const,
      env: {
        GW_PASSWORD: "resolved-password", // pragma: allowlist secret
      },
      expectedAuthLabel: "password",
    },
    {
      name: "uses OPENCLAW_GATEWAY_PASSWORD without resolving configured password SecretRef",
      auth: {
        mode: "password",
        password: { source: "env", provider: "default", id: "MISSING_GW_PASSWORD" },
      } as const,
      env: {
        OPENCLAW_GATEWAY_PASSWORD: "password-from-env", // pragma: allowlist secret
      },
      expectedAuthLabel: "password",
    },
    {
      name: "does not resolve gateway.auth.password SecretRef in token mode",
      auth: {
        mode: "token",
        token: "tok_123",
        password: { source: "env", provider: "missing", id: "GW_PASSWORD" },
      } as const,
      env: {},
      expectedAuthLabel: "token",
    },
    {
      name: "resolves gateway.auth.token SecretRef for pairing payload",
      auth: {
        mode: "token",
        token: { source: "env", provider: "default", id: "GW_TOKEN" },
      } as const,
      env: {
        GW_TOKEN: "resolved-token",
      },
      expectedAuthLabel: "token",
    },
  ] as const)("$name", async ({ auth, env, expectedAuthLabel }) => {
    await expectResolvedCustomGatewaySetupOk({
      auth,
      env,
      config: defaultEnvSecretProviderConfig,
      expectedAuthLabel,
    });
  });

  it.each([
    {
      name: "errors when gateway.auth.token SecretRef is unresolved in token mode",
      config: createCustomGatewayConfig(
        {
          mode: "token",
          token: missingGatewayTokenSecretRef,
        },
        defaultEnvSecretProviderConfig,
      ),
      options: { env: {} },
      expectedError: "MISSING_GW_TOKEN",
    },
  ] as const)("$name", async ({ config, options, expectedError }) => {
    await expectResolvedSetupFailureCase({ config, options, expectedError });
  });

  async function resolveInferredModeWithPasswordEnv(token: SecretInput) {
    return await resolvePairingSetupFromConfig(
      {
        gateway: {
          bind: "custom",
          customBindHost: "127.0.0.1",
          auth: { token },
        },
        ...defaultEnvSecretProviderConfig,
      },
      {
        env: {
          OPENCLAW_GATEWAY_PASSWORD: "password-from-env", // pragma: allowlist secret
        },
      },
    );
  }

  async function expectInferredPasswordEnvSetupCase(token: SecretInput) {
    const resolved = await resolveInferredModeWithPasswordEnv(token);
    expectResolvedSetupOk(resolved, { authLabel: "password" });
  }

  it.each([
    {
      name: "uses password env in inferred mode without resolving token SecretRef",
      token: {
        source: "env",
        provider: "default",
        id: "MISSING_GW_TOKEN",
      } satisfies SecretInput,
    },
    {
      name: "does not treat env-template token as plaintext in inferred mode",
      token: "${MISSING_GW_TOKEN}",
    },
  ] as const)("$name", async ({ token }) => {
    await expectInferredPasswordEnvSetupCase(token);
  });

  it.each([
    {
      name: "requires explicit auth mode when token and password are both configured",
      auth: {
        token: { source: "env", provider: "default", id: "GW_TOKEN" },
        password: gatewayPasswordSecretRef,
      } as const,
      env: {
        GW_TOKEN: "resolved-token",
        GW_PASSWORD: "resolved-password", // pragma: allowlist secret
      },
    },
    {
      name: "errors when token and password SecretRefs are both configured with inferred mode",
      auth: {
        token: missingGatewayTokenSecretRef,
        password: gatewayPasswordSecretRef,
      } as const,
      env: {
        GW_PASSWORD: "resolved-password", // pragma: allowlist secret
      },
    },
  ] as const)("$name", async ({ auth, env }) => {
    await expectResolveCustomGatewayRejects({
      auth,
      env,
      config: defaultEnvSecretProviderConfig,
      expectedError: /gateway\.auth\.mode is unset/i,
    });
  });

  it.each([
    {
      name: "resolves custom bind + token auth",
      config: {
        gateway: {
          bind: "custom",
          customBindHost: "127.0.0.1",
          port: 19001,
          auth: { mode: "token", token: "tok_123" },
        },
      } satisfies ResolveSetupConfig,
      expected: {
        authLabel: "token",
        url: "ws://127.0.0.1:19001",
        urlSource: "gateway.bind=custom",
      },
    },
    {
      name: "honors env token override",
      config: {
        gateway: {
          bind: "custom",
          customBindHost: "127.0.0.1",
          auth: { mode: "token", token: "old" },
        },
      } satisfies ResolveSetupConfig,
      options: {
        env: {
          OPENCLAW_GATEWAY_TOKEN: "new-token",
        },
      } satisfies ResolveSetupOptions,
      expected: {
        authLabel: "token",
        url: "ws://127.0.0.1:18789",
        urlSource: "gateway.bind=custom",
      },
    },
    {
      name: "allows android emulator cleartext setup urls",
      config: {
        gateway: {
          bind: "custom",
          customBindHost: "10.0.2.2",
          auth: { mode: "token", token: "tok_123" },
        },
      } satisfies ResolveSetupConfig,
      expected: {
        authLabel: "token",
        url: "ws://10.0.2.2:18789",
        urlSource: "gateway.bind=custom",
      },
    },
    {
      name: "allows mdns cleartext setup urls",
      config: {
        gateway: {
          bind: "custom",
          customBindHost: "gateway.local",
          auth: { mode: "token", token: "tok_123" },
        },
      } satisfies ResolveSetupConfig,
      expected: {
        authLabel: "token",
        url: "ws://gateway.local:18789",
        urlSource: "gateway.bind=custom",
      },
    },
    {
      name: "allows lan ip cleartext setup urls",
      config: {
        gateway: {
          bind: "custom",
          customBindHost: "192.168.1.20",
          auth: { mode: "token", token: "tok_123" },
        },
      } satisfies ResolveSetupConfig,
      expected: {
        authLabel: "token",
        url: "ws://192.168.1.20:18789",
        urlSource: "gateway.bind=custom",
      },
    },
  ] as const)("$name", async ({ config, options, expected }) => {
    await expectResolvedSetupSuccessCase({
      config,
      options,
      expected,
    });
  });

  it.each([
    {
      name: "rejects custom bind public ws setup urls for mobile pairing",
      config: {
        gateway: {
          bind: "custom",
          customBindHost: "gateway.example",
          auth: { mode: "token", token: "tok_123" },
        },
      } satisfies ResolveSetupConfig,
      expectedError: "Tailscale and public mobile pairing require a secure gateway URL",
    },
    {
      name: "rejects tailnet bind remote ws setup urls for mobile pairing",
      config: {
        gateway: {
          bind: "tailnet",
          auth: { mode: "token", token: "tok_123" },
        },
      } satisfies ResolveSetupConfig,
      options: {
        networkInterfaces: () => createIpv4NetworkInterfaces("100.64.0.9"),
      } satisfies ResolveSetupOptions,
      expectedError: "prefer gateway.tailscale.mode=serve",
    },
  ] as const)("$name", async ({ config, options, expectedError }) => {
    await expectResolvedSetupFailureCase({
      config,
      options,
      expectedError,
    });
  });

  it("allows lan bind cleartext setup urls for mobile pairing", async () => {
    const runCommandWithTimeout = createNoRouteRunner();
    await expectResolvedSetupSuccessCase({
      config: {
        gateway: {
          bind: "lan",
          auth: { mode: "password", password: "secret" },
        },
      } satisfies ResolveSetupConfig,
      options: {
        networkInterfaces: () => createIpv4NetworkInterfaces("192.168.1.20"),
        runCommandWithTimeout,
      } satisfies ResolveSetupOptions,
      expected: {
        authLabel: "password",
        url: "ws://192.168.1.20:18789",
        urlSource: "gateway.bind=lan",
      },
      runCommandWithTimeout,
      expectedRunCommandCalls: 3,
    });
  });

  it("advertises the routed LAN interface instead of the first private interface", async () => {
    const runCommandWithTimeout = createDefaultRouteRunner("en1");
    await expectResolvedSetupSuccessCase({
      config: {
        gateway: {
          bind: "lan",
          auth: { mode: "password", password: "secret" },
        },
      } satisfies ResolveSetupConfig,
      options: {
        networkInterfaces: () =>
          ({
            bridge100: [
              {
                address: "10.37.129.4",
                family: "IPv4",
                internal: false,
                netmask: "255.255.255.0",
                mac: "00:00:00:00:00:00",
                cidr: "10.37.129.4/24",
              },
            ],
            en1: [
              {
                address: "10.211.55.3",
                family: "IPv4",
                internal: false,
                netmask: "255.255.255.0",
                mac: "00:00:00:00:00:00",
                cidr: "10.211.55.3/24",
              },
            ],
          }) as ReturnType<NonNullable<NonNullable<ResolveSetupOptions>["networkInterfaces"]>>,
        runCommandWithTimeout,
      } satisfies ResolveSetupOptions,
      expected: {
        authLabel: "password",
        url: "ws://10.211.55.3:18789",
        urlSource: "gateway.bind=lan",
      },
      runCommandWithTimeout,
      expectedRunCommandCalls: 3,
    });
  });

  it("adds a configured Tailscale Serve route to a LAN setup code", async () => {
    const defaultRoute = createDefaultRouteRunner("en0");
    const runCommandWithTimeout = vi.fn(async (argv: string[]) => {
      if (argv.includes("serve")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            TCP: { "8443": { HTTPS: true } },
            Web: {
              "clawmac.tail.ts.net:8443": {
                Handlers: { "/": { Proxy: "http://127.0.0.1:18789" } },
              },
            },
          }),
          stderr: "",
        };
      }
      return defaultRoute();
    });

    await expectResolvedSetupSuccessCase({
      config: {
        gateway: {
          bind: "lan",
          auth: { mode: "token", token: "tok_123" },
        },
      } satisfies ResolveSetupConfig,
      options: {
        networkInterfaces: () => createIpv4NetworkInterfaces("192.168.139.3"),
        runCommandWithTimeout,
      } satisfies ResolveSetupOptions,
      expected: {
        authLabel: "token",
        url: "ws://192.168.139.3:18789",
        urls: ["ws://192.168.139.3:18789", "wss://clawmac.tail.ts.net:8443"],
        urlSource: "gateway.bind=lan",
      },
      runCommandWithTimeout,
      expectedRunCommandCalls: 2,
    });
  });

  it("does not advertise a loopback Serve route for a custom bind", async () => {
    const runCommandWithTimeout = vi.fn(async () => {
      throw new Error("Tailscale Serve discovery must not run for a custom bind");
    });

    await expectResolvedSetupSuccessCase({
      config: {
        gateway: {
          bind: "custom",
          customBindHost: "192.168.139.3",
          auth: { mode: "token", token: "tok_123" },
        },
      } satisfies ResolveSetupConfig,
      options: { runCommandWithTimeout } satisfies ResolveSetupOptions,
      expected: {
        authLabel: "token",
        url: "ws://192.168.139.3:18789",
        urlSource: "gateway.bind=custom",
      },
      runCommandWithTimeout,
      expectedRunCommandCalls: 0,
    });
  });

  it("allows tailnet bind setup urls when gateway TLS is enabled", async () => {
    await expectResolvedSetupSuccessCase({
      config: {
        gateway: {
          bind: "tailnet",
          tls: {
            enabled: true,
          },
          auth: { mode: "token", token: "tok_123" },
        },
      } satisfies ResolveSetupConfig,
      options: {
        networkInterfaces: () => createIpv4NetworkInterfaces("100.64.0.9"),
      } satisfies ResolveSetupOptions,
      expected: {
        authLabel: "token",
        url: "wss://100.64.0.9:18789",
        urlSource: "gateway.bind=tailnet",
      },
    });
  });

  it.each([
    {
      name: "errors when gateway is loopback only",
      config: {
        gateway: {
          bind: "loopback",
          auth: { mode: "token", token: "tok" },
        },
      } satisfies ResolveSetupConfig,
      expectedError: "only bound to loopback",
    },
    {
      name: "returns a bind-specific error when interface discovery throws",
      config: {
        gateway: {
          bind: "lan",
          auth: { mode: "token", token: "tok" },
        },
      } satisfies ResolveSetupConfig,
      options: {
        networkInterfaces: () => {
          throw new Error("uv_interface_addresses failed");
        },
      } satisfies ResolveSetupOptions,
      expectedError: "gateway.bind=lan set, but no private LAN IP was found.",
    },
  ] as const)("$name", async ({ config, options, expectedError }) => {
    await expectResolvedSetupFailureCase({
      config,
      options,
      expectedError,
    });
  });

  it.each([
    {
      name: "uses tailscale serve DNS when available",
      createOptions: () => {
        const runCommandWithTimeout = createTailnetDnsRunner();
        return {
          options: {
            runCommandWithTimeout,
          } satisfies ResolveSetupOptions,
          runCommandWithTimeout,
          expectedRunCommandCalls: 1,
        };
      },
      config: {
        gateway: {
          tailscale: { mode: "serve" },
          auth: { mode: "password", password: "secret" },
        },
      } satisfies ResolveSetupConfig,
      expected: {
        authLabel: "password",
        url: "wss://mb-server.tailnet.ts.net",
        urlSource: "gateway.tailscale.mode=serve",
      },
    },
    {
      name: "uses configured Tailscale Service DNS when available",
      createOptions: () => {
        const runCommandWithTimeout = createTailnetDnsRunner();
        return {
          options: {
            runCommandWithTimeout,
          } satisfies ResolveSetupOptions,
          runCommandWithTimeout,
          expectedRunCommandCalls: 1,
        };
      },
      config: {
        gateway: {
          tailscale: { mode: "serve", serviceName: "svc:openclaw" },
          auth: { mode: "password", password: "secret" },
        },
      } satisfies ResolveSetupConfig,
      expected: {
        authLabel: "password",
        url: "wss://openclaw.tailnet.ts.net",
        urlSource: "gateway.tailscale.mode=serve",
      },
    },
    {
      name: "prefers gateway.remote.url over tailscale when requested",
      createOptions: () => {
        const runCommandWithTimeout = createTailnetDnsRunner();
        return {
          options: {
            preferRemoteUrl: true,
            runCommandWithTimeout,
          } satisfies ResolveSetupOptions,
          runCommandWithTimeout,
          expectedRunCommandCalls: 0,
        };
      },
      config: {
        gateway: {
          tailscale: { mode: "serve" },
          remote: { url: "wss://remote.example.com:444" },
          auth: { mode: "token", token: "tok_123" },
        },
      } satisfies ResolveSetupConfig,
      expected: {
        authLabel: "token",
        url: "wss://remote.example.com:444",
        urlSource: "gateway.remote.url",
      },
    },
  ] as const)("$name", async ({ config, createOptions, expected }) => {
    const { options, runCommandWithTimeout, expectedRunCommandCalls } = createOptions();
    await expectResolvedSetupSuccessCase({
      config,
      options,
      expected,
      runCommandWithTimeout,
      expectedRunCommandCalls,
    });
  });

  it("does not advertise a node-IP URL for named Tailscale Services", async () => {
    await expectResolvedSetupFailureCase({
      config: {
        gateway: {
          tailscale: { mode: "serve", serviceName: "svc:openclaw" },
          auth: { mode: "password", password: "secret" },
        },
      } satisfies ResolveSetupConfig,
      options: {
        runCommandWithTimeout: createTailnetIpRunner(),
      } satisfies ResolveSetupOptions,
      expectedError: "Service MagicDNS could not be derived",
    });
  });
});
