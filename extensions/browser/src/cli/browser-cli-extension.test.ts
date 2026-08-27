import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";
import type { installChromeExtensionBootstrap } from "../browser/extension-install.js";
import { relayKeyIdFromHex } from "../browser/extension-relay/auth-v2-crypto.js";
import * as cliCoreApiModule from "./core-api.js";

const relayMocks = vi.hoisted(() => {
  let relayKey = "";
  for (let byteIndex = 0; byteIndex < 32; byteIndex += 1) {
    relayKey += ((1 + byteIndex * 17) & 0xff).toString(16).padStart(2, "0");
  }
  return { relayKey, ensureExtensionRelayToken: vi.fn(() => relayKey) };
});
const installMocks = vi.hoisted(() => ({
  browserExtensionStatus: vi.fn(),
  installChromeExtensionBootstrap: vi.fn(),
  uninstallChromeExtensionNativeHosts: vi.fn(),
}));

vi.mock("../browser/extension-relay/relay-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browser/extension-relay/relay-auth.js")>()),
  ensureExtensionRelayToken: relayMocks.ensureExtensionRelayToken,
}));

vi.mock("../browser/extension-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browser/extension-install.js")>()),
  browserExtensionStatus: installMocks.browserExtensionStatus,
  installChromeExtensionBootstrap: installMocks.installChromeExtensionBootstrap,
  uninstallChromeExtensionNativeHosts: installMocks.uninstallChromeExtensionNativeHosts,
}));

const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();

function createExtensionStatus() {
  return {
    platform: "linux" as const,
    platformSupport: "automatic" as const,
    installedCopy: { path: "/stable/openclaw-extension", present: true, owned: true },
    bundledPath: "/bundled/openclaw-extension",
    approvedPaths: ["/stable/openclaw-extension"],
    discovered: [],
    storeDiscovered: [],
    registrations: [],
    manualSetupRequired: false,
    issues: [],
  };
}

