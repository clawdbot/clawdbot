import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import {
  handleReset,
  normalizeGatewayTokenInput,
  openUrl,
  probeGatewayReachable,
  resolveBrowserOpenCommand,
  resolveControlUiLinks,
  validateGatewayPasswordInput,
} from "./onboard-helpers.js";

const mocks = vi.hoisted(() => ({
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
  probeGateway: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: mocks.pickPrimaryTailnetIPv4,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("handleReset", () => {
  it("uses active profile paths for destructive reset targets", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-profile-"));
    const profileStateDir = path.join(homeDir, ".openclaw-work");
    const defaultStateDir = path.join(homeDir, ".openclaw");
    const profileConfigPath = path.join(profileStateDir, "openclaw.json");
    const profileCredentialsDir = path.join(profileStateDir, "credentials");
    const profileSessionsDir = path.join(profileStateDir, "agents", "main", "sessions");
    const workspaceDir = path.join(profileStateDir, "workspace");
    const defaultCredentialsDir = path.join(defaultStateDir, "credentials");

    fs.mkdirSync(profileCredentialsDir, { recursive: true });
    fs.mkdirSync(profileSessionsDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(defaultCredentialsDir, { recursive: true });
    fs.writeFileSync(profileConfigPath, "{}\n");

    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("OPENCLAW_HOME", homeDir);
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    vi.stubEnv("OPENCLAW_STATE_DIR", profileStateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", profileConfigPath);

    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;

    await handleReset("full", workspaceDir, runtime);

    const trashedPaths = mocks.runCommandWithTimeout.mock.calls.map(([argv]) => argv[1]);
    expect(trashedPaths).toEqual([
      profileConfigPath,
      profileCredentialsDir,
      profileSessionsDir,
      workspaceDir,
    ]);
    expect(trashedPaths).not.toContain(defaultCredentialsDir);
  });
});

describe("openUrl", () => {
  it("passes OAuth URLs to Windows FileProtocolHandler without cmd parsing", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("NODE_ENV", "development");
    const rundll32 = path.win32.join("C:\\Windows", "System32", "rundll32.exe");

    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&response_type=code&redirect_uri=http%3A%2F%2Flocalhost";

    const ok = await openUrl(url);
    expect(ok).toBe(true);

    expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(1);
    const [argv, options] = mocks.runCommandWithTimeout.mock.calls[0] ?? [];
    expect(argv).toEqual([rundll32, "url.dll,FileProtocolHandler", url]);
    expect(options?.timeoutMs).toBe(5_000);
    expect(options?.windowsVerbatimArguments).toBeUndefined();

    platformSpy.mockRestore();
  });

  it("does not pass non-http URLs to the OS browser handler", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const ok = await openUrl("file://C:/Users/test/secrets.txt");

    expect(ok).toBe(false);
    expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();

    platformSpy.mockRestore();
  });
});

describe("resolveBrowserOpenCommand", () => {
  it("uses trusted rundll32 on win32", async () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const rundll32 = path.win32.join("C:\\Windows", "System32", "rundll32.exe");

    const resolved = await resolveBrowserOpenCommand();
    expect(resolved.argv).toEqual([rundll32, "url.dll,FileProtocolHandler"]);
    expect(resolved.command).toBe(rundll32);
    platformSpy.mockRestore();
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
