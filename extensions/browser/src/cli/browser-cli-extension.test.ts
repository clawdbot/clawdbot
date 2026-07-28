import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";
import { resolveLocalPairingGatewayUrl } from "./browser-cli-extension-pairing.js";
import * as cliCoreApiModule from "./core-api.js";

const relayMocks = vi.hoisted(() => ({ ensureExtensionRelayToken: vi.fn(() => "pair-token") }));

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
      pairingString: expect.stringContaining("#pair-token"),
      relayPort: 18799,
      remote: false,
    });
    expect(logSpy).not.toHaveBeenCalled();
  });
});
