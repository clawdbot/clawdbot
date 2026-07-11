// Onboard helper tests cover workspace setup, control UI links, and gateway reachability probes.
import * as fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  formatControlUiSshHint,
  handleReset,
  moveToTrash,
  normalizeGatewayTokenInput,
  openUrl,
  probeGatewayConfiguredModel,
  probeGatewayReachable,
  resolveBrowserOpenCommand,
  resolveAdvertisedControlUiLinks,
  resolveControlUiLinks,
  resolveLocalControlUiProbeLinks,
  summarizeExistingConfig,
  testing,
  validateGatewayPasswordInput,
  waitForGatewayReachable,
} from "./onboard-helpers.js";

describe("onboard error summaries", () => {
  it("keeps the bounded first line UTF-16 well-formed", () => {
    expect(testing.summarizeError(`${"x".repeat(118)}🚀tail\nignored`)).toBe(`${"x".repeat(118)}…`);
  });
});

const mocks = vi.hoisted(() => ({
  movePathToTrash: vi.fn(async (targetPath: string) => `${targetPath}.trashed`),
  runCommandWithTimeout: vi.fn<
    (
      argv: string[],
      options?: { timeoutMs?: number; windowsVerbatimArguments?: boolean },
    ) => Promise<{ stdout: string; stderr: string; code: number; signal: null; killed: boolean }>
  >(async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
  })),
  pickPrimaryTailnetIPv4: vi.fn<() => string | undefined>(() => undefined),
  resolveAdvertisedLanHost: vi.fn<() => Promise<string | null>>(async () => null),
  probeGateway: vi.fn(),
}));

vi.mock("../infra/fs-safe.js", () => ({
  movePathToTrash: mocks.movePathToTrash,
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: mocks.pickPrimaryTailnetIPv4,
}));

