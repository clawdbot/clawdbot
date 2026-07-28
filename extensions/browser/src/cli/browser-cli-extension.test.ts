import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRemoteGatewayRelayUrl,
  registerBrowserExtensionCommands,
} from "./browser-cli-extension.js";
import { defaultRuntime } from "./core-api.js";

afterEach(() => vi.restoreAllMocks());

describe("buildRemoteGatewayRelayUrl", () => {
  it("builds the direct relay route and preserves a proxy base path", () => {
    expect(buildRemoteGatewayRelayUrl("wss://gateway.example.com")).toBe(
      "wss://gateway.example.com/browser/extension",
    );
    expect(buildRemoteGatewayRelayUrl("wss://gateway.example.com/openclaw/")).toBe(
      "wss://gateway.example.com/openclaw/browser/extension",
    );
  });

  it("allows plaintext WebSockets only on loopback", () => {
    expect(buildRemoteGatewayRelayUrl("ws://127.0.0.1:18789")).toBe(
      "ws://127.0.0.1:18789/browser/extension",
    );
    expect(() => buildRemoteGatewayRelayUrl("ws://gateway.example.com")).toThrow("must use wss://");
  });

  it("rejects non-WebSocket and ambiguous credential-bearing URLs", () => {
    expect(() => buildRemoteGatewayRelayUrl("https://gateway.example.com")).toThrow(
      "must use wss://",
    );
    expect(() => buildRemoteGatewayRelayUrl("wss://user@gateway.example.com")).toThrow(
      "must not include credentials",
    );
    expect(() => buildRemoteGatewayRelayUrl("wss://gateway.example.com?token=secret")).toThrow(
      "must not include credentials",
    );
  });
});

describe("browser extension path", () => {
  it("resolves the copied extension from the registered plugin root", async () => {
    const program = new Command();
    const browser = program.command("browser");
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const pluginRoot = path.join("/opt", "openclaw", "dist", "extensions", "browser");
    registerBrowserExtensionCommands(browser, () => ({}), pluginRoot);

    await program.parseAsync(["browser", "extension", "path"], { from: "user" });

    expect(log).toHaveBeenCalledWith(path.join(pluginRoot, "chrome-extension"));
  });
});
