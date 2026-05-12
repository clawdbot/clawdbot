import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePairingSetupCode } from "../pairing/setup-code.js";
import { createCliRuntimeCapture, mockRuntimeModule } from "./test-runtime-capture.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [] as string[],
  })),
  renderTerminal: vi.fn(async () => "ASCII-QR"),
}));
const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();
const runtimeLog = runtime.log;
const runtimeError = runtime.error;
const runtimeExit = runtime.exit;

vi.doMock("../runtime.js", async () => {
  return mockRuntimeModule(
    () => vi.importActual<typeof import("../runtime.js")>("../runtime.js"),
    runtime,
  );
});
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.loadConfig,
  loadConfig: mocks.loadConfig,
}));
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: mocks.runCommandWithTimeout }));
vi.mock("../media/qr-terminal.ts", () => ({
  renderQrTerminal: mocks.renderTerminal,
}));
vi.mock("./command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));
vi.mock("../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: vi.fn(async () => ({
    token: "bootstrap-123",
    expiresAtMs: 123,
  })),
}));
const loadConfig = mocks.loadConfig;
const runCommandWithTimeout = mocks.runCommandWithTimeout;
const resolveCommandSecretRefsViaGateway = mocks.resolveCommandSecretRefsViaGateway;
const renderTerminal = mocks.renderTerminal;

const { registerQrCli } = await import("./qr-cli.js");

function createRemoteQrConfig(params?: { withTailscale?: boolean }) {
  return {
    gateway: {
      ...(params?.withTailscale ? { tailscale: { mode: "serve" } } : {}),
      remote: { url: "wss://remote.example.com:444", token: "remote-tok" },
      auth: { mode: "token", token: "local-tok" },
    },
    plugins: {
      entries: {
        "device-pair": {
          config: {
            publicUrl: "wss://wrong.example.com:443",
          },
        },
      },
    },
  };
}

function createTailscaleRemoteRefConfig() {
  return {
    gateway: {
      tailscale: { mode: "serve" },
      remote: {
        token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
      },
      auth: {},
    },
  };
}

function createDefaultSecretProvider() {
  return {
    providers: {
      default: { source: "env" as const },
    },
  };
}

function createLocalGatewayConfigWithAuth(auth: Record<string, unknown>) {
  return {
    secrets: createDefaultSecretProvider(),
    gateway: {
      bind: "custom",
      customBindHost: "127.0.0.1",
      auth,
    },
  };
}

function createLocalGatewayPasswordRefAuth(secretId: string) {
  return {
    mode: "password",
    password: { source: "env", provider: "default", id: secretId },
  };
}

function createLocalGatewayEnvPasswordRefAuth(secretId: string) {
  return {
    password: { source: "env", provider: "default", id: secretId },
  };
}