vi.mock("../infra/advertised-lan-host.js", () => ({
  resolveAdvertisedLanHost: mocks.resolveAdvertisedLanHost,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type RunCommandCall = [
  argv: string[],
  options?: { timeoutMs?: number; windowsVerbatimArguments?: boolean },
];

function requireFirstRunCommandCall(): RunCommandCall {
  const [call] = mocks.runCommandWithTimeout.mock.calls;
  if (!call) {
    throw new Error("expected browser open command call");
  }
  return call as RunCommandCall;
}

function expectedTrashSourcePath(targetPath: string): string {
  return path.join(fs.realpathSync(path.dirname(targetPath)), path.basename(targetPath));
}

describe("handleReset", () => {
  it("uses active profile paths for destructive reset targets", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-profile-"));
    const profileStateDir = path.join(homeDir, ".openclaw-work");
    const defaultStateDir = path.join(homeDir, ".openclaw");
    const profileConfigPath = path.join(profileStateDir, "openclaw.json");
    const profileCredentialsDir = path.join(profileStateDir, "credentials");
    const profileSessionsDir = path.join(profileStateDir, "agents", "main", "sessions");
    const workspaceDir = path.join(profileStateDir, "workspace");
    const workspaceAttestationPath = `${workspaceDir}.attested`;
    const defaultCredentialsDir = path.join(defaultStateDir, "credentials");

    fs.mkdirSync(profileCredentialsDir, { recursive: true });
    fs.mkdirSync(profileSessionsDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(defaultCredentialsDir, { recursive: true });
    fs.writeFileSync(profileConfigPath, "{}\n");
    fs.writeFileSync(
      workspaceAttestationPath,
      `openclaw-workspace-attestation:v1\n${new Date().toISOString()}\n`,
    );

    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;
    const expectedTrashedPaths = [
      profileConfigPath,
      profileCredentialsDir,
      profileSessionsDir,
      workspaceDir,
      workspaceAttestationPath,
    ].map(expectedTrashSourcePath);
    const expectedDefaultCredentialsDir = expectedTrashSourcePath(defaultCredentialsDir);

    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: profileStateDir,
          OPENCLAW_CONFIG_PATH: profileConfigPath,
        },
        async () => await handleReset("full", workspaceDir, runtime),
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }

    const trashedPaths = mocks.movePathToTrash.mock.calls.map(([targetPath]) => targetPath);
    expect(trashedPaths).toEqual(expectedTrashedPaths);
    expect(trashedPaths).not.toContain(expectedDefaultCredentialsDir);
  });

  it("does not trash an unowned sibling attestation path during full reset", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-profile-"));
    const profileStateDir = path.join(homeDir, ".openclaw-work");
    const profileConfigPath = path.join(profileStateDir, "openclaw.json");
    const profileCredentialsDir = path.join(profileStateDir, "credentials");
    const profileSessionsDir = path.join(profileStateDir, "agents", "main", "sessions");
    const workspaceDir = path.join(profileStateDir, "workspace");
    const workspaceAttestationPath = `${workspaceDir}.attested`;

    fs.mkdirSync(profileCredentialsDir, { recursive: true });
    fs.mkdirSync(profileSessionsDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(profileConfigPath, "{}\n");
    fs.writeFileSync(workspaceAttestationPath, "external data\n");

    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;
    const unownedAttestationTrashPath = expectedTrashSourcePath(workspaceAttestationPath);

    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: profileStateDir,
          OPENCLAW_CONFIG_PATH: profileConfigPath,
        },
        async () => await handleReset("full", workspaceDir, runtime),
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }

    const trashedPaths = mocks.movePathToTrash.mock.calls.map(([targetPath]) => targetPath);
    expect(trashedPaths).not.toContain(unownedAttestationTrashPath);
  });

  it.skipIf(process.platform === "win32")(
    "does not abort full reset for an unreadable legacy attestation path",
    async () => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-profile-"));
      const profileStateDir = path.join(homeDir, ".openclaw-work");
      const profileConfigPath = path.join(profileStateDir, "openclaw.json");
      const profileCredentialsDir = path.join(profileStateDir, "credentials");
      const profileSessionsDir = path.join(profileStateDir, "agents", "main", "sessions");
      const workspaceDir = path.join(profileStateDir, "workspace");
      const workspaceAttestationPath = `${workspaceDir}.attested`;

      fs.mkdirSync(profileCredentialsDir, { recursive: true });
      fs.mkdirSync(profileSessionsDir, { recursive: true });
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.writeFileSync(profileConfigPath, "{}\n");
      fs.writeFileSync(workspaceAttestationPath, "external data\n", { mode: 0o000 });
      fs.chmodSync(workspaceAttestationPath, 0o000);

      const runtime = { log: vi.fn() } as unknown as RuntimeEnv;
      const unreadableAttestationTrashPath = expectedTrashSourcePath(workspaceAttestationPath);

      try {
        await withEnvAsync(
          {
            HOME: homeDir,
            OPENCLAW_HOME: homeDir,
            OPENCLAW_PROFILE: "work",
            OPENCLAW_STATE_DIR: profileStateDir,
            OPENCLAW_CONFIG_PATH: profileConfigPath,
          },
          async () => {
            await expect(handleReset("full", workspaceDir, runtime)).resolves.toBeUndefined();
          },
        );
      } finally {
        fs.chmodSync(workspaceAttestationPath, 0o600);
        fs.rmSync(homeDir, { recursive: true, force: true });
      }

      const trashedPaths = mocks.movePathToTrash.mock.calls.map(([targetPath]) => targetPath);
      expect(trashedPaths).not.toContain(unreadableAttestationTrashPath);
    },
  );
});

