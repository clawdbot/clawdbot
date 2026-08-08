import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";
import { relayKeyIdFromHex } from "../browser/extension-relay/auth-v2-crypto.js";
import { resolveLocalPairingGatewayUrl } from "./browser-cli-extension-pairing.js";
import * as cliCoreApiModule from "./core-api.js";

const relayMocks = vi.hoisted(() => ({ ensureExtensionRelayToken: vi.fn(() => "a".repeat(64)) }));

vi.mock("../browser/extension-relay/relay-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browser/extension-relay/relay-auth.js")>()),
  ensureExtensionRelayToken: relayMocks.ensureExtensionRelayToken,
}));

const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();

describe("browser extension pairing Gateway URL", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetRuntimeCapture();
  });

  it("uses loopback only for a plaintext local Gateway", () => {
    expect(resolveLocalPairingGatewayUrl({ gatewayPort: 18789, tlsEnabled: false })).toBe(
      "ws://127.0.0.1:18789",
    );
  });

  it("requires the certificate hostname for a TLS Gateway", () => {
    expect(() => resolveLocalPairingGatewayUrl({ gatewayPort: 18789, tlsEnabled: true })).toThrow(
      "--gateway-url wss://<certificate-host>",
    );
    expect(
      resolveLocalPairingGatewayUrl({
        configuredRemote: "wss://gateway.example",
        gatewayPort: 18789,
        tlsEnabled: true,
      }),
    ).toBe("wss://gateway.example");
  });

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
      pairingString: expect.stringContaining(`#${"a".repeat(64)}`),
      relayPort: 18799,
      remote: false,
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

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
        keyId: relayKeyIdFromHex("a".repeat(64)),
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
    expect(JSON.stringify(writeJsonSpy.mock.calls[0]?.[0])).not.toContain("a".repeat(64));
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
        headers: { Authorization: `Bearer ${"a".repeat(64)}` },
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
    expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("a".repeat(64));
  });
});
