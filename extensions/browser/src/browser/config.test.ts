import { describe, expect, it } from "vitest";
import type { BrowserConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { resolveBrowserConfig, resolveProfile, shouldStartLocalBrowserServer } from "./config.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const snapshot = new Map<string, string | undefined>();
  for (const [key] of Object.entries(env)) {
    snapshot.set(key, process.env[key]);
  }

  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return fn();
  } finally {
    for (const [key, value] of snapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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
    expect(profile?.name).toBe("openclaw");
    expect(profile?.driver).toBe("openclaw");
    expect(profile?.cdpPort).toBe(18800);
    expect(profile?.cdpUrl).toBe("http://127.0.0.1:18800");

    const openclaw = resolveProfile(resolved, "openclaw");
    expect(openclaw?.driver).toBe("openclaw");
    expect(openclaw?.cdpPort).toBe(18800);
    expect(openclaw?.cdpUrl).toBe("http://127.0.0.1:18800");
    const user = resolveProfile(resolved, "user");
    expect(user?.driver).toBe("existing-session");
    expect(user?.cdpPort).toBe(0);
    expect(user?.cdpUrl).toBe("");
    expect(user?.userDataDir).toBeUndefined();
    // chrome-relay is no longer auto-created
    expect(resolveProfile(resolved, "chrome-relay")).toBe(null);
    expect(resolved.remoteCdpTimeoutMs).toBe(1500);
    expect(resolved.remoteCdpHandshakeTimeoutMs).toBe(3000);
  });

  it("derives default ports from OPENCLAW_GATEWAY_PORT when unset", () => {
    withEnv({ OPENCLAW_GATEWAY_PORT: "19001" }, () => {
      const resolved = resolveBrowserConfig(undefined);
      expect(resolved.controlPort).toBe(19003);
      expect(resolveProfile(resolved, "chrome-relay")).toBe(null);

      const openclaw = resolveProfile(resolved, "openclaw");
      expect(openclaw?.cdpPort).toBe(19012);
      expect(openclaw?.cdpUrl).toBe("http://127.0.0.1:19012");
    });
  });

  it("derives default ports from gateway.port when env is unset", () => {
    withEnv({ OPENCLAW_GATEWAY_PORT: undefined }, () => {
      const resolved = resolveBrowserConfig(undefined, { gateway: { port: 19011 } });
      expect(resolved.controlPort).toBe(19013);
      expect(resolveProfile(resolved, "chrome-relay")).toBe(null);

      const openclaw = resolveProfile(resolved, "openclaw");
      expect(openclaw?.cdpPort).toBe(19022);
      expect(openclaw?.cdpUrl).toBe("http://127.0.0.1:19022");
    });
  });

  it("supports overriding the local CDP auto-allocation range start", () => {
    const resolved = resolveBrowserConfig({
      cdpPortRangeStart: 19000,
    });
    const openclaw = resolveProfile(resolved, "openclaw");
    expect(resolved.cdpPortRangeStart).toBe(19000);
    expect(openclaw?.cdpPort).toBe(19000);
    expect(openclaw?.cdpUrl).toBe("http://127.0.0.1:19000");
  });

  it("rejects cdpPortRangeStart values that overflow the CDP range window", () => {
    expect(() => resolveBrowserConfig({ cdpPortRangeStart: 65535 })).toThrow(
      /cdpPortRangeStart .* too high/i,
    );
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
    const profile = resolveProfile(resolved, "openclaw");
    expect(profile?.cdpIsLoopback).toBe(false);
  });

  it("supports explicit CDP URLs for the default profile", () => {
    const resolved = resolveBrowserConfig({
      cdpUrl: "http://example.com:9222",
    });
    const profile = resolveProfile(resolved, "openclaw");
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

  it("inherits attachOnly from global browser config when profile override is not set", () => {
    const resolved = resolveBrowserConfig({
      attachOnly: true,
      profiles: {
        remote: { cdpUrl: "http://127.0.0.1:9222", color: "#0066CC" },
      },
    });

    const remote = resolveProfile(resolved, "remote");
    expect(remote?.attachOnly).toBe(true);
  });

  it("allows profile attachOnly to override global browser attachOnly", () => {
    const resolved = resolveBrowserConfig({
      attachOnly: false,
      profiles: {
        remote: { cdpUrl: "http://127.0.0.1:9222", attachOnly: true, color: "#0066CC" },
      },
    });

    const remote = resolveProfile(resolved, "remote");
    expect(remote?.attachOnly).toBe(true);
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

  it("preserves wss:// cdpUrl with query params for the default profile", () => {
    const resolved = resolveBrowserConfig({
      cdpUrl: "wss://connect.browserbase.com?apiKey=test-key",
    });
    const profile = resolveProfile(resolved, "openclaw");
    expect(profile?.cdpUrl).toBe("wss://connect.browserbase.com/?apiKey=test-key");
    expect(profile?.cdpHost).toBe("connect.browserbase.com");
    expect(profile?.cdpPort).toBe(443);
    expect(profile?.cdpIsLoopback).toBe(false);
  });

  it("preserves loopback direct WebSocket cdpUrl for explicit profiles", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        localws: {
          cdpUrl: "ws://127.0.0.1:9222/devtools/browser/ABC?token=test-key",
          color: "#0066CC",
        },
      },
    });
    const profile = resolveProfile(resolved, "localws");
    expect(profile?.cdpUrl).toBe("ws://127.0.0.1:9222/devtools/browser/ABC?token=test-key");
    expect(profile?.cdpPort).toBe(9222);
    expect(profile?.cdpIsLoopback).toBe(true);
  });

  it("prefers cdpPort over stale WebSocket devtools cdpUrl when both are set", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        "chrome-cdp": {
          cdpPort: 9222,
          cdpUrl: "ws://127.0.0.1:9222/devtools/browser/old-stale-id",
          attachOnly: true,
          color: "#F59E0B",
        },
      },
    });
    const profile = resolveProfile(resolved, "chrome-cdp");
    // cdpPort produces a stable HTTP endpoint; the stale WS session ID is dropped.
    expect(profile?.cdpUrl).toBe("http://127.0.0.1:9222");
    expect(profile?.cdpPort).toBe(9222);
    expect(profile?.cdpIsLoopback).toBe(true);
    expect(profile?.attachOnly).toBe(true);
  });

  it("preserves profile host when dropping stale devtools WS path", () => {
    const resolved = resolveBrowserConfig({
      cdpUrl: "http://devbox.local:9000",
      profiles: {
        "chrome-local": {
          cdpPort: 9222,
          cdpUrl: "ws://10.0.0.42:9222/devtools/browser/stale-id",
          color: "#0066CC",
        },
      },
    });
    const profile = resolveProfile(resolved, "chrome-local");
    // Host comes from the profile WS URL, not the global cdpUrl.
    expect(profile?.cdpUrl).toBe("http://10.0.0.42:9222");
    expect(profile?.cdpHost).toBe("10.0.0.42");
    expect(profile?.cdpIsLoopback).toBe(false);
  });

  it("rejects unsupported protocols", () => {
    expect(() => resolveBrowserConfig({ cdpUrl: "ftp://127.0.0.1:18791" })).toThrow(
      "must be http(s) or ws(s)",
    );
  });

  it("defaults extraArgs to empty array when not provided", () => {
    const resolved = resolveBrowserConfig(undefined);
    expect(resolved.extraArgs).toEqual([]);
  });

  it("passes through valid extraArgs strings", () => {
    const resolved = resolveBrowserConfig({
      extraArgs: ["--no-sandbox", "--disable-gpu"],
    });
    expect(resolved.extraArgs).toEqual(["--no-sandbox", "--disable-gpu"]);
  });

  it("filters out empty strings and whitespace-only entries from extraArgs", () => {
    const resolved = resolveBrowserConfig({
      extraArgs: ["--flag", "", "  ", "--other"],
    });
    expect(resolved.extraArgs).toEqual(["--flag", "--other"]);
  });

  it("filters out non-string entries from extraArgs", () => {
    const resolved = resolveBrowserConfig({
      extraArgs: ["--flag", 42, null, undefined, true, "--other"] as unknown as string[],
    });
    expect(resolved.extraArgs).toEqual(["--flag", "--other"]);
  });

  it("defaults extraArgs to empty array when set to non-array", () => {
    const resolved = resolveBrowserConfig({
      extraArgs: "not-an-array" as unknown as string[],
    });
    expect(resolved.extraArgs).toEqual([]);
  });

  it("resolves browser SSRF policy when configured", () => {
    const resolved = resolveBrowserConfig({
      ssrfPolicy: {
        allowPrivateNetwork: true,
        allowedHostnames: [" localhost ", ""],
        hostnameAllowlist: [" *.trusted.example ", " "],
      },
    } as unknown as BrowserConfig);
    expect(resolved.ssrfPolicy).toEqual({
      dangerouslyAllowPrivateNetwork: true,
      allowedHostnames: ["localhost"],
      hostnameAllowlist: ["*.trusted.example"],
    });
  });

  it("defaults browser SSRF policy to strict mode when unset", () => {
    const resolved = resolveBrowserConfig({});
    expect(resolved.ssrfPolicy).toEqual({});
  });

  it("supports explicit strict mode by disabling private network access", () => {
    const resolved = resolveBrowserConfig({
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: false,
      },
    });
    expect(resolved.ssrfPolicy).toEqual({ dangerouslyAllowPrivateNetwork: false });
  });

  it("preserves legacy explicit strict mode from allowPrivateNetwork=false", () => {
    const resolved = resolveBrowserConfig({
      ssrfPolicy: {
        allowPrivateNetwork: false,
      },
    } as unknown as BrowserConfig);
    expect(resolved.ssrfPolicy).toEqual({ dangerouslyAllowPrivateNetwork: false });
  });

  it("keeps allowlist-only browser SSRF policy strict by default", () => {
    const resolved = resolveBrowserConfig({
      ssrfPolicy: {
        allowedHostnames: ["example.com"],
        hostnameAllowlist: ["*.example.com"],
      },
    } as unknown as BrowserConfig);
    expect(resolved.ssrfPolicy).toEqual({
      allowedHostnames: ["example.com"],
      hostnameAllowlist: ["*.example.com"],
    });
  });

  it("keeps configured profile cdpUrls out of the shared browser SSRF policy", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        remote: {
          color: "#123456",
          cdpUrl: "http://172.29.128.1:9223",
        },
      },
    });
    expect(resolved.ssrfPolicy).toEqual({});
  });

  it("resolves existing-session profiles without cdpPort or cdpUrl", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        "chrome-live": {
          driver: "existing-session",
          attachOnly: true,
          color: "#00AA00",
        },
      },
    });
    const profile = resolveProfile(resolved, "chrome-live");
    expect(profile).not.toBeNull();
    expect(profile?.driver).toBe("existing-session");
    expect(profile?.attachOnly).toBe(true);
    expect(profile?.cdpPort).toBe(0);
    expect(profile?.cdpUrl).toBe("");
    expect(profile?.cdpIsLoopback).toBe(true);
    expect(profile?.userDataDir).toBeUndefined();
    expect(profile?.color).toBe("#00AA00");
  });

  it("expands tilde-prefixed userDataDir for existing-session profiles", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        brave: {
          driver: "existing-session",
          attachOnly: true,
          userDataDir: "~/Library/Application Support/BraveSoftware/Brave-Browser",
          color: "#FB542B",
        },
      },
    });

    const profile = resolveProfile(resolved, "brave");
    expect(profile?.driver).toBe("existing-session");
    expect(profile?.userDataDir).toBe(
      resolveUserPath("~/Library/Application Support/BraveSoftware/Brave-Browser"),
    );
  });

  it("sets usesChromeMcp only for existing-session profiles", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        "chrome-live": { driver: "existing-session", attachOnly: true, color: "#00AA00" },
        work: { cdpPort: 18801, color: "#0066CC" },
      },
    });

    const existingSession = resolveProfile(resolved, "chrome-live")!;
    expect(getBrowserProfileCapabilities(existingSession).usesChromeMcp).toBe(true);

    const managed = resolveProfile(resolved, "openclaw")!;
    expect(getBrowserProfileCapabilities(managed).usesChromeMcp).toBe(false);

    const work = resolveProfile(resolved, "work")!;
    expect(getBrowserProfileCapabilities(work).usesChromeMcp).toBe(false);
  });

  describe("default profile preference", () => {
    it("defaults to openclaw profile when defaultProfile is not configured", () => {
      const resolved = resolveBrowserConfig({
        headless: false,
        noSandbox: false,
      });
      expect(resolved.defaultProfile).toBe("openclaw");
    });

    it("keeps openclaw default when headless=true", () => {
      const resolved = resolveBrowserConfig({
        headless: true,
      });
      expect(resolved.defaultProfile).toBe("openclaw");
    });

    it("keeps openclaw default when noSandbox=true", () => {
      const resolved = resolveBrowserConfig({
        noSandbox: true,
      });
      expect(resolved.defaultProfile).toBe("openclaw");
    });

    it("keeps openclaw default when both headless and noSandbox are true", () => {
      const resolved = resolveBrowserConfig({
        headless: true,
        noSandbox: true,
      });
      expect(resolved.defaultProfile).toBe("openclaw");
    });

    it("explicit defaultProfile config overrides defaults in headless mode", () => {
      const resolved = resolveBrowserConfig({
        headless: true,
        defaultProfile: "user",
      });
      expect(resolved.defaultProfile).toBe("user");
    });

    it("explicit defaultProfile config overrides defaults in noSandbox mode", () => {
      const resolved = resolveBrowserConfig({
        noSandbox: true,
        defaultProfile: "user",
      });
      expect(resolved.defaultProfile).toBe("user");
    });

    it("allows custom profile as default even in headless mode", () => {
      const resolved = resolveBrowserConfig({
        headless: true,
        defaultProfile: "custom",
        profiles: {
          custom: { cdpPort: 19999, color: "#00FF00" },
        },
      });
      expect(resolved.defaultProfile).toBe("custom");
    });
  });
});
