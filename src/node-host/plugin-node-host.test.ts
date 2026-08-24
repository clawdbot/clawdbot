/** Tests plugin node-host command registry loading, listing, and invocation. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  invokeRegisteredNodeHostCommand,
  listRegisteredNodeHostCapsAndCommands,
  notifyRegisteredNodeHostCommandDisconnect,
  watchRegisteredNodeHostCommandAvailability,
} from "./plugin-node-host.js";

const availabilityContext = { config: {}, env: {} };

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("plugin node-host registry", () => {
  it("lists plugin-declared caps and commands", () => {
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "browser",
        pluginName: "Browser",
        command: {
          command: "browser.proxy",
          cap: "browser",
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
      {
        pluginId: "photos",
        pluginName: "Photos",
        command: {
          command: "photos.proxy",
          cap: "photos",
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
      {
        pluginId: "browser-dup",
        pluginName: "Browser Dup",
        command: {
          command: "browser.inspect",
          cap: "browser",
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(listRegisteredNodeHostCapsAndCommands(availabilityContext)).toEqual({
      caps: ["browser", "photos"],
      commands: ["browser.inspect", "browser.proxy", "photos.proxy"],
      nodePluginTools: [],
    });
  });

  it("lists plugin-declared agent tool descriptors", () => {
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "browser",
        pluginName: "Browser",
        command: {
          command: "browser.proxy",
          cap: "browser",
          agentTool: {
            name: "browser_inspect",
            description: "Inspect browser state",
            parameters: {
              type: "object",
              properties: { url: { type: "string" } },
            },
          },
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(listRegisteredNodeHostCapsAndCommands(availabilityContext).nodePluginTools).toEqual([
      {
        pluginId: "browser",
        name: "browser_inspect",
        description: "Inspect browser state",
        parameters: {
          type: "object",
          properties: { url: { type: "string" } },
        },
        command: "browser.proxy",
      },
    ]);
  });

  it("publishes a validated Computer Use descriptor beside its command pair", () => {
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "computer",
        pluginName: "Computer",
        command: {
          command: "computer.act",
          cap: "computer",
          computerUse: () => ({
            contractVersion: 2,
            provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
            actions: ["screenshot", "left_click"],
            targets: ["screen"],
            deliveryModes: ["foreground"],
            observations: ["image"],
            features: { recording: false, agentCursor: false, multiDisplay: false },
          }),
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(listRegisteredNodeHostCapsAndCommands(availabilityContext)).toMatchObject({
      caps: ["computer"],
      commands: ["computer.act"],
      computerUse: {
        contractVersion: 2,
        provider: { id: "fixture", generation: "generation-1" },
        actions: ["screenshot", "left_click"],
      },
    });
  });

  it("skips agent tool descriptors with provider-unsafe names", () => {
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "browser",
        pluginName: "Browser",
        command: {
          command: "browser.proxy",
          cap: "browser",
          agentTool: {
            name: "browser.inspect",
            description: "Inspect browser state",
          },
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(listRegisteredNodeHostCapsAndCommands(availabilityContext)).toEqual({
      caps: ["browser"],
      commands: ["browser.proxy"],
      nodePluginTools: [],
    });
  });

  it("omits commands and capabilities unavailable in the node-local config", () => {
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "browser",
        pluginName: "Browser",
        command: {
          command: "browser.proxy",
          cap: "browser",
          isAvailable: ({ config }) => config.browser?.enabled !== false,
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
      {
        pluginId: "photos",
        pluginName: "Photos",
        command: {
          command: "photos.proxy",
          cap: "photos",
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(
      listRegisteredNodeHostCapsAndCommands({
        config: { browser: { enabled: false } },
        env: {},
      }),
    ).toEqual({
      caps: ["photos"],
      commands: ["photos.proxy"],
      nodePluginTools: [],
    });
  });

  it("owns plugin availability watcher cleanup", () => {
    let notify: (() => void) | undefined;
    const cleanup = vi.fn();
    const onChange = vi.fn();
    const scopedRegistry = vi.fn();
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "browser",
        pluginName: "Browser",
        command: {
          command: "browser.proxy",
          cap: "browser",
          watchAvailability: (_context, callback) => {
            notify = callback;
            scopedRegistry(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
            return () => {
              scopedRegistry(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
              cleanup();
            };
          },
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    const stop = watchRegisteredNodeHostCommandAvailability(availabilityContext, () => {
      scopedRegistry(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
      onChange();
    });
    notify?.();
    expect(onChange).toHaveBeenCalledOnce();
    stop();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(scopedRegistry).toHaveBeenCalledTimes(3);
    expect(scopedRegistry).toHaveBeenNthCalledWith(1, registry);
    expect(scopedRegistry).toHaveBeenNthCalledWith(2, registry);
    expect(scopedRegistry).toHaveBeenNthCalledWith(3, registry);
  });

  it("notifies each shared plugin disconnect owner once", async () => {
    const onDisconnect = vi.fn(async () => {});
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = ["screen.snapshot", "computer.act"].map((command) => ({
      pluginId: "computer",
      pluginName: "Computer",
      command: { command, onDisconnect, handle: vi.fn(async () => "{}") },
      source: "test",
    }));
    setActivePluginRegistry(registry);

    await notifyRegisteredNodeHostCommandDisconnect();

    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("dispatches plugin-declared node-host commands", async () => {
    const handle = vi.fn(async (paramsJSON?: string | null) => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
      return paramsJSON ?? "";
    });
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "browser",
        pluginName: "Browser",
        command: {
          command: "browser.proxy",
          cap: "browser",
          handle,
        },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    const context = {
      sendNodeEvent: vi.fn(async () => undefined),
      sessionKey: "agent:main:canvas",
    };
    await expect(
      invokeRegisteredNodeHostCommand("browser.proxy", '{"ok":true}', undefined, context),
    ).resolves.toBe('{"ok":true}');
    await expect(invokeRegisteredNodeHostCommand("missing.command", null)).resolves.toBeNull();
    expect(handle).toHaveBeenCalledWith('{"ok":true}', undefined, context);
  });

  it("gates duplex commands from embedded-worker manifests and supplies their IO context", async () => {
    const handle = vi.fn(async (paramsJSON?: string | null) => paramsJSON ?? "");
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "terminal",
        pluginName: "Terminal",
        command: {
          command: "terminal.resume.v1",
          cap: "terminal",
          duplex: true,
          handle,
        },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(
      listRegisteredNodeHostCapsAndCommands(availabilityContext, { includeDuplex: false }),
    ).toEqual({ caps: [], commands: [], nodePluginTools: [] });
    const io = {
      signal: new AbortController().signal,
      emitChunk: async () => {},
      onInput: () => {},
    };
    await expect(
      invokeRegisteredNodeHostCommand("terminal.resume.v1", '{"threadId":"id"}', io),
    ).resolves.toBe('{"threadId":"id"}');
    expect(handle).toHaveBeenCalledWith('{"threadId":"id"}', io);
    await expect(invokeRegisteredNodeHostCommand("terminal.resume.v1", null)).rejects.toThrow(
      "requires duplex transport",
    );
  });
});
