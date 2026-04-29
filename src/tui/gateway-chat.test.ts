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
import { captureEnv, withEnvAsync } from "../test-utils/env.js";

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

const { GatewayChatClient, resolveGatewayConnection } = await import("./gateway-chat.js");
const { GatewayClientRequestError } = await import("../gateway/client.js");

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
    tokenProvider: {
      source: "exec";
      command: string;
      args: string[];
      allowInsecurePath: true;
    };
    passwordProvider: {
      source: "exec";
      command: string;
      args: string[];
      allowInsecurePath: true;
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
    await run({
      tokenMarker,
      passwordMarker,
      providers: {
        tokenProvider: {
          source: "exec",
          command: process.execPath,
          args: ["-e", tokenExecProgram],
          allowInsecurePath: true,
        },
        passwordProvider: {
          source: "exec",
          command: process.execPath,
          args: ["-e", passwordExecProgram],
          allowInsecurePath: true,
        },
      },
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

describe("resolveGatewayConnection", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_GATEWAY_URL",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
      "OPENCLAW_TUI_SETUP_AUTH_SOURCE",
    ]);
    loadConfig.mockReset();
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
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.OPENCLAW_TUI_SETUP_AUTH_SOURCE;
  });

  afterEach(() => {
    envSnapshot.restore();
    vi.useRealTimers();
  });

  it("throws when url override is missing explicit credentials", async () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local" } });

    await expect(resolveGatewayConnection({ url: "wss://override.example/ws" })).rejects.toThrow(
      "explicit credentials",
    );
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
      ...expected,
      preauthHandshakeTimeoutMs: undefined,
      allowInsecureLocalOperatorUi: false,
    });
  });

  it("carries configured handshake timeout to the TUI client connection", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "local",
        handshakeTimeoutMs: 30_000,
        auth: { token: "config-token" },
      },
    });

    const result = await resolveGatewayConnection({});

    expect(result.preauthHandshakeTimeoutMs).toBe(30_000);
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

  it("keeps normal TUI local password mode env precedence by default", async () => {
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
      expect(result.password).toBe("env-password");
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
            fileProvider: {
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
            token: { source: "file", provider: "fileProvider", id: "/gatewayToken" },
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

    loadConfig.mockReturnValue({
      secrets: {
        providers: {
          execProvider: {
            source: "exec",
            command: process.execPath,
            args: ["-e", execProgram],
            allowInsecurePath: true,
          },
        },
      },
      gateway: {
        mode: "local",
        auth: {
          token: { source: "exec", provider: "execProvider", id: "EXEC_GATEWAY_TOKEN" },
        },
      },
    });

    const result = await resolveGatewayConnection({});
    expect(result.token).toBe("exec-secret-token");
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
              token: { source: "exec", provider: "tokenProvider", id: "TOKEN_SECRET" },
              password: { source: "exec", provider: "passwordProvider", id: "PASSWORD_SECRET" },
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
              token: { source: "exec", provider: "tokenProvider", id: "TOKEN_SECRET" },
              password: { source: "exec", provider: "passwordProvider", id: "PASSWORD_SECRET" },
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

  it("marks loopback local connections for insecure operator ui auth when enabled", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "local",
        controlUi: {
          allowInsecureAuth: true,
        },
        auth: {
          mode: "token",
          token: "config-token",
        },
      },
    });

    const result = await resolveGatewayConnection({});
    expect(result.allowInsecureLocalOperatorUi).toBe(true);
  });

  it("preserves insecure local operator ui auth when a loopback url override is provided", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "local",
        controlUi: {
          allowInsecureAuth: true,
        },
        auth: {
          mode: "token",
          token: "config-token",
        },
      },
    });

    const result = await resolveGatewayConnection({
      url: "ws://127.0.0.1:18791",
      token: "override-token",
    });
    expect(result.allowInsecureLocalOperatorUi).toBe(true);
    expect(result.token).toBe("override-token");
  });
});

describe("GatewayChatClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("identifies the TUI as a tui client and skips device identity on insecure local ui paths", () => {
    const client = new GatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
      preauthHandshakeTimeoutMs: 30_000,
      allowInsecureLocalOperatorUi: true,
    });

    expect(
      (client as unknown as { client: { opts: { clientName?: string; mode?: string } } }).client
        .opts.clientName,
    ).toBe("openclaw-tui");
    expect(
      (client as unknown as { client: { opts: { clientName?: string; mode?: string } } }).client
        .opts.mode,
    ).toBe("ui");
    expect(
      (client as unknown as { client: { opts: { deviceIdentity?: unknown } } }).client.opts
        .deviceIdentity,
    ).toBeUndefined();
    expect(
      (client as unknown as { client: { opts: { preauthHandshakeTimeoutMs?: number } } }).client
        .opts.preauthHandshakeTimeoutMs,
    ).toBe(30_000);
  });

  it("retries startup-unavailable chat history until the gateway finishes booting", async () => {
    vi.useFakeTimers();

    const client = new GatewayChatClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
      allowInsecureLocalOperatorUi: true,
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "UNAVAILABLE",
          message: "chat.history unavailable during gateway startup",
          details: { method: "chat.history" },
          retryable: true,
          retryAfterMs: 250,
        }),
      )
      .mockResolvedValueOnce({ messages: [] });

    (client as unknown as { client: { request: typeof request } }).client.request = request;

    const historyPromise = client.loadHistory({ sessionKey: "main", limit: 200 });
    await vi.advanceTimersByTimeAsync(250);

    await expect(historyPromise).resolves.toEqual({ messages: [] });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
