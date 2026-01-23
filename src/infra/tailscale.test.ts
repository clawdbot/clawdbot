import { describe, expect, it, vi } from "vitest";

import {
  ensureGoInstalled,
  ensureTailscaledInstalled,
  getTailnetHostname,
  enableTailscaleServe,
  disableTailscaleServe,
  enableTailscaleFunnel,
  disableTailscaleFunnel,
  ensureFunnel
} from "./tailscale.js";

describe("tailscale helpers", () => {
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

  it("ensureGoInstalled installs when missing and user agrees", async () => {
    const exec = vi.fn().mockRejectedValueOnce(new Error("no go")).mockResolvedValue({}); // brew install go
    const prompt = vi.fn().mockResolvedValue(true);
    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: ((code: number) => {
        throw new Error(`exit ${code}`);
      }) as (code: number) => never,
    };
    await ensureGoInstalled(exec as never, prompt, runtime);
    expect(exec).toHaveBeenCalledWith("brew", ["install", "go"]);
  });

  it("ensureTailscaledInstalled installs when missing and user agrees", async () => {
    const exec = vi.fn().mockRejectedValueOnce(new Error("missing")).mockResolvedValue({});
    const prompt = vi.fn().mockResolvedValue(true);
    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: ((code: number) => {
        throw new Error(`exit ${code}`);
      }) as (code: number) => never,
    };
    await ensureTailscaledInstalled(exec as never, prompt, runtime);
    expect(exec).toHaveBeenCalledWith("brew", ["install", "tailscale"]);
  });

  it("enableTailscaleServe uses sudo", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "" });
    await enableTailscaleServe(3000, exec as never);
    expect(exec).toHaveBeenCalledWith(
      "sudo",
      expect.arrayContaining(["-n", "tailscale", "serve", "--bg", "--yes", "3000"]),
      expect.any(Object)
    );
  });

  it("disableTailscaleServe uses sudo", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "" });
    await disableTailscaleServe(exec as never);
    expect(exec).toHaveBeenCalledWith(
      "sudo",
      expect.arrayContaining(["-n", "tailscale", "serve", "reset"]),
      expect.any(Object)
    );
  });

  it("enableTailscaleFunnel uses sudo", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "" });
    await enableTailscaleFunnel(4000, exec as never);
    expect(exec).toHaveBeenCalledWith(
      "sudo",
      expect.arrayContaining(["-n", "tailscale", "funnel", "--bg", "--yes", "4000"]),
      expect.any(Object)
    );
  });

  it("disableTailscaleFunnel uses sudo", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "" });
    await disableTailscaleFunnel(exec as never);
    expect(exec).toHaveBeenCalledWith(
      "sudo",
      expect.arrayContaining(["-n", "tailscale", "funnel", "reset"]),
      expect.any(Object)
    );
  });

  it("ensureFunnel uses sudo for enabling", async () => {
    // Mock exec: first call is status (not sudo), second call is enable (sudo)
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({ BackendState: "Running" }) }) // status
      .mockResolvedValueOnce({ stdout: "" }); // enable

    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: vi.fn() as unknown as (code: number) => never,
    };
    const prompt = vi.fn();

    await ensureFunnel(8080, exec as never, runtime, prompt);

    // First call: check status (no sudo)
    expect(exec).toHaveBeenNthCalledWith(
      1,
      "tailscale",
      expect.arrayContaining(["funnel", "status", "--json"])
    );

    // Second call: enable (sudo)
    expect(exec).toHaveBeenNthCalledWith(
      2,
      "sudo",
      expect.arrayContaining(["-n", "tailscale", "funnel", "--yes", "--bg", "8080"]),
      expect.any(Object)
    );
  });
});
