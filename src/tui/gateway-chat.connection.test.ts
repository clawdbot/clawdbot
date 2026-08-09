// Covers gateway-backed chat behavior used by the TUI backend.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadConfigMock as loadConfig,
  resolveConfigPathMock as resolveConfigPath,
  resolveGatewayPortMock as resolveGatewayPort,
  resolveStateDirMock as resolveStateDir,
} from "../gateway/gateway-connection.test-mocks.js";
import { withSecureTestNodeCommand } from "../secrets/test-node-command.test-support.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";

const readActiveGatewayLockPortMock = vi.hoisted(() => vi.fn());
const loadDeviceIdentityIfPresentMock = vi.hoisted(() => vi.fn());
const loadOriginDeviceTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", async () => {
  const mocks = await import("../gateway/gateway-connection.test-mocks.js");
  return {
    getRuntimeConfig: mocks.loadConfigMock,
    loadConfig: mocks.loadConfigMock,
    resolveConfigPath: mocks.resolveConfigPathMock,
    resolveGatewayPort: mocks.resolveGatewayPortMock,
    resolveStateDir: mocks.resolveStateDirMock,
  };
});

vi.mock("../gateway/net.js", async () => {
  const mocks = await import("../gateway/gateway-connection.test-mocks.js");
  return {
    isLoopbackHost: mocks.isLoopbackHostMock,
    isSecureWebSocketUrl: mocks.isSecureWebSocketUrlMock,
    pickPrimaryLanIPv4: mocks.pickPrimaryLanIPv4Mock,
  };
});

vi.mock("../infra/gateway-lock.js", () => ({
  readActiveGatewayLockPort: readActiveGatewayLockPortMock,
}));

vi.mock("../infra/device-auth-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-auth-store.js")>();
  return {
    ...actual,
    loadOriginDeviceToken: (...args: unknown[]) => loadOriginDeviceTokenMock(...args),
  };
});

vi.mock("../infra/device-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-identity.js")>();
  return {
    ...actual,
    loadDeviceIdentityIfPresent: (...args: unknown[]) => loadDeviceIdentityIfPresentMock(...args),
  };
});

const { GatewayChatClient } = await import("./gateway-chat.js");

const resolveBoundGatewayConnection = (
  opts: Parameters<typeof GatewayChatClient.connectBound>[0],
) => GatewayChatClient.connectBound(opts).connection;

const resolveGatewayConnection = async (opts: Parameters<typeof GatewayChatClient.connect>[0]) =>
  (await GatewayChatClient.connect(opts)).connection;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

type ModeExecProviderFixture = {
  tokenMarker: string;
  passwordMarker: string;
  providers: {
    tokenprovider: {
      source: "exec";
      command: string;
      args: string[];
    };
    passwordprovider: {
      source: "exec";
      command: string;
      args: string[];
    };
  };
};