describe("moveToTrash", () => {
  it("uses fs-safe trash instead of resolving a PATH trash command", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trash-helper-"));
    const targetPath = path.join(testRoot, "target");
    fs.mkdirSync(targetPath, { recursive: true });
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;
    const sourcePath = expectedTrashSourcePath(targetPath);

    try {
      await moveToTrash(targetPath, runtime);
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }

    expect(mocks.movePathToTrash).toHaveBeenCalledWith(sourcePath, {
      allowedRoots: [path.dirname(sourcePath)],
    });
    expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(`Moved to Trash: ${targetPath}`);
  });

  it("allows fs-safe trash to move a symlink whose target resolves outside the parent", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trash-symlink-"));
    const targetPath = path.join(testRoot, "target-link");
    const outsideTarget = path.join(os.tmpdir(), "openclaw-trash-symlink-target");
    fs.writeFileSync(targetPath, "link placeholder");
    vi.spyOn(fsPromises, "lstat").mockResolvedValue({
      isSymbolicLink: () => true,
    } as fs.Stats);
    vi.spyOn(fsPromises, "realpath").mockImplementation(async (candidate) =>
      String(candidate) === path.dirname(targetPath) ? path.dirname(targetPath) : outsideTarget,
    );
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;

    try {
      await moveToTrash(targetPath, runtime);
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }

    expect(mocks.movePathToTrash).toHaveBeenCalledWith(targetPath, {
      allowedRoots: [path.dirname(targetPath), path.dirname(outsideTarget)],
    });
  });

  it("canonicalizes a symlinked parent before calling fs-safe trash", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trash-parent-link-"));
    const lexicalParent = path.join(testRoot, "state-link");
    const realParent = path.join(testRoot, "state-real");
    const targetPath = path.join(lexicalParent, "openclaw.json");
    const sourcePath = path.join(realParent, "openclaw.json");
    fs.mkdirSync(lexicalParent, { recursive: true });
    fs.writeFileSync(targetPath, "{}\n");
    vi.spyOn(fsPromises, "realpath").mockImplementation(async (candidate) =>
      String(candidate) === lexicalParent ? realParent : String(candidate),
    );
    vi.spyOn(fsPromises, "lstat").mockResolvedValue({
      isSymbolicLink: () => false,
    } as fs.Stats);
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;

    try {
      await moveToTrash(targetPath, runtime);
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }

    expect(mocks.movePathToTrash).toHaveBeenCalledWith(sourcePath, {
      allowedRoots: [realParent],
    });
  });
});

describe("openUrl", () => {
  it("passes OAuth URLs to Windows FileProtocolHandler without cmd parsing", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.stubEnv("NODE_ENV", "development");
    const rundll32 = path.win32.join("C:\\Windows", "System32", "rundll32.exe");

    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&response_type=code&redirect_uri=http%3A%2F%2Flocalhost";

    await withMockedPlatform("win32", async () => {
      const ok = await openUrl(url);
      expect(ok).toBe(true);

      expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(1);
      const [argv, options] = requireFirstRunCommandCall();
      expect(argv).toEqual([rundll32, "url.dll,FileProtocolHandler", url]);
      expect(options?.timeoutMs).toBe(5_000);
      expect(options?.windowsVerbatimArguments).toBeUndefined();
    });
  });

  it("does not pass non-http URLs to the OS browser handler", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");

    await withMockedPlatform("win32", async () => {
      const ok = await openUrl("file://C:/Users/test/secrets.txt");

      expect(ok).toBe(false);
      expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
    });
  });
});

describe("resolveBrowserOpenCommand", () => {
  it("uses trusted rundll32 on win32", async () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const rundll32 = path.win32.join("C:\\Windows", "System32", "rundll32.exe");

    await withMockedPlatform("win32", async () => {
      const resolved = await resolveBrowserOpenCommand();
      expect(resolved.argv).toEqual([rundll32, "url.dll,FileProtocolHandler"]);
      expect(resolved.command).toBe(rundll32);
    });
  });
});

describe("formatControlUiSshHint", () => {
  it("includes the IPv4-only BYOH note and workaround", () => {
    const hint = formatControlUiSshHint({ port: 18789 });
    expect(hint).toContain("BYOH note: lan, tailnet, and custom bind are currently IPv4-only.");
    expect(hint).toContain(
      "If your host is IPv6-only, use an IPv4 sidecar or proxy in front of the Gateway.",
    );
  });
});

