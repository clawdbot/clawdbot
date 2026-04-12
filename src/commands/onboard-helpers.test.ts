import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("openUrl", () => {
  it("passes OAuth URLs to explorer.exe on win32 without cmd parsing", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "");
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");

    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&response_type=code&redirect_uri=http%3A%2F%2Flocalhost";

    const ok = await openUrl(url);
    expect(ok).toBe(true);

    expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(1);
    const [argv, options] = mocks.runCommandWithTimeout.mock.calls[0] ?? [];
    expect(argv).toEqual(["explorer.exe", url]);
    expect(options).toMatchObject({ timeoutMs: 5_000 });
    expect(options?.windowsVerbatimArguments).toBeUndefined();

    platformSpy.mockRestore();
  });
});

describe("resolveBrowserOpenCommand", () => {
  it("uses explorer.exe on win32", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const resolved = await resolveBrowserOpenCommand();
    expect(resolved.argv).toEqual(["explorer.exe"]);
    expect(resolved.command).toBe("explorer.exe");
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
