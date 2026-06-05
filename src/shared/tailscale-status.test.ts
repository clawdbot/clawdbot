// Tailscale status tests cover status parsing and validation.
import { describe, expect, it, vi } from "vitest";
import { resolveTailnetHostWithRunner } from "./tailscale-status.js";

describe("shared/tailscale-status", () => {
  it("returns null when no runner is provided", async () => {
    await expect(resolveTailnetHostWithRunner()).resolves.toBeNull();
  });

  it("prefers DNS names and trims trailing dots from status json", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: 'noise\n{"Self":{"DNSName":"mac.tail123.ts.net.","TailscaleIPs":["100.64.0.8"]}}',
    });

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBe("mac.tail123.ts.net");
    expect(run).toHaveBeenCalledWith(["tailscale", "status", "--json"], { timeoutMs: 5000 });
  });

  it("falls back across command candidates and then to the first tailscale ip", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("missing binary")).mockResolvedValueOnce({
      code: 0,
      stdout: '{"Self":{"TailscaleIPs":["100.64.0.9","fd7a::1"]}}',
    });

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBe("100.64.0.9");
    expect(run).toHaveBeenNthCalledWith(
      2,
      ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "status", "--json"],
      {
        timeoutMs: 5000,
      },
    );
  });

  it("falls back to the first tailscale ip when DNSName is blank", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: '{"Self":{"DNSName":"","TailscaleIPs":["100.64.0.10","fd7a::2"]}}',
    });

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBe("100.64.0.10");
  });

  it("continues to later command candidates when earlier output has no usable host", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: '{"Self":{}}' })
      .mockResolvedValueOnce({
        code: 0,
        stdout: '{"Self":{"DNSName":"backup.tail.ts.net."}}',
      });

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBe("backup.tail.ts.net");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("continues when the first candidate returns success but malformed Self data", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: '{"Self":"bad"}' })
      .mockResolvedValueOnce({
        code: 0,
        stdout: 'prefix {"Self":{"TailscaleIPs":["100.64.0.11"]}} suffix',
      });

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBe("100.64.0.11");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("returns null for non-zero exits, blank output, or invalid json", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: null, stdout: "boom" })
      .mockResolvedValueOnce({ code: 1, stdout: "boom" })
      .mockResolvedValueOnce({ code: 0, stdout: "   " });

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBeNull();

    const invalid = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "not-json",
    });
    await expect(resolveTailnetHostWithRunner(invalid)).resolves.toBeNull();
  });
});