describe("probeGatewayReachable", () => {
  it("uses a hello-only probe for onboarding reachability", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 42,
      error: null,
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    const result = await probeGatewayReachable({
      url: "ws://127.0.0.1:18789",
      token: "tok_test",
      timeoutMs: 2500,
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.probeGateway).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 2500,
      auth: {
        token: "tok_test",
        password: undefined,
      },
      detailLevel: "none",
    });
  });

  it("returns the probe error detail on failure", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "connect failed: timeout",
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    const result = await probeGatewayReachable({
      url: "ws://127.0.0.1:18789",
    });

    expect(result).toEqual({
      ok: false,
      detail: "connect failed: timeout",
    });
  });

  it("forwards a configured TLS fingerprint to the gateway probe", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      configSnapshot: null,
    });

    await expect(
      probeGatewayReachable({
        url: "wss://gateway.example.com:18789",
        tlsFingerprint: "sha256:11:22:33:44",
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.probeGateway).toHaveBeenCalledWith({
      url: "wss://gateway.example.com:18789",
      timeoutMs: 1500,
      auth: {
        token: undefined,
        password: undefined,
      },
      tlsFingerprint: "sha256:11:22:33:44",
      detailLevel: "none",
    });
  });

  it("lets a configured preauth handshake timeout widen the default probe budget", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      configSnapshot: null,
    });

    await expect(
      probeGatewayReachable({
        url: "wss://gateway.example.com:18789",
        preauthHandshakeTimeoutMs: 30_000,
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.probeGateway).toHaveBeenCalledWith({
      url: "wss://gateway.example.com:18789",
      timeoutMs: 30_000,
      auth: {
        token: undefined,
        password: undefined,
      },
      preauthHandshakeTimeoutMs: 30_000,
      detailLevel: "none",
    });
  });

  it("classifies configured and missing default-agent models from config-only probes", async () => {
    mocks.probeGateway
      .mockResolvedValueOnce({
        ok: true,
        server: { version: "2026.7.2", connId: "conn-configured" },
        configSnapshot: {
          valid: true,
          config: { agents: { list: [{ id: "work", default: true, model: "openai/gpt-5.5" }] } },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        server: { version: "2026.7.2", connId: "conn-missing" },
        configSnapshot: { valid: true, config: { gateway: { mode: "local" } } },
      });

    await expect(
      probeGatewayConfiguredModel({
        url: "ws://127.0.0.1:18789",
      }),
    ).resolves.toEqual({ kind: "configured" });
    await expect(
      probeGatewayConfiguredModel({
        url: "ws://127.0.0.1:18789",
      }),
    ).resolves.toEqual({
      kind: "missing-configured-model",
      detail: "Gateway default agent has no configured model",
    });
    expect(mocks.probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({ detailLevel: "config" }),
    );
  });

  it("keeps post-Hello config read failures on the reachable Gateway path", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: 42,
      error: "config.get: unauthorized",
      auth: { role: null, scopes: [], capability: "unknown" },
      server: { version: "2026.7.2", connId: "conn-1" },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "reachable-unverified",
      detail: "config.get: unauthorized",
    });
  });

  it("keeps typed pre-Hello Gateway auth failures on the reachable path", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: 42,
      error: "device pairing required",
      connectErrorDetails: { code: ConnectErrorDetailCodes.PAIRING_REQUIRED },
      auth: { role: null, scopes: [], capability: "pairing_pending" },
      server: { version: null, connId: null },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "reachable-unverified",
      detail: "device pairing required",
    });
  });

  it("does not mistake an arbitrary open WebSocket for a Gateway", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: 42,
      error: "websocket closed",
      auth: { role: null, scopes: [], capability: "unknown" },
      server: { version: null, connId: null },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "unreachable",
      detail: "websocket closed",
    });
  });

  it("does not trust an unrecognized connect error code as Gateway evidence", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: 42,
      error: "foreign protocol error",
      connectErrorDetails: { code: "NOT_AN_OPENCLAW_CONNECT_ERROR" },
      auth: { role: null, scopes: [], capability: "unknown" },
      server: { version: null, connId: null },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "unreachable",
      detail: "foreign protocol error",
    });
  });

  it("does not trust a config-shaped response without Gateway handshake evidence", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      connectLatencyMs: 42,
      error: null,
      auth: { role: null, scopes: [], capability: "unknown" },
      server: { version: "foreign-server", connId: null },
      configSnapshot: {
        valid: true,
        config: { agents: { defaults: { model: "openai/foreign-model" } } },
      },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "unreachable",
    });
  });

  it("keeps a first-time connect-only auth result on the reachable Gateway path", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: 42,
      error: "missing scope: operator.read",
      auth: { role: "operator", scopes: [], capability: "connected_no_operator_scope" },
      server: { version: "2026.7.2", connId: "conn-1" },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "reachable-unverified",
      detail: "missing scope: operator.read",
    });
  });

  it("treats an invalid config snapshot as reachable but unverified", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      connectLatencyMs: 42,
      auth: { role: "operator", scopes: ["operator.read"], capability: "read_only" },
      server: { version: "2026.7.2", connId: "conn-1" },
      configSnapshot: { valid: false },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "reachable-unverified",
      detail: "Gateway returned an invalid config snapshot",
    });
  });

  it("distinguishes pre-Hello connection failures from reachable Gateway failures", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: null,
      error: "connect failed: timeout",
      auth: { role: null, scopes: [], capability: "unknown" },
      server: { version: null, connId: null },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "unreachable",
      detail: "connect failed: timeout",
    });
  });
});

