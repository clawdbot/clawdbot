import { describe, expect, it } from "vitest";
import { resolveBrowserConfig, resolveProfile, shouldStartLocalBrowserServer } from "./config.js";

describe("browser config", () => {
  it("defaults to enabled with loopback control url and lobster-orange color", () => {
    const resolved = resolveBrowserConfig(undefined);
    expect(resolved.enabled).toBe(true);
    expect(resolved.controlPort).toBe(18791);
    expect(resolved.controlHost).toBe("127.0.0.1");
    expect(resolved.color).toBe("#FF4500");
    expect(shouldStartLocalBrowserServer(resolved)).toBe(true);
    const profile = resolveProfile(resolved, resolved.defaultProfile);
    expect(profile?.name).toBe("chrome");
    expect(profile?.driver).toBe("extension");
    expect(profile?.cdpPort).toBe(18792);
    expect(profile?.cdpUrl).toBe("http://127.0.0.1:18792");

    const clawd = resolveProfile(resolved, "clawd");
    expect(clawd?.driver).toBe("clawd");
    expect(clawd?.cdpPort).toBe(18800);
    expect(clawd?.cdpUrl).toBe("http://127.0.0.1:18800");
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

  it("normalizes hex colors", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://localhost:18791",
      color: "ff4500",
    });
    expect(resolved.color).toBe("#FF4500");
  });

  it("falls back to default color for invalid hex", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://localhost:18791",
      color: "#GGGGGG",
    });
    expect(resolved.color).toBe("#FF4500");
  });

  it("treats non-loopback control urls as remote", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://example.com:18791",
    });
    expect(shouldStartLocalBrowserServer(resolved)).toBe(false);
  });

  it("derives CDP host/protocol from control url when cdpUrl is unset", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://127.0.0.1:19000",
    });
    expect(resolved.controlPort).toBe(19000);
    expect(resolved.cdpHost).toBe("127.0.0.1");
    expect(resolved.cdpProtocol).toBe("http");
  });

  it("supports explicit CDP URLs for the default profile", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://127.0.0.1:18791",
      cdpUrl: "http://example.com:9222",
    });
    const profile = resolveProfile(resolved, "clawd");
    expect(profile?.cdpPort).toBe(9222);
    expect(profile?.cdpUrl).toBe("http://example.com:9222");
    expect(profile?.cdpIsLoopback).toBe(false);
  });

  it("uses profile cdpUrl when provided", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://127.0.0.1:18791",
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
      controlUrl: "http://127.0.0.1:18791",
      cdpUrl: "https://example.com:9443",
      profiles: {
        work: { cdpPort: 18801, color: "#0066CC" },
      },
    });

    const work = resolveProfile(resolved, "work");
    expect(work?.cdpUrl).toBe("https://example.com:18801");
  });

  it("rejects unsupported protocols", () => {
    expect(() => resolveBrowserConfig({ controlUrl: "ws://127.0.0.1:18791" })).toThrow(
      /must be http/i,
    );
  });

  it("does not add the built-in chrome extension profile if the derived relay port is already used", () => {
    const resolved = resolveBrowserConfig({
      controlUrl: "http://127.0.0.1:18791",
      profiles: {
        clawd: { cdpPort: 18792, color: "#FF4500" },
      },
    });
    expect(resolveProfile(resolved, "chrome")).toBe(null);
    expect(resolved.defaultProfile).toBe("clawd");
  });
});
