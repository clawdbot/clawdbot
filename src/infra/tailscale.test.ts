import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import * as tailscale from "./tailscale.js";

const {
  ensureGoInstalled,
  ensureTailscaledInstalled,
  getTailnetHostname,
  getTestTailscaleBinaryOverride,
  enableTailscaleServe,
  disableTailscaleServe,
  ensureFunnel,
  tailscaleFunnelStatusCoversPort,
} = tailscale;
const tailscaleBin = "tailscale";

function createRuntimeWithExitError() {
  return {
    error: vi.fn(),
    log: vi.fn(),
    exit: ((code: number) => {
      throw new Error(`exit ${code}`);
    }) as (code: number) => never,
  };
}

function expectExecCall(
  exec: ReturnType<typeof vi.fn>,
  callNumber: number,
  command: string,
  args: readonly string[],
  options?: Record<string, unknown>,
) {
  const call = exec.mock.calls[callNumber - 1];
  expect(call, `call ${callNumber}`).toBeDefined();
  expect(call[0]).toBe(command);
  expect(call[1]).toEqual(args);
  if (options) {
    expect(call).toHaveLength(3);
    expect(call[2]).toEqual(options);
  } else {
    expect(call).toHaveLength(2);
  }
}

describe("tailscale helpers", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_TEST_TAILSCALE_BINARY", "NODE_ENV", "VITEST"]);
    process.env.OPENCLAW_TEST_TAILSCALE_BINARY = "tailscale";
    process.env.VITEST ??= "true";
  });

  afterEach(() => {
    envSnapshot.restore();
    vi.restoreAllMocks();
  });

  it("parses DNS name from tailscale status", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        Self: { DNSName: "host.tailnet.ts.net.", TailscaleIPs: ["100.1.1.1"] },
      }),
    });
    const host = await getTailnetHostname(exec);
    expect(host).toBe("host.tailnet.ts.net");
  });

  it("falls back to IP when DNS missing", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ Self: { TailscaleIPs: ["100.2.2.2"] } }),
    });
    const host = await getTailnetHostname(exec);
    expect(host).toBe("100.2.2.2");
  });

  it("parses noisy JSON output from tailscale status", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout:
        'warning: stale state\n{"Self":{"DNSName":"noisy.tailnet.ts.net.","TailscaleIPs":["100.9.9.9"]}}\n',
    });
    const host = await getTailnetHostname(exec);
    expect(host).toBe("noisy.tailnet.ts.net");
  });

  it("allows the test binary override in explicit test environments", () => {
    process.env.OPENCLAW_TEST_TAILSCALE_BINARY = "/tmp/test-tailscale";
    process.env.NODE_ENV = "test";
    delete process.env.VITEST;

    expect(getTestTailscaleBinaryOverride()).toBe("/tmp/test-tailscale");
  });

  it("ignores the test binary override outside test environments", () => {
    process.env.OPENCLAW_TEST_TAILSCALE_BINARY = "/tmp/attacker-tailscale";
    process.env.NODE_ENV = "production";
    delete process.env.VITEST;

    expect(getTestTailscaleBinaryOverride()).toBeNull();
  });

  it.each([
    {
      name: "ensureGoInstalled installs when missing and user agrees",
      fn: ensureGoInstalled,
      missingError: new Error("no go"),
      installCommand: ["brew", ["install", "go"]] as const,
      promptResult: true,
    },
    {
      name: "ensureTailscaledInstalled installs when missing and user agrees",
      fn: ensureTailscaledInstalled,
      missingError: new Error("missing"),
      installCommand: ["brew", ["install", "tailscale"]] as const,
      promptResult: true,
    },
  ])("$name", async ({ fn, missingError, installCommand, promptResult }) => {
    const exec = vi.fn().mockRejectedValueOnce(missingError).mockResolvedValue({});
    const prompt = vi.fn().mockResolvedValue(promptResult);
    const runtime = createRuntimeWithExitError();
    await fn(exec as never, prompt, runtime);
    expect(exec).toHaveBeenCalledWith(installCommand[0], installCommand[1]);
  });

  it.each([
    {
      name: "ensureGoInstalled exits when missing and user declines install",
      fn: ensureGoInstalled,
      missingError: new Error("no go"),
      errorMessage: "Go is required to build tailscaled from source. Aborting.",
    },
    {
      name: "ensureTailscaledInstalled exits when missing and user declines install",
      fn: ensureTailscaledInstalled,
      missingError: new Error("missing"),
      errorMessage: "tailscaled is required for user-space funnel. Aborting.",
    },
  ])("$name", async ({ fn, missingError, errorMessage }) => {
    const exec = vi.fn().mockRejectedValueOnce(missingError);
    const prompt = vi.fn().mockResolvedValue(false);
    const runtime = createRuntimeWithExitError();

    await expect(fn(exec as never, prompt, runtime)).rejects.toThrow("exit 1");
    expect(runtime.error).toHaveBeenCalledWith(errorMessage);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("enableTailscaleServe attempts normal first, then sudo", async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce({ stdout: "" });

    await enableTailscaleServe(3000, exec as never);

    expect(exec).toHaveBeenCalledTimes(2);
    expectExecCall(exec, 1, tailscaleBin, ["serve", "--bg", "--yes", "3000"], {
      maxBuffer: 200_000,
      timeoutMs: 15_000,
    });
    expectExecCall(exec, 2, "sudo", ["-n", tailscaleBin, "serve", "--bg", "--yes", "3000"], {
      maxBuffer: 200_000,
      timeoutMs: 15_000,
    });
  });

  it("enableTailscaleServe does NOT use sudo if first attempt succeeds", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "" });

    await enableTailscaleServe(3000, exec as never);

    expect(exec).toHaveBeenCalledTimes(1);
    expectExecCall(exec, 1, tailscaleBin, ["serve", "--bg", "--yes", "3000"], {
      maxBuffer: 200_000,
      timeoutMs: 15_000,
    });
  });

  it("disableTailscaleServe uses fallback", async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce({ stdout: "" });

    await disableTailscaleServe(exec as never);

    expect(exec).toHaveBeenCalledTimes(2);
    expectExecCall(exec, 2, "sudo", ["-n", tailscaleBin, "serve", "reset"], {
      maxBuffer: 200_000,
      timeoutMs: 15_000,
    });
  });

  it("ensureFunnel uses fallback for enabling", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({ BackendState: "Running" }) }) // status
      .mockRejectedValueOnce(new Error("permission denied")) // enable normal
      .mockResolvedValueOnce({ stdout: "" }); // enable sudo

    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: vi.fn() as unknown as (code: number) => never,
    };
    const prompt = vi.fn();

    await ensureFunnel(8080, exec as never, runtime, prompt);

    expect(exec).toHaveBeenCalledTimes(3);
    expectExecCall(exec, 1, tailscaleBin, ["funnel", "status", "--json"]);
    expectExecCall(exec, 2, tailscaleBin, ["funnel", "--yes", "--bg", "8080"], {
      maxBuffer: 200_000,
      timeoutMs: 15_000,
    });
    expectExecCall(exec, 3, "sudo", ["-n", tailscaleBin, "funnel", "--yes", "--bg", "8080"], {
      maxBuffer: 200_000,
      timeoutMs: 15_000,
    });
  });

  it("enableTailscaleServe skips sudo on non-permission errors", async () => {
    const exec = vi.fn().mockRejectedValueOnce(new Error("boom"));

    await expect(enableTailscaleServe(3000, exec as never)).rejects.toThrow("boom");

    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("enableTailscaleServe rethrows original error if sudo fails", async () => {
    const originalError = Object.assign(new Error("permission denied"), {
      stderr: "permission denied",
    });
    const exec = vi
      .fn()
      .mockRejectedValueOnce(originalError)
      .mockRejectedValueOnce(new Error("sudo: a password is required"));

    await expect(enableTailscaleServe(3000, exec as never)).rejects.toBe(originalError);

    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe("tailscaleFunnelStatusCoversPort", () => {
  function buildFunnelStatus(handlers: Record<string, { Proxy?: unknown }>) {
    const host = "device.tailnet.ts.net:443";
    return {
      AllowFunnel: { [host]: true },
      Web: {
        [host]: { Handlers: handlers },
      },
    } as Record<string, unknown>;
  }

  it("matches a Funnel route whose Proxy is a full http URL", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://127.0.0.1:18789" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches a Proxy URL with a trailing slash", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://127.0.0.1:18789/" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches a Proxy URL with a longer path", () => {
    const status = buildFunnelStatus({ "/api": { Proxy: "http://127.0.0.1:18789/api" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches the localhost loopback alias", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://localhost:18789" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches an IPv6 loopback Proxy", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://[::1]:18789" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches the documented https+insecure target scheme", () => {
    const status = buildFunnelStatus({
      "/": { Proxy: "https+insecure://localhost:18789" },
    });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("matches https+insecure with a trailing path", () => {
    const status = buildFunnelStatus({
      "/api": { Proxy: "https+insecure://127.0.0.1:18789/api" },
    });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("does not match https+insecure on a non-loopback host", () => {
    const status = buildFunnelStatus({
      "/": { Proxy: "https+insecure://10.0.0.5:18789" },
    });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(false);
  });

  it("matches a bare port form", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "18789" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(true);
  });

  it("does not match a Proxy on a different port", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://127.0.0.1:9000" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(false);
  });

  it("does not match a non-loopback host on the right port", () => {
    const status = buildFunnelStatus({ "/": { Proxy: "http://10.0.0.5:18789" } });
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(false);
  });

  it("ignores Web entries whose host is not in AllowFunnel", () => {
    const status = {
      AllowFunnel: { "device.tailnet.ts.net:443": false },
      Web: {
        "device.tailnet.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:18789" } },
        },
      },
    } as Record<string, unknown>;
    expect(tailscaleFunnelStatusCoversPort(status, 18789)).toBe(false);
  });

  it("returns false on an empty status payload", () => {
    expect(tailscaleFunnelStatusCoversPort({}, 18789)).toBe(false);
  });
});