describe("waitForGatewayReachable", () => {
  it("keeps oversized poll intervals within the overall deadline", async () => {
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "connect failed: timeout",
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    const result = await waitForGatewayReachable({
      url: "ws://127.0.0.1:18789",
      deadlineMs: 5,
      pollMs: Number.MAX_SAFE_INTEGER,
      probeTimeoutMs: 1,
    });

    expect(result).toEqual({ ok: false, detail: "connect failed: timeout" });
  });
});

describe("summarizeExistingConfig", () => {
  it("collapses gateway fields into a friendly remote summary", () => {
    expect(
      summarizeExistingConfig({
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
        gateway: {
          mode: "remote",
          port: 18789,
          bind: "lan",
          remote: { url: "ws://192.168.0.202:18789" },
        },
      }),
    ).toBe("Model: openai/gpt-5.4\nGateway: remote via LAN at ws://192.168.0.202:18789");
  });

  it("uses the port when no remote gateway URL is configured", () => {
    expect(
      summarizeExistingConfig({
        gateway: {
          mode: "local",
          port: 18789,
          bind: "loopback",
        },
      }),
    ).toBe("Gateway: local via loopback on :18789");
  });

  it("does not show a stale remote URL as active for local gateway mode", () => {
    expect(
      summarizeExistingConfig({
        gateway: {
          mode: "local",
          port: 18789,
          bind: "loopback",
          remote: { url: "ws://192.168.0.202:18789" },
        },
      }),
    ).toBe("Gateway: local via loopback on :18789");
  });

  it("surfaces missing remote URL instead of falling back to port for remote mode", () => {
    expect(
      summarizeExistingConfig({
        gateway: {
          mode: "remote",
          port: 18789,
          bind: "lan",
        },
      }),
    ).toBe("Gateway: remote via LAN (missing remote URL)");
  });
});