async function withModeExecProviderFixture(
  label: string,
  run: (fixture: ModeExecProviderFixture) => Promise<void>,
) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-tui-mode-${label}-`));
  const tokenMarker = path.join(tempDir, "token-provider-ran");
  const passwordMarker = path.join(tempDir, "password-provider-ran");
  const tokenExecProgram = [
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(tokenMarker)},'1');`,
    "process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { TOKEN_SECRET: 'token-from-exec' } }));", // pragma: allowlist secret
  ].join("");
  const passwordExecProgram = [
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(passwordMarker)},'1');`,
    "process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { PASSWORD_SECRET: 'password-from-exec' } }));", // pragma: allowlist secret
  ].join("");

  try {
    await withSecureTestNodeCommand(async (command) =>
      run({
        tokenMarker,
        passwordMarker,
        providers: {
          tokenprovider: {
            source: "exec",
            command,
            args: ["-e", tokenExecProgram],
          },
          passwordprovider: {
            source: "exec",
            command,
            args: ["-e", passwordExecProgram],
          },
        },
      }),
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

describe("resolveGatewayConnection", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_GATEWAY_URL",
      "OPENCLAW_GATEWAY_PORT",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
      "OPENCLAW_TUI_SETUP_AUTH_SOURCE",
    ]);
    loadConfig.mockReset();
    loadDeviceIdentityIfPresentMock.mockReset().mockReturnValue(null);
    loadOriginDeviceTokenMock.mockReset().mockReturnValue(null);
    readActiveGatewayLockPortMock.mockReset().mockResolvedValue(undefined);
    resolveGatewayPort.mockReset();
    resolveStateDir.mockReset();
    resolveConfigPath.mockReset();
    resolveGatewayPort.mockReturnValue(18789);
    resolveStateDir.mockImplementation(
      (env: NodeJS.ProcessEnv) => env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw",
    );
    resolveConfigPath.mockImplementation(
      (env: NodeJS.ProcessEnv, stateDir: string) =>
        env.OPENCLAW_CONFIG_PATH ?? `${stateDir}/openclaw.json`,
    );
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_PORT;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.OPENCLAW_TUI_SETUP_AUTH_SOURCE;
  });

  afterEach(() => {
    envSnapshot.restore();
    vi.useRealTimers();
  });

  it("keeps a bound auth-free Gateway isolated from global config and env auth", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        remote: { url: "wss://global.example/ws", token: "global-token" },
      },
    });

    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_URL: "wss://env.example/ws",
        OPENCLAW_GATEWAY_TOKEN: "env-token",
      },
      async () => {
        const result = resolveBoundGatewayConnection({
          config: {
            gateway: {
              mode: "remote",
              remote: { url: "wss://selected.example/ws" },
            },
          },
          url: "wss://selected.example/ws",
          tlsFingerprint: "sha256:selected",
        });

        expect(result).toEqual({
          url: "wss://selected.example/ws",
          deviceAuthScope: "wss://selected.example/ws",
          token: undefined,
          password: undefined,
          tlsFingerprint: "sha256:selected",
        });
        expect(loadConfig).not.toHaveBeenCalled();
      },
    );
  });

  it("rejects an auth-free url override without reusing configured or env credentials", async () => {
    loadConfig.mockReturnValue({
      gateway: { mode: "local", auth: { token: "configured-token" } },
    });

    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "env-token" }, async () => {
      await expect(
        resolveGatewayConnection({ url: "wss://override.example/ws/?ignored=1" }),
      ).rejects.toThrow(/pass --token or --password once to request pairing/i);
    });
  });

  it("allows a url override with an exact-origin stored device credential", async () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local" } });
    loadDeviceIdentityIfPresentMock.mockReturnValue({ deviceId: "device-1" });
    loadOriginDeviceTokenMock.mockImplementation(({ gatewayScope }: { gatewayScope: string }) =>
      gatewayScope === "wss://override.example/ws"
        ? { token: "stored-origin-token", scopes: ["operator.read"] }
        : null,
    );

    await expect(
      resolveGatewayConnection({ url: "wss://override.example/ws/?ignored=1" }),
    ).resolves.toEqual({
      url: "wss://override.example/ws/?ignored=1",
      deviceAuthScope: "wss://override.example/ws",
      token: undefined,
      password: undefined,
    });
  });

  it.each([
    {
      label: "token",
      auth: { token: "explicit-token" },
      expected: { token: "explicit-token", password: undefined },
    },
    {
      label: "password",
      auth: { password: "explicit-password" },
      expected: { token: undefined, password: "explicit-password" },
    },
  ])("uses explicit $label when url override is set", async ({ auth, expected }) => {
    loadConfig.mockReturnValue({ gateway: { mode: "local" } });

    const result = await resolveGatewayConnection({
      url: "wss://override.example/ws",
      ...auth,
    });

    expect(result).toEqual({
      url: "wss://override.example/ws",
      deviceAuthScope: "wss://override.example/ws",
      ...expected,
      preauthHandshakeTimeoutMs: undefined,
    });
  });

  it("keeps the TLS pin on an explicit Gateway target", async () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local" } });

    const result = await resolveGatewayConnection({
      url: "wss://override.example/ws",
      token: "explicit-token",
      tlsFingerprint: "sha256:11:22:33:44",
    });

    expect(result.tlsFingerprint).toBe("sha256:11:22:33:44");
  });

  it.each([
    { label: "token auth", auth: { mode: "token", token: "config-token" } },
    { label: "auth none", auth: { mode: "none" } },
  ])("keeps the TLS pin on a configured local Gateway with $label", async ({ auth }) => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "local",
        tls: { enabled: true },
        auth,
      },
    });

    const result = await resolveGatewayConnection({
      tlsFingerprint: "sha256:local-self-signed-fingerprint",
    });

    expect(result.url).toBe("wss://127.0.0.1:18789");
    expect(result.tlsFingerprint).toBe("sha256:local-self-signed-fingerprint");
  });

  it("uses a verified active local Gateway port when no target is explicit", async () => {
    loadConfig.mockReturnValue({
      gateway: { mode: "local", port: 18789, auth: { token: "config-token" } },
    });
    readActiveGatewayLockPortMock.mockResolvedValue(48789);

    const result = await resolveGatewayConnection({});

    expect(result.url).toBe("ws://127.0.0.1:48789");
    expect(result.token).toBe("config-token");
  });

  it("keeps an explicit Gateway port ahead of active lock metadata", async () => {
    loadConfig.mockReturnValue({
      gateway: { mode: "local", port: 18789, auth: { token: "config-token" } },
    });
    readActiveGatewayLockPortMock.mockResolvedValue(48789);

    await withEnvAsync({ OPENCLAW_GATEWAY_PORT: "19001" }, async () => {
      const result = await resolveGatewayConnection({});

      expect(result.url).toBe("ws://127.0.0.1:19001");
      expect(readActiveGatewayLockPortMock).not.toHaveBeenCalled();
    });
  });
  it("uses config auth token for local mode when both config and env tokens are set", async () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", auth: { token: "config-token" } } });

    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "env-token" }, async () => {
      const result = await resolveGatewayConnection({});
      expect(result.token).toBe("config-token");
    });
  });

  it("falls back to OPENCLAW_GATEWAY_TOKEN when config token is missing", async () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local" } });

    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "env-token" }, async () => {
      const result = await resolveGatewayConnection({});
      expect(result.token).toBe("env-token");
    });
  });

  it("uses local password auth when gateway.auth.mode is unset and password-only is configured", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "local",
        auth: {
          password: "config-password", // pragma: allowlist secret
        },
      },
    });

    const result = await resolveGatewayConnection({});
    expect(result.password).toBe("config-password");
    expect(result.token).toBeUndefined();
  });

  it("keeps configured local password ahead of the ambient env password", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "local",
        auth: {
          mode: "password",
          password: "config-password", // pragma: allowlist secret
        },
      },
    });

    await withEnvAsync({ OPENCLAW_GATEWAY_PASSWORD: "env-password" }, async () => {
      const result = await resolveGatewayConnection({});
      expect(result.password).toBe("config-password");
    });
  });

  it("uses configured local password for setup-launched TUI despite stale gateway password env", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "local",
        auth: {
          mode: "password",
          password: "config-password", // pragma: allowlist secret
        },
      },
    });

    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_PASSWORD: "stale-env-password", // pragma: allowlist secret
        OPENCLAW_TUI_SETUP_AUTH_SOURCE: "config",
      },
      async () => {
        const result = await resolveGatewayConnection({});
        expect(result.password).toBe("config-password");
      },
    );
  });

  it("still resolves env SecretRefs for setup-launched TUI config auth", async () => {
    loadConfig.mockReturnValue({
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
      gateway: {
        mode: "local",
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
      },
    });

    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_PASSWORD: "resolved-ref-password", // pragma: allowlist secret
        OPENCLAW_TUI_SETUP_AUTH_SOURCE: "config",
      },
      async () => {
        const result = await resolveGatewayConnection({});
        expect(result.password).toBe("resolved-ref-password");
      },
    );
  });

  it("fails when both local token and password are configured but gateway.auth.mode is unset", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "local",
        auth: {
          token: "config-token",
          password: "config-password", // pragma: allowlist secret
        },
      },
    });

    await expect(resolveGatewayConnection({})).rejects.toThrow(
      "gateway.auth.mode is unset. Set gateway.auth.mode to token or password.",
    );
  });

  it("resolves env-template config auth token from referenced env var", async () => {
    loadConfig.mockReturnValue({
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
      gateway: {
        mode: "local",
        auth: { token: "${CUSTOM_GATEWAY_TOKEN}" },
      },
    });

    await withEnvAsync({ CUSTOM_GATEWAY_TOKEN: "custom-token" }, async () => {
      const result = await resolveGatewayConnection({});
      expect(result.token).toBe("custom-token");
    });
  });

  it("fails with guidance when env-template config auth token is unresolved", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "local",
        auth: { token: "${MISSING_GATEWAY_TOKEN}" },
      },
    });

    await expect(resolveGatewayConnection({})).rejects.toThrow(
      "gateway.auth.token SecretRef is unresolved",
    );
  });

  it("prefers OPENCLAW_GATEWAY_PASSWORD over remote password fallback", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        remote: { url: "wss://remote.example/ws", token: "remote-token", password: "remote-pass" }, // pragma: allowlist secret
      },
    });

    const gatewayPasswordEnv = "OPENCLAW_GATEWAY_PASSWORD"; // pragma: allowlist secret
    const gatewayPassword = "env-pass"; // pragma: allowlist secret
    await withEnvAsync({ [gatewayPasswordEnv]: gatewayPassword }, async () => {
      const result = await resolveGatewayConnection({});
      expect(result.password).toBe(gatewayPassword);
    });
  });

  it("allows a configured remote gateway to use its origin-scoped device credential", async () => {
    loadConfig.mockReturnValue({
      gateway: { mode: "remote", remote: { url: "wss://remote.example/rpc/?ignored=1" } },
    });
    loadDeviceIdentityIfPresentMock.mockReturnValue({ deviceId: "device-1" });
    loadOriginDeviceTokenMock.mockReturnValue({
      token: "stored-origin-token",
      scopes: ["operator.read"],
    });

    await expect(resolveGatewayConnection({})).resolves.toMatchObject({
      url: "wss://remote.example/rpc/?ignored=1",
      deviceAuthScope: "wss://remote.example/rpc",
      token: undefined,
      password: undefined,
    });
  });

  it("keeps configured remote auth required when no origin device token exists", async () => {
    loadConfig.mockReturnValue({
      gateway: { mode: "remote", remote: { url: "wss://remote.example/rpc" } },
    });

    await expect(resolveGatewayConnection({})).rejects.toThrow("Missing gateway auth credentials.");
  });

  it("uses configured remote password for setup-launched TUI despite stale gateway env", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://remote.example/ws",
          password: "configured-remote-password", // pragma: allowlist secret
        },
      },
    });

    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_PASSWORD: "stale-env-password", // pragma: allowlist secret
        OPENCLAW_TUI_SETUP_AUTH_SOURCE: "config",
      },
      async () => {
        const result = await resolveGatewayConnection({});
        expect(result.token).toBeUndefined();
        expect(result.password).toBe("configured-remote-password");
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "resolves file-backed SecretRef token for local mode",
    async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tui-file-secret-"));
      const secretFile = path.join(tempDir, "secrets.json");
      await fs.writeFile(secretFile, JSON.stringify({ gatewayToken: "file-secret-token" }), "utf8");
      await fs.chmod(secretFile, 0o600);

      loadConfig.mockReturnValue({
        secrets: {
          providers: {
            fileprovider: {
              source: "file",
              path: secretFile,
              mode: "json",
              allowInsecurePath: true,
            },
          },
        },
        gateway: {
          mode: "local",
          auth: {
            token: { source: "file", provider: "fileprovider", id: "/gatewayToken" },
          },
        },
      });

      try {
        const result = await resolveGatewayConnection({});
        expect(result.token).toBe("file-secret-token");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("resolves exec-backed SecretRef token for local mode", async () => {
    const execProgram = [
      "process.stdout.write(",
      "JSON.stringify({ protocolVersion: 1, values: { EXEC_GATEWAY_TOKEN: 'exec-secret-token' } })",
      ");",
    ].join("");

    await withSecureTestNodeCommand(async (command) => {
      loadConfig.mockReturnValue({
        secrets: {
          providers: {
            execprovider: {
              source: "exec",
              command,
              args: ["-e", execProgram],
            },
          },
        },
        gateway: {
          mode: "local",
          auth: {
            token: { source: "exec", provider: "execprovider", id: "EXEC_GATEWAY_TOKEN" },
          },
        },
      });

      const result = await resolveGatewayConnection({});
      expect(result.token).toBe("exec-secret-token");
    });
  });

  it("resolves only token SecretRef when gateway.auth.mode is token", async () => {
    await withModeExecProviderFixture(
      "token",
      async ({ tokenMarker, passwordMarker, providers }) => {
        loadConfig.mockReturnValue({
          secrets: {
            providers,
          },
          gateway: {
            mode: "local",
            auth: {
              mode: "token",
              token: { source: "exec", provider: "tokenprovider", id: "TOKEN_SECRET" },
              password: { source: "exec", provider: "passwordprovider", id: "PASSWORD_SECRET" },
            },
          },
        });

        const result = await resolveGatewayConnection({});
        expect(result.token).toBe("token-from-exec");
        expect(result.password).toBeUndefined();
        expect(await fileExists(tokenMarker)).toBe(true);
        expect(await fileExists(passwordMarker)).toBe(false);
      },
    );
  });

  it("resolves only password SecretRef when gateway.auth.mode is password", async () => {
    await withModeExecProviderFixture(
      "password",
      async ({ tokenMarker, passwordMarker, providers }) => {
        loadConfig.mockReturnValue({
          secrets: {
            providers,
          },
          gateway: {
            mode: "local",
            auth: {
              mode: "password",
              token: { source: "exec", provider: "tokenprovider", id: "TOKEN_SECRET" },
              password: { source: "exec", provider: "passwordprovider", id: "PASSWORD_SECRET" },
            },
          },
        });

        const result = await resolveGatewayConnection({});
        expect(result.password).toBe("password-from-exec");
        expect(result.token).toBeUndefined();
        expect(await fileExists(tokenMarker)).toBe(false);
        expect(await fileExists(passwordMarker)).toBe(true);
      },
    );
  });
});