describe("registerQrCli", () => {
  function createProgram() {
    const program = new Command();
    registerQrCli(program);
    return program;
  }

  async function runQr(args: string[]) {
    const program = createProgram();
    await program.parseAsync(["qr", ...args], { from: "user" });
  }

  async function expectQrExit(args: string[]) {
    await expect(runQr(args)).rejects.toThrow("exit");
  }

  function readRuntimeCallText(call: unknown[] | undefined): string {
    const value = call?.[0];
    if (typeof value === "string") {
      return value;
    }
    return value === undefined ? "" : JSON.stringify(value);
  }

  function parseLastLoggedQrJson() {
    const raw = runtimeLog.mock.calls.at(-1)?.[0];
    return JSON.parse(typeof raw === "string" ? raw : "{}") as {
      setupCode?: string;
      gatewayUrl?: string;
      auth?: string;
      urlSource?: string;
    };
  }

  function expectLoggedSetupCode(url: string) {
    const expected = encodePairingSetupCode({
      url,
      bootstrapToken: "bootstrap-123",
    });
    expect(runtime.log).toHaveBeenCalledWith(expected);
  }

  function expectLoggedLocalSetupCode() {
    expectLoggedSetupCode("ws://127.0.0.1:18789");
  }

  function mockTailscaleStatusLookup() {
    runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: '{"Self":{"DNSName":"ts-host.tailnet.ts.net."}}',
      stderr: "",
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
    runtimeExit.mockImplementation(() => {
      throw new Error("exit");
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prints setup code only when requested", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "custom",
        customBindHost: "127.0.0.1",
        auth: { mode: "token", token: "tok" },
      },
    });

    await runQr(["--setup-code-only"]);

    const expected = encodePairingSetupCode({
      url: "ws://127.0.0.1:18789",
      bootstrapToken: "bootstrap-123",
    });
    expect(runtime.log).toHaveBeenCalledWith(expected);
    expect(renderTerminal).not.toHaveBeenCalled();
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("renders ASCII QR by default", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "custom",
        customBindHost: "127.0.0.1",
        auth: { mode: "token", token: "tok" },
      },
    });

    await runQr([]);

    expect(renderTerminal).toHaveBeenCalledTimes(1);
    const output = runtimeLog.mock.calls.map((call) => readRuntimeCallText(call)).join("\n");
    expect(output).toContain("Pairing QR");
    expect(output).toContain("ASCII-QR");
    expect(output).toContain("Gateway:");
    expect(output).toContain("openclaw devices approve <requestId>");
  });

  it("fails fast for insecure remote mobile pairing setup urls", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "custom",
        customBindHost: "gateway.example",
        auth: { mode: "token", token: "tok" },
      },
    });

    await expectQrExit(["--setup-code-only"]);

    const output = runtimeError.mock.calls.map((call) => readRuntimeCallText(call)).join("\n");
    expect(output).toContain("Tailscale and public mobile pairing require a secure gateway URL");
    expect(output).toContain("gateway.tailscale.mode=serve");
  });

  it("allows private LAN IP cleartext setup urls", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "custom",
        customBindHost: "192.168.1.8",
        auth: { mode: "token", token: "tok" },
      },
    });

    await runQr(["--setup-code-only"]);

    expectLoggedSetupCode("ws://192.168.1.8:18789");
  });

  it("allows android emulator cleartext override urls", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "loopback",
        auth: { mode: "token", token: "tok" },
      },
    });

    await runQr(["--setup-code-only", "--url", "ws://10.0.2.2:18789"]);

    expectLoggedSetupCode("ws://10.0.2.2:18789");
  });

  it("rejects invalid override urls before printing setup codes", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "custom",
        customBindHost: "127.0.0.1",
        auth: { mode: "token", token: "tok" },
      },
    });

    await expectQrExit(["--setup-code-only", "--url", "http://localhost:notaport"]);

    const output = runtimeError.mock.calls.map((call) => readRuntimeCallText(call)).join("\n");
    expect(output).toContain("Configured publicUrl is invalid.");
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("accepts --token override when config has no auth", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "custom",
        customBindHost: "127.0.0.1",
      },
    });

    await runQr(["--setup-code-only", "--token", "override-token"]);

    expectLoggedLocalSetupCode();
  });

  it("skips local password SecretRef resolution when --token override is provided", async () => {
    loadConfig.mockReturnValue(
      createLocalGatewayConfigWithAuth(
        createLocalGatewayPasswordRefAuth("MISSING_LOCAL_GATEWAY_PASSWORD"),
      ),
    );

    await runQr(["--setup-code-only", "--token", "override-token"]);

    expectLoggedLocalSetupCode();
  });

  it("resolves local gateway auth password SecretRefs before setup code generation", async () => {
    vi.stubEnv("QR_LOCAL_GATEWAY_PASSWORD", "local-password-secret");
    loadConfig.mockReturnValue(
      createLocalGatewayConfigWithAuth(
        createLocalGatewayPasswordRefAuth("QR_LOCAL_GATEWAY_PASSWORD"),
      ),
    );

    await runQr(["--setup-code-only"]);

    expectLoggedLocalSetupCode();
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("uses OPENCLAW_GATEWAY_PASSWORD without resolving local password SecretRef", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "password-from-env");
    loadConfig.mockReturnValue(
      createLocalGatewayConfigWithAuth(
        createLocalGatewayPasswordRefAuth("MISSING_LOCAL_GATEWAY_PASSWORD"),
      ),
    );

    await runQr(["--setup-code-only"]);

    expectLoggedLocalSetupCode();
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("does not resolve local password SecretRef when auth mode is token", async () => {
    loadConfig.mockReturnValue(
      createLocalGatewayConfigWithAuth({
        mode: "token",
        token: "token-123",
        ...createLocalGatewayEnvPasswordRefAuth("MISSING_LOCAL_GATEWAY_PASSWORD"),
      }),
    );

    await runQr(["--setup-code-only"]);

    expectLoggedLocalSetupCode();
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("resolves local password SecretRef when auth mode is inferred", async () => {
    vi.stubEnv("QR_INFERRED_GATEWAY_PASSWORD", "inferred-password");
    loadConfig.mockReturnValue(
      createLocalGatewayConfigWithAuth({
        ...createLocalGatewayEnvPasswordRefAuth("QR_INFERRED_GATEWAY_PASSWORD"),
      }),
    );

    await runQr(["--setup-code-only"]);

    expectLoggedLocalSetupCode();
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("fails when token and password SecretRefs are both configured with inferred mode", async () => {
    vi.stubEnv("QR_INFERRED_GATEWAY_TOKEN", "inferred-token");
    loadConfig.mockReturnValue({
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
      gateway: {
        bind: "custom",
        customBindHost: "gateway.local",
        auth: {
          token: { source: "env", provider: "default", id: "QR_INFERRED_GATEWAY_TOKEN" },
          password: { source: "env", provider: "default", id: "MISSING_LOCAL_GATEWAY_PASSWORD" },
        },
      },
    });

    await expectQrExit(["--setup-code-only"]);
    const output = runtimeError.mock.calls.map((call) => readRuntimeCallText(call)).join("\n");
    expect(output).toContain("gateway.auth.mode is unset");
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("exits with error when gateway config is not pairable", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "loopback",
        auth: { mode: "token", token: "tok" },
      },
    });

    await expectQrExit([]);

    const output = runtime.error.mock.calls.map((call) => readRuntimeCallText(call)).join("\n");
    expect(output).toContain("only bound to loopback");
  });

  it("uses gateway.remote.url when --remote is set (ignores device-pair publicUrl)", async () => {
    loadConfig.mockReturnValue(createRemoteQrConfig());
    await runQr(["--setup-code-only", "--remote"]);

    const expected = encodePairingSetupCode({
      url: "wss://remote.example.com:444",
      bootstrapToken: "bootstrap-123",
    });
    expect(runtime.log).toHaveBeenCalledWith(expected);
    const request = resolveCommandSecretRefsViaGateway.mock.calls.at(0)?.[0] as
      | { commandName?: string; targetIds?: Set<string> }
      | undefined;
    expect(request?.commandName).toBe("qr --remote");
    expect(request?.targetIds).toEqual(
      new Set(["gateway.remote.token", "gateway.remote.password"]),
    );
  });

  it("rejects invalid gateway.remote.url before printing remote setup codes", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "custom",
        customBindHost: "127.0.0.1",
        remote: { url: "http://localhost:notaport", token: "remote-tok" },
        auth: { mode: "token", token: "local-tok" },
      },
    });

    await expectQrExit(["--setup-code-only", "--remote"]);

    const output = runtimeError.mock.calls.map((call) => readRuntimeCallText(call)).join("\n");
    expect(output).toContain("Configured gateway.remote.url is invalid.");
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("logs remote secret diagnostics in non-json output mode", async () => {
    loadConfig.mockReturnValue(createRemoteQrConfig());
    resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
      resolvedConfig: createRemoteQrConfig(),
      diagnostics: ["gateway.remote.token inactive"] as string[],
    });

    await runQr(["--remote"]);

    expect(
      runtimeLog.mock.calls.some((call) =>
        readRuntimeCallText(call).includes("gateway.remote.token inactive"),
      ),
    ).toBe(true);
  });

  it("routes remote secret diagnostics to stderr for setup-code-only output", async () => {
    loadConfig.mockReturnValue(createRemoteQrConfig());
    resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
      resolvedConfig: createRemoteQrConfig(),
      diagnostics: ["gateway.remote.token inactive"] as string[],
    });

    await runQr(["--setup-code-only", "--remote"]);

    expect(
      runtimeError.mock.calls.some((call) =>
        readRuntimeCallText(call).includes("gateway.remote.token inactive"),
      ),
    ).toBe(true);
    const expected = encodePairingSetupCode({
      url: "wss://remote.example.com:444",
      bootstrapToken: "bootstrap-123",
    });
    expect(runtime.log).toHaveBeenCalledWith(expected);
  });

  it.each([
    { name: "without tailscale configured", withTailscale: false },
    { name: "when tailscale is configured", withTailscale: true },
  ])("reports gateway.remote.url as source in --remote json output ($name)", async (testCase) => {
    loadConfig.mockReturnValue(createRemoteQrConfig({ withTailscale: testCase.withTailscale }));
    mockTailscaleStatusLookup();

    await runQr(["--json", "--remote"]);

    const payload = parseLastLoggedQrJson();
    expect(payload.gatewayUrl).toBe("wss://remote.example.com:444");
    expect(payload.auth).toBe("token");
    expect(payload.urlSource).toBe("gateway.remote.url");
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("routes remote secret diagnostics to stderr for json output", async () => {
    loadConfig.mockReturnValue(createRemoteQrConfig());
    resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
      resolvedConfig: createRemoteQrConfig(),
      diagnostics: ["gateway.remote.password inactive"] as string[],
    });
    mockTailscaleStatusLookup();

    await runQr(["--json", "--remote"]);

    const payload = parseLastLoggedQrJson();
    expect(payload.gatewayUrl).toBe("wss://remote.example.com:444");
    expect(
      runtimeError.mock.calls.some((call) =>
        readRuntimeCallText(call).includes("gateway.remote.password inactive"),
      ),
    ).toBe(true);
  });

  it("errors when --remote is set but no remote URL is configured", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "custom",
        customBindHost: "gateway.local",
        auth: { mode: "token", token: "tok" },
      },
    });

    await expectQrExit(["--remote"]);
    const output = runtimeError.mock.calls.map((call) => readRuntimeCallText(call)).join("\n");
    expect(output).toContain("qr --remote requires");
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });

  it("supports --remote with tailscale serve when remote token ref resolves", async () => {
    loadConfig.mockReturnValue(createTailscaleRemoteRefConfig());
    resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
      resolvedConfig: {
        gateway: {
          tailscale: { mode: "serve" },
          remote: {
            token: "tailscale-remote-token",
          },
          auth: {},
        },
      },
      diagnostics: [],
    });
    runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: '{"Self":{"DNSName":"ts-host.tailnet.ts.net."}}',
      stderr: "",
    });

    await runQr(["--json", "--remote"]);

    const payload = parseLastLoggedQrJson();
    expect(payload.gatewayUrl).toBe("wss://ts-host.tailnet.ts.net");
    expect(payload.auth).toBe("token");
    expect(payload.urlSource).toBe("gateway.tailscale.mode=serve");
  });
});