describe("resolveControlUiLinks", () => {
  it("uses customBindHost for custom bind", () => {
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "custom",
      customBindHost: "192.168.1.100",
    });
    expect(links.httpUrl).toBe("http://192.168.1.100:18789/");
    expect(links.wsUrl).toBe("ws://192.168.1.100:18789");
  });

  it("uses secure schemes when gateway TLS is enabled", () => {
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "custom",
      customBindHost: "192.168.1.100",
      tlsEnabled: true,
    });
    expect(links.httpUrl).toBe("https://192.168.1.100:18789/");
    expect(links.wsUrl).toBe("wss://192.168.1.100:18789");
  });

  it("falls back to loopback for invalid customBindHost", () => {
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "custom",
      customBindHost: "192.168.001.100",
    });
    expect(links.httpUrl).toBe("http://127.0.0.1:18789/");
    expect(links.wsUrl).toBe("ws://127.0.0.1:18789");
  });

  it("uses tailnet IP for tailnet bind", () => {
    mocks.pickPrimaryTailnetIPv4.mockReturnValueOnce("100.64.0.9");
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "tailnet",
    });
    expect(links.httpUrl).toBe("http://100.64.0.9:18789/");
    expect(links.wsUrl).toBe("ws://100.64.0.9:18789");
  });

  it("keeps loopback for auto even when tailnet is present", () => {
    mocks.pickPrimaryTailnetIPv4.mockReturnValueOnce("100.64.0.9");
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "auto",
    });
    expect(links.httpUrl).toBe("http://127.0.0.1:18789/");
    expect(links.wsUrl).toBe("ws://127.0.0.1:18789");
  });

  it("falls back to loopback for tailnet bind when interface discovery throws", () => {
    mocks.pickPrimaryTailnetIPv4.mockImplementationOnce(() => {
      throw new Error("uv_interface_addresses failed");
    });

    const links = resolveControlUiLinks({
      port: 18789,
      bind: "tailnet",
    });

    expect(links.httpUrl).toBe("http://127.0.0.1:18789/");
    expect(links.wsUrl).toBe("ws://127.0.0.1:18789");
  });

  it("falls back to loopback for LAN bind when interface discovery throws", () => {
    vi.spyOn(os, "networkInterfaces").mockImplementationOnce(() => {
      throw new Error("uv_interface_addresses failed");
    });

    const links = resolveControlUiLinks({
      port: 18789,
      bind: "lan",
    });

    expect(links.httpUrl).toBe("http://127.0.0.1:18789/");
    expect(links.wsUrl).toBe("ws://127.0.0.1:18789");
  });

  it("uses route-aware advertised LAN host for display links", async () => {
    mocks.resolveAdvertisedLanHost.mockResolvedValueOnce("10.211.55.3");

    const links = await resolveAdvertisedControlUiLinks({
      port: 18789,
      bind: "lan",
    });

    expect(links.httpUrl).toBe("http://10.211.55.3:18789/");
    expect(links.wsUrl).toBe("ws://10.211.55.3:18789");
  });

  it("keeps co-located LAN probes on loopback", () => {
    const links = resolveLocalControlUiProbeLinks({
      port: 18789,
      bind: "lan",
    });

    expect(links.httpUrl).toBe("http://127.0.0.1:18789/");
    expect(links.wsUrl).toBe("ws://127.0.0.1:18789");
    expect(mocks.resolveAdvertisedLanHost).not.toHaveBeenCalled();
  });
});

describe("normalizeGatewayTokenInput", () => {
  it("returns empty string for undefined or null", () => {
    expect(normalizeGatewayTokenInput(undefined)).toBe("");
    expect(normalizeGatewayTokenInput(null)).toBe("");
  });

  it("trims string input", () => {
    expect(normalizeGatewayTokenInput("  token  ")).toBe("token");
  });

  it("returns empty string for non-string input", () => {
    expect(normalizeGatewayTokenInput(123)).toBe("");
  });

  it('rejects literal string coercion artifacts ("undefined"/"null")', () => {
    expect(normalizeGatewayTokenInput("undefined")).toBe("");
    expect(normalizeGatewayTokenInput("null")).toBe("");
  });
});

describe("validateGatewayPasswordInput", () => {
  it("requires a non-empty password", () => {
    expect(validateGatewayPasswordInput("")).toBe("Required");
    expect(validateGatewayPasswordInput("   ")).toBe("Required");
  });

  it("rejects literal string coercion artifacts", () => {
    expect(validateGatewayPasswordInput("undefined")).toBe(
      'Cannot be the literal string "undefined" or "null"',
    );
    expect(validateGatewayPasswordInput("null")).toBe(
      'Cannot be the literal string "undefined" or "null"',
    );
  });

  it("accepts a normal password", () => {
    expect(validateGatewayPasswordInput(" secret ")).toBeUndefined();
  });
});
