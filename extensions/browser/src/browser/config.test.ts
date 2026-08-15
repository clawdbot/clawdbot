// Browser tests cover config plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserConfig, BrowserProfileConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import {
  getManagedBrowserMissingDisplayError,
  resolveBrowserConfig,
  resolveManagedBrowserHeadlessMode,
  resolveProfile,
} from "./config.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";

const BROWSER_HEADLESS_ENV_KEY = "OPENCLAW_BROWSER_HEADLESS";

// Isolate the extension relay secret (read from stateDir/credentials) so the
// extension-token assertions do not pick up a developer's real secret file.
let isolatedStateDir = "";
let openClawState: OpenClawTestState;
beforeEach(async () => {
  openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-cfg-",
  });
  isolatedStateDir = openClawState.stateDir;
});
afterEach(async () => {
  await openClawState.cleanup();
});

/** Write a relay secret into the isolated state dir's credentials directory. */
function writeRelaySecret(token: string): void {
  const dir = path.join(isolatedStateDir, "credentials");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "browser-extension-relay.secret"), `${token}\n`);
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const snapshot = new Map<string, string | undefined>();
  for (const [key] of Object.entries(env)) {
    snapshot.set(key, process.env[key]);
  }

  try {
    for (const key of Object.keys(env)) {
      const value = env[key];
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

function resolveRequiredProfile(config: BrowserConfig, profileName: string) {
  const profile = resolveProfile(resolveBrowserConfig(config), profileName);
  if (!profile) {
    throw new Error(`Expected resolved browser profile ${profileName}`);
  }
  return profile;
}

function withProfile(
  name: string,
  profile: BrowserProfileConfig,
  root: Omit<BrowserConfig, "profiles"> = {},
): BrowserConfig {
  return { ...root, profiles: { [name]: { color: "#FF4500", ...profile } } };
}

describe("browser config", () => {
  it("defaults to enabled with loopback defaults and lobster-orange color", () => {
    const resolved = resolveBrowserConfig(undefined);
    expect(resolved.enabled).toBe(true);
    expect(resolved.controlPort).toBe(18791);
    expect(resolved.color).toBe("#FF4500");
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
    expect(resolved.actionTimeoutMs).toBe(60_000);
    expect(resolved.tabCleanup).toEqual({
      enabled: true,
      idleMinutes: 120,
      maxTabsPerSession: 8,
      sweepMinutes: 5,
    });
  });

  it("provides a built-in chrome extension-relay profile with a derived loopback port", () => {
    const resolved = resolveBrowserConfig(undefined);
    const chrome = resolveProfile(resolved, "chrome");
    expect(chrome?.driver).toBe("extension");
    expect(chrome?.attachOnly).toBe(true);
    // Relay port sits just below the CDP allocation range (controlPort + 8).
    expect(chrome?.cdpPort).toBe(resolved.extensionRelayDefaultPort);
    expect(resolved.extensionRelayDefaultPort).toBe(resolved.controlPort + 8);
    // No host-local relay secret exists yet (isolated state dir), so the relay
    // cdpUrl carries no Basic credentials until pairing/startup creates one.
    expect(chrome?.cdpUrl).toBe(`http://127.0.0.1:${resolved.extensionRelayDefaultPort}`);
    expect(chrome?.cdpIsLoopback).toBe(true);
  });

  it("assigns distinct relay ports to multiple extension profiles", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        work: { driver: "extension", color: "#00AA00" },
      },
    });
    const chrome = resolveProfile(resolved, "chrome");
    const work = resolveProfile(resolved, "work");
    // Both are extension profiles without an explicit cdpPort; they must not
    // collide on one relay port (the second would fail to bind).
    expect(chrome?.cdpPort).not.toBe(work?.cdpPort);
    expect(new Set([chrome?.cdpPort, work?.cdpPort]).size).toBe(2);
    // Ports count down from the default, staying below the CDP allocation band.
    expect(Math.max(chrome?.cdpPort ?? 0, work?.cdpPort ?? 0)).toBe(
      resolved.extensionRelayDefaultPort,
    );
  });

  it("honors an explicit cdpPort on an extension profile", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        work: { driver: "extension", cdpPort: 20123, color: "#00AA00" },
      },
    });
    expect(resolveProfile(resolved, "work")?.cdpPort).toBe(20123);
  });

  it("does not assign an implicit extension relay an explicitly pinned extension port", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        work: { driver: "extension", cdpPort: 18799, color: "#00AA00" },
      },
    });

    expect(resolveProfile(resolved, "work")?.cdpPort).toBe(18799);
    expect(resolveProfile(resolved, "chrome")?.cdpPort).toBe(18798);
  });

  it("does not assign an implicit extension relay an explicitly pinned managed port", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        pinned: { cdpPort: 18799, color: "#00AA00" },
      },
    });

    expect(resolveProfile(resolved, "pinned")?.cdpPort).toBe(18799);
    expect(resolveProfile(resolved, "chrome")?.cdpPort).toBe(18798);
  });

  it("rejects implicit extension relays that exhaust the reserved port band", () => {
    const profiles: NonNullable<BrowserConfig["profiles"]> = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `extension-${index}`,
        { driver: "extension" as const, color: "#00AA00" },
      ]),
    );

    expect(() => resolveBrowserConfig({ profiles })).toThrow(/extension.*relay.*port/i);
  });

  it("keeps the host-local relay key out of the extension cdpUrl", () => {
    const relayKey = "a".repeat(64);
    writeRelaySecret(relayKey);
    const resolved = resolveBrowserConfig(undefined);
    expect(resolved.extensionRelayToken).toBe(relayKey);
    const chrome = resolveProfile(resolved, "chrome");
    expect(chrome?.cdpUrl).toBe(`http://127.0.0.1:${resolved.extensionRelayDefaultPort}`);

    resolved.extensionRelayInternalTokens.chrome = "process-only-token";
    expect(resolveProfile(resolved, "chrome")?.cdpUrl).toBe(
      [
        "http://openclaw-internal:",
        "process-only-token",
        `@127.0.0.1:${resolved.extensionRelayDefaultPort}`,
      ].join(""),
    );
  });

  it("allows legacy extension relay auth for one migration window by default", () => {
    expect(resolveBrowserConfig(undefined).extensionRelay.allowLegacyAuth).toBe(true);
    expect(
      resolveBrowserConfig({ extensionRelay: { allowLegacyAuth: false } }).extensionRelay
        .allowLegacyAuth,
    ).toBe(false);
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

  it.each([
    {
      name: "expands tilde-prefixed executablePath with the OS home directory",
      input: " ~/.local/bin/chromium ",
      expected: path.resolve(os.homedir(), ".local/bin/chromium"),
    },
    {
      name: "keeps non-tilde executablePath values unchanged after trimming",
      input: " ./local-chromium ",
      expected: "./local-chromium",
    },
    {
      name: "normalizes blank executablePath to undefined",
      input: "   ",
      expected: undefined,
    },
    {
      name: "expands a bare ~ executablePath to the OS home directory",
      input: "~",
      expected: path.resolve(os.homedir()),
    },
    {
      name: "does not expand executablePath values where ~ is not the home prefix",
      input: "/opt/~chromium/chrome",
      expected: "/opt/~chromium/chrome",
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveBrowserConfig({ executablePath: input }).executablePath).toBe(expected);
  });

  // Windows-only: on POSIX path.resolve treats `\` as a literal character,
  // so "~\foo" cannot resolve to "$HOME/foo". The helper's regex still matches
  // a leading `~\` on every platform; we only assert the resolved form where
  // the OS path module agrees.
  (process.platform === "win32" ? it : it.skip)(
    "expands a Windows-style ~\\ executablePath to the OS home directory",
    () => {
      const resolved = resolveBrowserConfig({
        executablePath: "~\\AppData\\Local\\Chromium\\chrome.exe",
      });

      expect(resolved.executablePath).toBe(
        path.resolve(os.homedir(), "AppData/Local/Chromium/chrome.exe"),
      );
    },
  );

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

  it.each([
    {
      name: "inherits attachOnly from global browser config when profile override is not set",
      root: { attachOnly: true },
      profile: {},
      expected: { attachOnly: true },
    },
    {
      name: "allows profile attachOnly to override global browser attachOnly",
      root: { attachOnly: false },
      profile: { attachOnly: true },
      expected: { attachOnly: true },
    },
    {
      name: "inherits headless from global browser config when profile override is not set",
      root: { headless: true },
      profile: {},
      expected: { headless: true },
    },
    {
      name: "allows profile headless to override global browser headless",
      root: { headless: false },
      profile: { headless: true },
      expected: { headless: true },
    },
    {
      name: "allows profile headless=false to override global browser headless=true",
      root: { headless: true },
      profile: { headless: false },
      expected: { headless: false },
    },
    {
      name: "inherits executablePath from global browser config when profile override is not set",
      root: { executablePath: "~/bin/chrome-global" },
      profile: {},
      expected: { executablePath: path.resolve(os.homedir(), "bin/chrome-global") },
    },
    {
      name: "allows profile executablePath to override global browser executablePath",
      root: { executablePath: "/usr/bin/chrome-global" },
      profile: { executablePath: " ~/bin/chrome-profile " },
      expected: { executablePath: path.resolve(os.homedir(), "bin/chrome-profile") },
    },
    {
      name: "falls back to global executablePath when profile executablePath is blank",
      root: { executablePath: "/usr/bin/chrome-global" },
      profile: { executablePath: "   " },
      expected: { executablePath: "/usr/bin/chrome-global" },
    },
  ])("$name", ({ root, profile, expected }) => {
    expect(
      resolveRequiredProfile(
        {
          ...root,
          profiles: {
            remote: { cdpUrl: "http://127.0.0.1:9222", color: "#0066CC", ...profile },
          },
        },
        "remote",
      ),
    ).toMatchObject(expected);
  });

  describe("managed browser headless mode", () => {
    const noDisplayEnv = {
      DISPLAY: undefined,
      WAYLAND_DISPLAY: undefined,
      [BROWSER_HEADLESS_ENV_KEY]: undefined,
    };

    it.each([
      {
        name: "falls back to headless for local managed Linux profiles without display",
        config: {},
        profileName: "openclaw",
        expected: { headless: true, source: "linux-display-fallback" },
      },
      {
        name: "does not apply the no-display fallback to remote CDP profiles",
        config: withProfile("remote", { cdpUrl: "http://10.0.0.42:9222" }),
        profileName: "remote",
        expected: { headless: false, source: "default" },
      },
      {
        name: "lets explicit profile headless=false beat the Linux no-display fallback",
        config: withProfile("openclaw", { cdpPort: 18800, headless: false }, { headless: true }),
        profileName: "openclaw",
        expected: { headless: false, source: "profile" },
      },
      {
        name: "lets explicit global headless=false beat the Linux no-display fallback",
        config: { headless: false },
        profileName: "openclaw",
        expected: { headless: false, source: "config" },
      },
      {
        name: "lets OPENCLAW_BROWSER_HEADLESS override profile/global config",
        config: withProfile("openclaw", { cdpPort: 18800, headless: false }),
        profileName: "openclaw",
        headlessEnv: "1",
        expected: { headless: true, source: "env" },
      },
      {
        name: "lets request-local headless override beat env and profile/global config",
        config: withProfile("openclaw", { cdpPort: 18800, headless: false }, { headless: false }),
        profileName: "openclaw",
        headlessEnv: "0",
        headlessOverride: true,
        expected: { headless: true, source: "request" },
      },
    ])("$name", ({ config, profileName, headlessEnv, headlessOverride, expected }) => {
      const resolved = resolveBrowserConfig(config);
      const profile = resolveProfile(resolved, profileName)!;
      expect(
        resolveManagedBrowserHeadlessMode(resolved, profile, {
          headlessOverride,
          platform: "linux",
          env: { ...noDisplayEnv, [BROWSER_HEADLESS_ENV_KEY]: headlessEnv },
        }),
      ).toEqual(expected);
    });

    it("returns an actionable error only when headed mode is explicitly selected", () => {
      const defaultResolved = resolveBrowserConfig({});
      const defaultProfile = resolveProfile(defaultResolved, "openclaw")!;
      expect(
        getManagedBrowserMissingDisplayError(defaultResolved, defaultProfile, {
          platform: "linux",
          env: noDisplayEnv,
        }),
      ).toBeNull();

      const profileResolved = resolveBrowserConfig({
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500", headless: false },
        },
      });
      const profile = resolveProfile(profileResolved, "openclaw")!;
      expect(
        getManagedBrowserMissingDisplayError(profileResolved, profile, {
          platform: "linux",
          env: noDisplayEnv,
        }),
      ).toMatchObject({
        message: expect.stringContaining("browser.profiles.openclaw.headless=false"),
        headlessSource: "profile",
      });

      expect(
        getManagedBrowserMissingDisplayError(defaultResolved, defaultProfile, {
          headlessOverride: false,
          platform: "linux",
          env: noDisplayEnv,
        }),
      ).toMatchObject({
        message: expect.stringContaining("request override"),
        headlessSource: "request",
      });
    });
  });

  describe("managed browser startup timeouts", () => {
    it("uses defaults for local launch and post-launch readiness windows", () => {
      const resolved = resolveBrowserConfig({});

      expect(resolved.localLaunchTimeoutMs).toBe(15_000);
      expect(resolved.localCdpReadyTimeoutMs).toBe(8_000);
    });
  });

  it.each([
    {
      name: "uses base protocol for profiles with only cdpPort",
      config: withProfile("work", { cdpPort: 18801 }, { cdpUrl: "https://example.com:9443" }),
      profileName: "work",
      expected: { cdpUrl: "https://example.com:18801" },
    },
    {
      name: "preserves wss:// cdpUrl with query params for the default profile",
      config: { cdpUrl: "wss://connect.browserbase.com?apiKey=test-key" },
      profileName: "openclaw",
      expected: {
        cdpUrl: "wss://connect.browserbase.com/?apiKey=test-key",
        cdpHost: "connect.browserbase.com",
        cdpPort: 443,
        cdpIsLoopback: false,
      },
    },
    {
      name: "preserves loopback direct WebSocket cdpUrl for explicit profiles",
      config: withProfile("localws", {
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/ABC?token=test-key",
      }),
      profileName: "localws",
      expected: {
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/ABC?token=test-key",
        cdpPort: 9222,
        cdpIsLoopback: true,
      },
    },
    {
      name: "URL with non-default port wins over cdpPort",
      config: withProfile("openclaw", { cdpPort: 18800, cdpUrl: "http://127.0.0.1:9222" }),
      profileName: "openclaw",
      expected: { cdpPort: 9222, cdpUrl: "http://127.0.0.1:9222" },
    },
    {
      name: "URL with explicit default port :80 wins over cdpPort",
      config: withProfile("openclaw", { cdpPort: 18800, cdpUrl: "http://127.0.0.1:80" }),
      profileName: "openclaw",
      expected: { cdpPort: 80, cdpUrl: "http://127.0.0.1:80" },
    },
    {
      name: "URL without port defers to cdpPort",
      config: withProfile("openclaw", { cdpPort: 18800, cdpUrl: "http://127.0.0.1" }),
      profileName: "openclaw",
      expected: { cdpPort: 18800, cdpUrl: "http://127.0.0.1:18800" },
    },
    {
      name: "URL with non-default port, no cdpPort configured",
      config: withProfile("openclaw", { cdpUrl: "http://127.0.0.1:9222" }),
      profileName: "openclaw",
      expected: { cdpPort: 9222, cdpUrl: "http://127.0.0.1:9222" },
    },
    {
      name: "URL without port and no cdpPort falls back to protocol default",
      config: withProfile("openclaw", { cdpUrl: "https://remote-browser.example.com" }),
      profileName: "openclaw",
      expected: { cdpPort: 443, cdpUrl: "https://remote-browser.example.com" },
    },
    {
      name: "no URL + cdpPort constructs URL from defaults",
      config: withProfile("openclaw", { cdpPort: 9222 }),
      profileName: "openclaw",
      expected: { cdpPort: 9222, cdpUrl: "http://127.0.0.1:9222" },
    },
    {
      name: "stale WS devtools URL + cdpPort drops path and uses cdpPort",
      config: withProfile("chrome-cdp", {
        cdpPort: 9222,
        cdpUrl: "ws://127.0.0.1:12345/devtools/browser/old-stale-id",
        attachOnly: true,
      }),
      profileName: "chrome-cdp",
      expected: {
        cdpUrl: "http://127.0.0.1:9222",
        cdpPort: 9222,
        cdpIsLoopback: true,
        attachOnly: true,
      },
    },
    {
      name: "IPv6 URL without port defers to cdpPort",
      config: withProfile("openclaw", { cdpPort: 18800, cdpUrl: "http://[::1]" }),
      profileName: "openclaw",
      expected: { cdpPort: 18800, cdpUrl: "http://[::1]:18800" },
    },
    {
      name: "IPv6 URL with explicit port wins over cdpPort",
      config: withProfile("openclaw", { cdpPort: 18800, cdpUrl: "http://[::1]:9222" }),
      profileName: "openclaw",
      expected: { cdpPort: 9222, cdpUrl: "http://[::1]:9222" },
    },
    {
      name: "preserves profile host when dropping stale devtools WS path",
      config: withProfile(
        "chrome-local",
        { cdpPort: 9222, cdpUrl: "ws://10.0.0.42:9222/devtools/browser/stale-id" },
        { cdpUrl: "http://devbox.local:9000" },
      ),
      profileName: "chrome-local",
      // The profile WS URL owns the host even when a global cdpUrl is configured.
      expected: {
        cdpUrl: "http://10.0.0.42:9222",
        cdpHost: "10.0.0.42",
        cdpIsLoopback: false,
      },
    },
  ])("$name", ({ config, profileName, expected }) => {
    expect(resolveRequiredProfile(config, profileName)).toMatchObject(expected);
  });

  describe("cdpPort vs cdpUrl port precedence", () => {
    it("URL with explicit default port preserves normalized URL details", () => {
      const resolved = resolveBrowserConfig({
        profiles: {
          secure: {
            cdpPort: 18800,
            cdpUrl: "https://user:pass@remote-browser.example.com:443/json/version?token=abc#frag",
            color: "#0066CC",
            driver: "openclaw",
          },
          websocket: {
            cdpPort: 18800,
            cdpUrl: "wss://remote-browser.example.com:443/json/version?token=abc",
            color: "#0066CC",
            driver: "openclaw",
          },
          ipv6: {
            cdpPort: 18800,
            cdpUrl: "http://[::1]:80/json/version?token=abc",
            color: "#0066CC",
            driver: "openclaw",
          },
        },
      });

      const secure = resolveProfile(resolved, "secure");
      expect(secure?.cdpPort).toBe(443);
      expect(secure?.cdpUrl).toBe(
        "https://user:pass@remote-browser.example.com:443/json/version?token=abc#frag",
      );

      const websocket = resolveProfile(resolved, "websocket");
      expect(websocket?.cdpPort).toBe(443);
      expect(websocket?.cdpUrl).toBe("wss://remote-browser.example.com:443/json/version?token=abc");

      const ipv6 = resolveProfile(resolved, "ipv6");
      expect(ipv6?.cdpPort).toBe(80);
      expect(ipv6?.cdpUrl).toBe("http://[::1]:80/json/version?token=abc");
    });

    it("userinfo colons without a URL port defer to cdpPort", () => {
      const resolved = resolveBrowserConfig({
        profiles: {
          openclaw: {
            cdpPort: 18800,
            cdpUrl: "http://user:pass@127.0.0.1/json/version",
            color: "#FF4500",
            driver: "openclaw",
          },
        },
      });
      const profile = resolveProfile(resolved, "openclaw");
      expect(profile?.cdpPort).toBe(18800);
      expect(profile?.cdpUrl).toBe("http://user:pass@127.0.0.1:18800/json/version");
    });
  });

  it("rejects openclaw profiles without cdpPort or cdpUrl", () => {
    const resolved = resolveBrowserConfig(withProfile("bad", { driver: "openclaw" }));
    expect(() => resolveProfile(resolved, "bad")).toThrow("must define cdpPort or cdpUrl");
  });

  it("rejects unsupported protocols", () => {
    expect(() => resolveBrowserConfig({ cdpUrl: "ftp://127.0.0.1:18791" })).toThrow(
      "must be http(s) or ws(s)",
    );
  });

  it.each([
    {
      name: "defaults extraArgs to empty array when not provided",
      config: undefined,
      expected: [],
    },
    {
      name: "passes through valid extraArgs strings",
      config: { extraArgs: ["--no-sandbox", "--disable-gpu"] },
      expected: ["--no-sandbox", "--disable-gpu"],
    },
    {
      name: "filters out empty strings and whitespace-only entries from extraArgs",
      config: { extraArgs: ["--flag", "", "  ", "--other"] },
      expected: ["--flag", "--other"],
    },
    {
      name: "filters out non-string entries from extraArgs",
      config: {
        extraArgs: ["--flag", 42, null, undefined, true, "--other"] as unknown as string[],
      },
      expected: ["--flag", "--other"],
    },
    {
      name: "defaults extraArgs to empty array when set to non-array",
      config: { extraArgs: "not-an-array" as unknown as string[] },
      expected: [],
    },
  ] as Array<{ name: string; config: BrowserConfig | undefined; expected: string[] }>)(
    "$name",
    ({ config, expected }) => {
      expect(resolveBrowserConfig(config).extraArgs).toStrictEqual(expected);
    },
  );

  it.each([
    {
      name: "resolves browser SSRF policy when configured",
      config: {
        ssrfPolicy: {
          allowPrivateNetwork: true,
          allowRfc2544BenchmarkRange: true,
          allowIpv6UniqueLocalRange: true,
          allowedHostnames: [" localhost ", " *.trusted.example ", ""],
        },
      } as unknown as BrowserConfig,
      expected: {
        dangerouslyAllowPrivateNetwork: true,
        allowRfc2544BenchmarkRange: true,
        allowIpv6UniqueLocalRange: true,
        allowedHostnames: ["localhost", "*.trusted.example"],
      },
    },
    {
      name: "defaults browser SSRF policy to strict mode when unset",
      config: {},
      expected: {},
    },
    {
      name: "supports explicit strict mode by disabling private network access",
      config: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } },
      expected: { dangerouslyAllowPrivateNetwork: false },
    },
    {
      name: "preserves legacy explicit strict mode from allowPrivateNetwork=false",
      config: { ssrfPolicy: { allowPrivateNetwork: false } } as unknown as BrowserConfig,
      expected: { dangerouslyAllowPrivateNetwork: false },
    },
    {
      name: "keeps allowlist-only browser SSRF policy strict by default",
      config: {
        ssrfPolicy: { allowedHostnames: ["example.com", "*.example.com"] },
      } as unknown as BrowserConfig,
      expected: { allowedHostnames: ["example.com", "*.example.com"] },
    },
    {
      name: "keeps configured profile cdpUrls out of the shared browser SSRF policy",
      config: withProfile("remote", {
        color: "#123456",
        cdpUrl: "http://172.29.128.1:9223",
      }),
      expected: {},
    },
  ])("$name", ({ config, expected }) => {
    expect(resolveBrowserConfig(config).ssrfPolicy).toStrictEqual(expected);
  });

  it.each([
    {
      name: "resolves existing-session profiles without cdpPort or cdpUrl",
      config: {
        profiles: { "chrome-live": { driver: "existing-session", attachOnly: true } },
      },
      profileName: "chrome-live",
      exact: true,
      expected: {
        name: "chrome-live",
        driver: "existing-session",
        attachOnly: true,
        cdpPort: 0,
        cdpUrl: "",
        cdpHost: "",
        cdpIsLoopback: true,
        color: "#FF4500",
        executablePath: undefined,
        headless: false,
        headlessSource: "default",
        mcpArgs: undefined,
        mcpCommand: undefined,
        userDataDir: undefined,
      },
    },
    {
      name: "expands tilde-prefixed userDataDir for existing-session profiles",
      config: withProfile("brave", {
        driver: "existing-session",
        attachOnly: true,
        userDataDir: "~/Library/Application Support/BraveSoftware/Brave-Browser",
        color: "#FB542B",
      }),
      profileName: "brave",
      expected: {
        driver: "existing-session",
        userDataDir: resolveUserPath("~/Library/Application Support/BraveSoftware/Brave-Browser"),
      },
    },
    {
      name: "resolves Chrome MCP command, args, and endpoint URL for existing-session profiles",
      config: withProfile("chrome-live", {
        driver: "existing-session",
        attachOnly: true,
        cdpUrl: "http://127.0.0.1:9222/",
        mcpCommand: " /usr/local/bin/chrome-devtools-mcp ",
        mcpArgs: ["--no-usage-statistics", " ", "--performanceCrux", "false"],
        color: "#00AA00",
      }),
      profileName: "chrome-live",
      expected: {
        driver: "existing-session",
        cdpUrl: "http://127.0.0.1:9222",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        mcpCommand: "/usr/local/bin/chrome-devtools-mcp",
        mcpArgs: ["--no-usage-statistics", "--performanceCrux", "false"],
      },
    },
    {
      name: "applies top-level cdpUrl to an existing-session default profile",
      config: { defaultProfile: "user", cdpUrl: "http://127.0.0.1:9222/" },
      profileName: "user",
      expectedDefaultProfile: "user",
      expected: {
        driver: "existing-session",
        cdpUrl: "http://127.0.0.1:9222",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
      },
    },
    {
      name: "keeps explicit existing-session profile cdpUrl over the top-level cdpUrl",
      config: withProfile(
        "chrome-live",
        {
          driver: "existing-session",
          attachOnly: true,
          cdpUrl: "http://127.0.0.1:9333",
          color: "#00AA00",
        },
        { defaultProfile: "chrome-live", cdpUrl: "http://127.0.0.1:9222" },
      ),
      profileName: "chrome-live",
      expected: { driver: "existing-session", cdpUrl: "http://127.0.0.1:9333" },
    },
    {
      name: "preserves direct websocket cdpUrl for existing-session profiles",
      config: withProfile("chrome-live", {
        driver: "existing-session",
        attachOnly: true,
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/ABC?token=test-key",
        color: "#00AA00",
      }),
      profileName: "chrome-live",
      expected: {
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/ABC?token=test-key",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
      },
    },
  ] as Array<{
    name: string;
    config: BrowserConfig;
    profileName: string;
    exact?: boolean;
    expectedDefaultProfile?: string;
    expected: Record<string, unknown>;
  }>)("$name", ({ config, profileName, exact, expectedDefaultProfile, expected }) => {
    const resolved = resolveBrowserConfig(config);
    if (expectedDefaultProfile) {
      expect(resolved.defaultProfile).toBe(expectedDefaultProfile);
    }
    const profile = resolveProfile(resolved, profileName);
    if (exact) {
      expect(profile).toStrictEqual(expected);
    } else {
      expect(profile).toMatchObject(expected);
    }
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

  it("resolves a configured custom default profile", () => {
    const resolved = resolveBrowserConfig({
      defaultProfile: "custom",
      profiles: {
        custom: { cdpPort: 19999 },
      },
    });

    const profile = resolveProfile(resolved, resolved.defaultProfile);
    expect(resolved.defaultProfile).toBe("custom");
    expect(profile?.name).toBe("custom");
    expect(profile?.cdpPort).toBe(19999);
  });
});
