import { describe, expect, it } from "vitest";
import { resolveBrowserConfig, resolveProfile, shouldStartLocalBrowserServer } from "./config.js";

describe("browser config", () => {
  it("defaults to enabled with loopback defaults and lobster-orange color", () => {
    const resolved = resolveBrowserConfig(undefined);
    expect(resolved.enabled).toBe(true);
    expect(resolved.controlPort).toBe(18791);
    expect(resolved.color).toBe("#FF4500");
    expect(shouldStartLocalBrowserServer(resolved)).toBe(true);
    expect(resolved.cdpHost).toBe("127.0.0.1");
    expect(resolved.cdpProtocol).toBe("http");
    const profile = resolveProfile(resolved, resolved.defaultProfile);
    expect(profile?.name).toBe("chrome");
    expect(profile?.driver).toBe("extension");
    expect(profile?.cdpPort).toBe(18792);
    expect(profile?.cdpUrl).toBe("http://127.0.0.1:18792");

    const clawd = resolveProfile(resolved, "clawd");
    expect(clawd?.driver).toBe("clawd");
    expect(clawd?.cdpPort).toBe(18800);
    expect(clawd?.cdpUrl).toBe("http://127.0.0.1:18800");
    expect(resolved.remoteCdpTimeoutMs).toBe(1500);
    expect(resolved.remoteCdpHandshakeTimeoutMs).toBe(3000);
  });

  it("derives default ports from CLAWDBOT_GATEWAY_PORT when unset", () => {
    const prev = process.env.CLAWDBOT_GATEWAY_PORT;
    process.env.CLAWDBOT_GATEWAY_PORT = "19001";
    try {
      const resolved = resolveBrowserConfig(undefined);
      expect(resolved.controlPort).toBe(19003);
      const chrome = resolveProfile(resolved, "chrome");
      expect(chrome?.driver).toBe("extension");
      expect(chrome?.cdpPort).toBe(19004);
      expect(chrome?.cdpUrl).toBe("http://127.0.0.1:19004");

      const clawd = resolveProfile(resolved, "clawd");
      expect(clawd?.cdpPort).toBe(19012);
      expect(clawd?.cdpUrl).toBe("http://127.0.0.1:19012");
    } finally {
      if (prev === undefined) {
        delete process.env.CLAWDBOT_GATEWAY_PORT;
      } else {
        process.env.CLAWDBOT_GATEWAY_PORT = prev;
      }
    }
  });

  it("derives default ports from gateway.port when env is unset", () => {
    const prev = process.env.CLAWDBOT_GATEWAY_PORT;
    delete process.env.CLAWDBOT_GATEWAY_PORT;
    try {
      const resolved = resolveBrowserConfig(undefined, { gateway: { port: 19011 } });
      expect(resolved.controlPort).toBe(19013);
      const chrome = resolveProfile(resolved, "chrome");
      expect(chrome?.driver).toBe("extension");
      expect(chrome?.cdpPort).toBe(19014);
      expect(chrome?.cdpUrl).toBe("http://127.0.0.1:19014");

      const clawd = resolveProfile(resolved, "clawd");
      expect(clawd?.cdpPort).toBe(19022);
      expect(clawd?.cdpUrl).toBe("http://127.0.0.1:19022");
    } finally {
      if (prev === undefined) {
        delete process.env.CLAWDBOT_GATEWAY_PORT;
      } else {
        process.env.CLAWDBOT_GATEWAY_PORT = prev;
      }
    }
  });

  it("normalizes hex colors", () => {
    const resolved = resolveBrowserConfig({
      color: "ff4500",
    });
    expect(resolved.color).toBe("#FF4500");
  });

  it("supports custom remote CDP timeouts", () => {
    const resolved = resolveBrowserConfig({
      remoteCdpTimeoutMs: 2200,
      remoteCdpHandshakeTimeoutMs: 5000,
    });
    expect(resolved.remoteCdpTimeoutMs).toBe(2200);
    expect(resolved.remoteCdpHandshakeTimeoutMs).toBe(5000);
  });

  it("falls back to default color for invalid hex", () => {
    const resolved = resolveBrowserConfig({
      color: "#GGGGGG",
    });
    expect(resolved.color).toBe("#FF4500");
  });

  it("treats non-loopback cdpUrl as remote", () => {
    const resolved = resolveBrowserConfig({
      cdpUrl: "http://example.com:9222",
    });
    const profile = resolveProfile(resolved, "clawd");
    expect(profile?.cdpIsLoopback).toBe(false);
  });

  it("supports explicit CDP URLs for the default profile", () => {
    const resolved = resolveBrowserConfig({
      cdpUrl: "http://example.com:9222",
    });
    const profile = resolveProfile(resolved, "clawd");
    expect(profile?.cdpPort).toBe(9222);
    expect(profile?.cdpUrl).toBe("http://example.com:9222");
    expect(profile?.cdpIsLoopback).toBe(false);
  });

  it("uses profile cdpUrl when provided", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        remote: { cdpUrl: "http://10.0.0.42:9222", color: "#0066CC" },
      },
    });

    const remote = resolveProfile(resolved, "remote");
    expect(remote?.cdpUrl).toBe("http://10.0.0.42:9222");
    expect(remote?.cdpHost).toBe("10.0.0.42");
    expect(remote?.cdpIsLoopback).toBe(false);
  });

  it("uses base protocol for profiles with only cdpPort", () => {
    const resolved = resolveBrowserConfig({
      cdpUrl: "https://example.com:9443",
      profiles: {
        work: { cdpPort: 18801, color: "#0066CC" },
      },
    });

    const work = resolveProfile(resolved, "work");
    expect(work?.cdpUrl).toBe("https://example.com:18801");
  });

  it("rejects unsupported protocols", () => {
    expect(() => resolveBrowserConfig({ cdpUrl: "ws://127.0.0.1:18791" })).toThrow(/must be http/i);
  });

  it("does not add the built-in chrome extension profile if the derived relay port is already used", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        clawd: { cdpPort: 18792, color: "#FF4500" },
      },
    });
    expect(resolveProfile(resolved, "chrome")).toBe(null);
    expect(resolved.defaultProfile).toBe("clawd");
  });
});