describe("browser extension pairing Gateway URL", () => {
  beforeEach(() => {
    installMocks.browserExtensionStatus.mockResolvedValue(createExtensionStatus());
    installMocks.installChromeExtensionBootstrap.mockResolvedValue(createExtensionStatus());
    installMocks.uninstallChromeExtensionNativeHosts.mockResolvedValue({
      removed: [],
      refused: [],
      manualRequired: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    installMocks.browserExtensionStatus.mockReset();
    installMocks.installChromeExtensionBootstrap.mockReset();
    installMocks.uninstallChromeExtensionNativeHosts.mockReset();
    resetRuntimeCapture();
  });

  it("prints the Store CTA only after native pre-registration is ready", async () => {
    installMocks.installChromeExtensionBootstrap.mockImplementation(
      async (params: Parameters<typeof installChromeExtensionBootstrap>[0]) => {
        params.onProgress?.("Pre-registered the native host for Chromium.");
        params.onProgress?.(
          "Native bootstrap is ready. Add OpenClaw from the Chrome Web Store. For development, load unpacked from /stable/openclaw-extension.",
        );
        return {
          platform: "linux",
          platformSupport: "automatic",
          installedCopy: { path: "/stable/openclaw-extension", present: true, owned: true },
          bundledPath: "/bundled/openclaw-extension",
          approvedPaths: ["/stable/openclaw-extension"],
          discovered: [
            {
              product: "chromium",
              browser: "Chromium",
              userDataDir: "/chrome",
              profile: "Default",
              securePreferencesPath: "/chrome/Default/Secure Preferences",
              extensionId: "abcdefghijklmnopabcdefghijklmnop",
              extensionPath: "/stable/openclaw-extension",
            },
          ],
          storeDiscovered: [],
          registrations: [],
          manualSetupRequired: false,
          issues: [],
        };
      },
    );
    const logSpy = vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(runtime.log);
    const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");
    const program = new Command();
    registerBrowserExtensionCommands(program.command("browser"), () => ({}));

    await program.parseAsync(["browser", "extension", "install", "--wait-ms", "1000"], {
      from: "user",
    });

    const output = logSpy.mock.calls.map(([message]) => String(message));
    expect(output[0]).toContain("Preparing");
    expect(output.findIndex((message) => message.includes("Pre-registered"))).toBeLessThan(
      output.findIndex((message) => message.includes("Chrome Web Store")),
    );
    expect(output.at(-1)).toContain("extension identity verified");
  });

  it.each(["0x1000", "1e4", "+50000", " 50000", "50000 ", "50000\t"])(
    "rejects invalid install --wait-ms value %j before installation",
    async (value) => {
      const errorSpy = vi
        .spyOn(cliCoreApiModule.defaultRuntime, "error")
        .mockImplementation(runtime.error);
      vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(runtime.exit);
      const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");
      const program = new Command();
      registerBrowserExtensionCommands(program.command("browser"), () => ({}));

      await expect(
        program.parseAsync(["browser", "extension", "install", "--wait-ms", value], {
          from: "user",
        }),
      ).rejects.toThrow("__exit__:1");

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--wait-ms"));
      expect(installMocks.installChromeExtensionBootstrap).not.toHaveBeenCalled();
    },
  );

  it("rejects path-rewriting proxy prefixes for strict v2 resource binding", async () => {
    vi.spyOn(cliCoreApiModule, "getRuntimeConfig").mockReturnValue({});
    const errorSpy = vi
      .spyOn(cliCoreApiModule.defaultRuntime, "error")
      .mockImplementation(runtime.error);
    vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(runtime.exit);
    const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");
    const program = new Command();
    registerBrowserExtensionCommands(program.command("browser"), () => ({}));

    await expect(
      program.parseAsync(
        ["browser", "extension", "pair", "--gateway-url", "wss://gateway.example/proxy-prefix"],
        { from: "user" },
      ),
    ).rejects.toThrow("__exit__:1");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("must not include a path prefix"),
    );
  });

  it("writes explicit JSON output through the raw machine-output sink", async () => {
    vi.spyOn(cliCoreApiModule, "getRuntimeConfig").mockReturnValue({});
    const logSpy = vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(runtime.log);
    const writeJsonSpy = vi
      .spyOn(cliCoreApiModule.defaultRuntime, "writeJson")
      .mockImplementation(runtime.writeJson);
    const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");
    const program = new Command();
    const browser = program.command("browser");
    registerBrowserExtensionCommands(browser, () => ({}));

    await program.parseAsync(["browser", "extension", "pair", "--json"], { from: "user" });

    expect(writeJsonSpy).toHaveBeenCalledWith({
      pairingString: expect.stringContaining(`#${relayMocks.relayKey}`),
      relayPort: 18799,
      remote: false,
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it.each(["install", "status", "uninstall-host", "pair", "cdp"])(
    "honors browser-level and leaf JSON placement for extension %s",
    async (subcommand) => {
      vi.spyOn(cliCoreApiModule, "getRuntimeConfig").mockReturnValue({});
      const logSpy = vi
        .spyOn(cliCoreApiModule.defaultRuntime, "log")
        .mockImplementation(runtime.log);
      const writeJsonSpy = vi
        .spyOn(cliCoreApiModule.defaultRuntime, "writeJson")
        .mockImplementation(runtime.writeJson);
      const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");
      const placements = [
        ["browser", "--json", "extension", subcommand],
        ["browser", "extension", subcommand, "--json"],
      ];

      for (const argv of placements) {
        const program = new Command().enablePositionalOptions();
        const browser = program.command("browser").option("--json", "Output JSON", false);
        registerBrowserExtensionCommands(browser, (command) => {
          let owner: Command | null = command;
          while (owner && owner.name() !== "browser") {
            owner = owner.parent;
          }
          return owner?.opts() ?? {};
        });
        writeJsonSpy.mockClear();
        logSpy.mockClear();

        await program.parseAsync(argv, { from: "user" });

        expect(writeJsonSpy, argv.join(" ")).toHaveBeenCalledTimes(1);
        expect(logSpy, argv.join(" ")).not.toHaveBeenCalled();
      }
    },
  );

  it("pairs with the allocated extension relay when another profile pins the default port", async () => {
    vi.spyOn(cliCoreApiModule, "getRuntimeConfig").mockReturnValue({
      browser: {
        profiles: {
          pinned: { cdpPort: 18799, color: "#00AA00" },
        },
      },
    });
    const writeJsonSpy = vi
      .spyOn(cliCoreApiModule.defaultRuntime, "writeJson")
      .mockImplementation(runtime.writeJson);
    const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");
    const program = new Command();
    const browser = program.command("browser");
    registerBrowserExtensionCommands(browser, () => ({}));

    await program.parseAsync(["browser", "extension", "pair", "--json"], { from: "user" });

    expect(writeJsonSpy).toHaveBeenCalledWith({
      pairingString: expect.stringContaining("127.0.0.1:18798/extension"),
      relayPort: 18798,
      remote: false,
    });
  });

  it("prints only safe v2 relay metadata via cdp --json", async () => {
    vi.spyOn(cliCoreApiModule, "getRuntimeConfig").mockReturnValue({});
    const logSpy = vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(runtime.log);
    const writeJsonSpy = vi
      .spyOn(cliCoreApiModule.defaultRuntime, "writeJson")
      .mockImplementation(runtime.writeJson);
    const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");
    const program = new Command();
    const browser = program.command("browser");
    registerBrowserExtensionCommands(browser, () => ({}));

    await program.parseAsync(["browser", "extension", "cdp", "--json"], { from: "user" });

    expect(writeJsonSpy).toHaveBeenCalledWith({
      browserUrl: "http://127.0.0.1:18799",
      wsEndpoint: "ws://127.0.0.1:18799/cdp",
      auth: {
        label: "openclaw.browser-relay.auth",
        version: 2,
        keyId: relayKeyIdFromHex(relayMocks.relayKey),
        challengeUrl: "http://127.0.0.1:18799/_openclaw/relay/auth/v2/challenge",
        completeUrl: "http://127.0.0.1:18799/_openclaw/relay/auth/v2/complete",
        role: "cdp",
        transport: "connection",
        method: "SEQUENCE",
        resource: "/json/version -> /cdp",
        flow: "cdp",
      },
    });
    expect(JSON.stringify(writeJsonSpy.mock.calls[0]?.[0])).not.toContain("Bearer");
    expect(JSON.stringify(writeJsonSpy.mock.calls[0]?.[0])).not.toContain(relayMocks.relayKey);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("prints an explicit warned legacy bearer only while legacy auth is enabled", async () => {
    vi.spyOn(cliCoreApiModule, "getRuntimeConfig").mockReturnValue({});
    const errorSpy = vi
      .spyOn(cliCoreApiModule.defaultRuntime, "error")
      .mockImplementation(runtime.error);
    const writeJsonSpy = vi
      .spyOn(cliCoreApiModule.defaultRuntime, "writeJson")
      .mockImplementation(runtime.writeJson);
    const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");
    const program = new Command();
    const browser = program.command("browser");
    registerBrowserExtensionCommands(browser, () => ({}));

    await program.parseAsync(["browser", "extension", "cdp", "--legacy-bearer", "--json"], {
      from: "user",
    });

    expect(writeJsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { Authorization: `Bearer ${relayMocks.relayKey}` },
      }),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("reveals the relay key"));
  });

  it("refuses --legacy-bearer when legacy auth is disabled", async () => {
    vi.spyOn(cliCoreApiModule, "getRuntimeConfig").mockReturnValue({
      browser: { extensionRelay: { allowLegacyAuth: false } },
    });
    const errorSpy = vi
      .spyOn(cliCoreApiModule.defaultRuntime, "error")
      .mockImplementation(runtime.error);
    vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(runtime.exit);
    const writeJsonSpy = vi
      .spyOn(cliCoreApiModule.defaultRuntime, "writeJson")
      .mockImplementation(runtime.writeJson);
    const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");
    const program = new Command();
    const browser = program.command("browser");
    registerBrowserExtensionCommands(browser, () => ({}));

    await expect(
      program.parseAsync(["browser", "extension", "cdp", "--legacy-bearer", "--json"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    expect(writeJsonSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Legacy browser relay auth is disabled"),
    );
    expect(errorSpy.mock.calls.flat().join("\n")).not.toContain(relayMocks.relayKey);
  });
});
