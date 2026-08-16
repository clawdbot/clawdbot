/**
 * Node command policy regression tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { NODE_WORKER_PRIVATE_COMMANDS } from "../infra/node-commands.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import {
  isForegroundRestrictedPluginNodeCommand,
  isNodeCommandAllowed,
  normalizeDeclaredNodeCommands,
  resolveNodeCommandAllowlist,
  resolveNodePairingCommandAllowlist,
  retainFulfilledNodeCapabilities,
} from "./node-command-policy.js";
import {
  filterLegacyNodeProtocolFeatures,
  normalizeNodeHostCompatibilityMetadata,
} from "./node-legacy-protocol-filter.js";

describe("gateway/node-command-policy", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  function installCanvasPluginDefaults() {
    const registry = createEmptyPluginRegistry();
    registry.nodeInvokePolicies.push({
      pluginId: "canvas",
      pluginName: "Canvas",
      source: "/extensions/canvas/index.ts",
      rootDir: "/extensions/canvas",
      pluginConfig: {},
      policy: {
        commands: ["canvas.snapshot", "canvas.present"],
        defaultPlatforms: ["ios", "android", "macos", "windows", "unknown"],
        foregroundRestrictedOnIos: true,
        handle: (ctx) => ctx.invokeNode(),
      },
    });
    setActivePluginRegistry(registry);
    return registry;
  }

  it("keeps desktop streaming dangerous, advertised, explicitly allowed, and deny-wins", () => {
    const node = {
      platform: "linux",
      deviceFamily: "Linux",
      commands: [NODE_DESKTOP_STREAM_COMMAND],
      approvedCommands: [NODE_DESKTOP_STREAM_COMMAND],
    };
    expect(
      resolveNodeCommandAllowlist({} as OpenClawConfig, node).has(NODE_DESKTOP_STREAM_COMMAND),
    ).toBe(false);
    expect(
      resolveNodePairingCommandAllowlist({} as OpenClawConfig, {
        platform: node.platform,
        deviceFamily: node.deviceFamily,
        commands: node.commands,
      }).has(NODE_DESKTOP_STREAM_COMMAND),
    ).toBe(false);

    const allowedConfig = {
      gateway: { nodes: { commands: { allow: [NODE_DESKTOP_STREAM_COMMAND] } } },
    } as OpenClawConfig;
    const allowed = resolveNodeCommandAllowlist(allowedConfig, node);
    expect(
      isNodeCommandAllowed({
        command: NODE_DESKTOP_STREAM_COMMAND,
        declaredCommands: node.commands,
        allowlist: allowed,
      }),
    ).toEqual({ ok: true });
    expect(
      isNodeCommandAllowed({
        command: NODE_DESKTOP_STREAM_COMMAND,
        declaredCommands: [],
        allowlist: allowed,
      }),
    ).toEqual({ ok: false, reason: "node did not declare commands" });

    const denied = resolveNodeCommandAllowlist(
      {
        gateway: {
          nodes: {
            commands: {
              allow: [NODE_DESKTOP_STREAM_COMMAND],
              deny: [NODE_DESKTOP_STREAM_COMMAND],
            },
          },
        },
      } as OpenClawConfig,
      node,
    );
    expect(denied.has(NODE_DESKTOP_STREAM_COMMAND)).toBe(false);
  });

  it("normalizes declared node commands against the allowlist", () => {
    const allowlist = new Set(["canvas.snapshot", "system.run"]);
    expect(
      normalizeDeclaredNodeCommands({
        declaredCommands: [" canvas.snapshot ", "", "system.run", "system.run", "screen.record"],
        allowlist,
      }),
    ).toEqual(["canvas.snapshot", "system.run"]);
  });

  it("keeps private worker supervisor commands outside public policy", () => {
    const cfg = {
      gateway: { nodes: { commands: { allow: [...NODE_WORKER_PRIVATE_COMMANDS] } } },
    } as OpenClawConfig;
    const node = {
      platform: "linux",
      deviceFamily: "Linux",
      commands: [...NODE_WORKER_PRIVATE_COMMANDS],
      approvedCommands: [...NODE_WORKER_PRIVATE_COMMANDS],
    };

    expect([...resolveNodeCommandAllowlist(cfg, node)]).not.toEqual(
      expect.arrayContaining([...NODE_WORKER_PRIVATE_COMMANDS]),
    );
    expect([...resolveNodePairingCommandAllowlist(cfg, node)]).not.toEqual(
      expect.arrayContaining([...NODE_WORKER_PRIVATE_COMMANDS]),
    );
  });

  it("allows declared push-to-talk commands on trusted talk-capable nodes", () => {
    const cfg = {} as OpenClawConfig;
    for (const platform of ["ios", "android", "macos", "other"]) {
      const allowlist = resolveNodeCommandAllowlist(cfg, { platform, caps: ["talk"] });
      expect(allowlist.has("talk.ptt.start")).toBe(true);
      expect(allowlist.has("talk.ptt.stop")).toBe(true);
      expect(allowlist.has("talk.ptt.cancel")).toBe(true);
      expect(allowlist.has("talk.ptt.once")).toBe(true);
      expect(
        isNodeCommandAllowed({
          command: "talk.ptt.start",
          declaredCommands: ["talk.ptt.start"],
          allowlist,
        }),
      ).toEqual({ ok: true });
    }
  });

  it("does not allow push-to-talk commands from platform label alone", () => {
    const cfg = {} as OpenClawConfig;
    const allowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "android",
      caps: ["device"],
      commands: [],
    });

    expect(allowlist.has("talk.ptt.start")).toBe(false);
  });

  it("allows push-to-talk commands when the node declares talk command support", () => {
    const cfg = {} as OpenClawConfig;
    const allowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "custom",
      commands: ["talk.ptt.start"],
    });

    expect(allowlist.has("talk.ptt.start")).toBe(true);
  });

  it("keeps canvas commands out of core defaults when the canvas plugin is not active", () => {
    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      platform: "windows",
      deviceFamily: "Windows",
    });

    expect(allowlist.has("canvas.snapshot")).toBe(false);
  });

  it("keeps safe PTZ status Mac-only and requires an explicit allow for control", () => {
    const macNode = {
      platform: "macos",
      deviceFamily: "Mac",
      commands: ["camera.ptz.status", "camera.ptz.control"],
    };
    const defaultAllowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, macNode);
    expect(defaultAllowlist.has("camera.ptz.status")).toBe(true);
    expect(defaultAllowlist.has("camera.ptz.control")).toBe(false);

    for (const platform of ["ios", "android", "windows", "linux", "unknown"]) {
      const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, { platform });
      expect(allowlist.has("camera.ptz.status")).toBe(false);
      expect(allowlist.has("camera.ptz.control")).toBe(false);
    }

    const explicitAllow = resolveNodeCommandAllowlist(
      {
        gateway: { nodes: { commands: { allow: ["camera.ptz.control"] } } },
      } as OpenClawConfig,
      macNode,
    );
    expect(explicitAllow.has("camera.ptz.control")).toBe(true);

    const denied = resolveNodeCommandAllowlist(
      {
        gateway: {
          nodes: {
            commands: {
              allow: ["camera.ptz.control"],
              deny: ["camera.ptz.control"],
            },
          },
        },
      } as OpenClawConfig,
      macNode,
    );
    expect(denied.has("camera.ptz.control")).toBe(false);
  });

  it("adds canvas commands from the active canvas plugin node policy", () => {
    installCanvasPluginDefaults();

    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      platform: "windows",
      deviceFamily: "Windows",
    });

    expect(allowlist.has("canvas.snapshot")).toBe(true);
    expect(allowlist.has("canvas.present")).toBe(true);
  });

  it("suppresses plugin-owned features for legacy protocol nodes", () => {
    installCanvasPluginDefaults();

    expect(
      filterLegacyNodeProtocolFeatures({
        caps: ["canvas", "device"],
        commands: ["canvas.snapshot", "device.info"],
        pluginSurfaces: ["canvas"],
      }),
    ).toEqual({
      caps: ["device"],
      commands: ["device.info"],
    });
  });

  it("preserves native command ids when a plugin provides another host implementation", () => {
    const registry = createEmptyPluginRegistry();
    for (const command of [
      "system.notify",
      "camera.list",
      "camera.snap",
      "camera.clip",
      "camera.ptz.status",
      "camera.ptz.control",
      "location.get",
      "remote.echo",
    ]) {
      registry.nodeHostCommands.push({
        pluginId: command === "remote.echo" ? "remote" : "linux-node",
        pluginName: command === "remote.echo" ? "Remote" : "Linux Node",
        command: { command, handle: async () => "{}" },
        source: "test",
      });
    }
    setActivePluginRegistry(registry);

    expect(
      filterLegacyNodeProtocolFeatures({
        caps: ["camera", "location", "device"],
        commands: [
          "system.notify",
          "camera.list",
          "camera.snap",
          "camera.clip",
          "camera.ptz.status",
          "camera.ptz.control",
          "location.get",
          "remote.echo",
          "device.info",
        ],
        pluginSurfaces: [],
      }),
    ).toEqual({
      caps: ["camera", "location", "device"],
      commands: [
        "system.notify",
        "camera.list",
        "camera.snap",
        "camera.clip",
        "camera.ptz.status",
        "camera.ptz.control",
        "location.get",
        "device.info",
      ],
    });
  });

  it.each([
    ["darwin", "macos", "Mac"],
    ["linux", "linux", "Linux"],
    ["macos", "macos", "Mac"],
    ["win32", "windows", "Windows"],
    ["windows", "windows", "Windows"],
  ])("normalizes shipped protocol-v3 node-host metadata for %s", (platform, expected, family) => {
    const normalized = normalizeNodeHostCompatibilityMetadata({
      id: GATEWAY_CLIENT_IDS.NODE_HOST,
      version: "2026.5.7",
      platform,
      mode: GATEWAY_CLIENT_MODES.NODE,
    });
    expect(normalized).toMatchObject({ platform: expected, deviceFamily: family });
    expect(
      resolveNodeCommandAllowlist({} as OpenClawConfig, {
        ...normalized,
        approvedCommands: ["system.run"],
      }).has("system.run"),
    ).toBe(true);
  });

  it.each([
    ["darwin", "", "macos", "Mac"],
    ["win32", "   ", "windows", "Windows"],
  ])(
    "normalizes blank protocol-v3 node-host device family for %s",
    (platform, deviceFamily, expectedPlatform, expectedFamily) => {
      expect(
        normalizeNodeHostCompatibilityMetadata({
          id: GATEWAY_CLIENT_IDS.NODE_HOST,
          version: "2026.5.7",
          platform,
          deviceFamily,
          mode: GATEWAY_CLIENT_MODES.NODE,
        }),
      ).toMatchObject({
        platform: expectedPlatform,
        deviceFamily: expectedFamily,
      });
    },
  );

  it("does not normalize non-node-host or conflicting legacy metadata", () => {
    const conflicting = {
      id: GATEWAY_CLIENT_IDS.NODE_HOST,
      version: "2026.5.7",
      platform: "linux",
      deviceFamily: "iPhone",
      mode: GATEWAY_CLIENT_MODES.NODE,
    } as const;
    expect(normalizeNodeHostCompatibilityMetadata(conflicting)).toBe(conflicting);

    const otherClient = {
      ...conflicting,
      id: GATEWAY_CLIENT_IDS.LINUX_APP,
      deviceFamily: undefined,
    };
    expect(normalizeNodeHostCompatibilityMetadata(otherClient)).toBe(otherClient);
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "does not normalize inherited platform key %s",
    (platform) => {
      const client = {
        id: GATEWAY_CLIENT_IDS.NODE_HOST,
        version: "2026.5.7",
        platform,
        deviceFamily: "Mac",
        mode: GATEWAY_CLIENT_MODES.NODE,
      } as const;

      expect(normalizeNodeHostCompatibilityMetadata(client)).toBe(client);
    },
  );

  it("adds explicitly defaulted plugin node-host agent tools from the active registry", () => {
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands.push(
      {
        pluginId: "remote",
        pluginName: "Remote",
        source: "/extensions/remote/index.ts",
        rootDir: "/extensions/remote",
        command: {
          command: "remote.echo",
          agentTool: {
            name: "remote_echo",
            description: "Echo from a node host",
            defaultPlatforms: ["linux"],
          },
          handle: async () => "{}",
        },
      },
      {
        pluginId: "remote",
        pluginName: "Remote",
        source: "/extensions/remote/index.ts",
        rootDir: "/extensions/remote",
        command: {
          command: "remote.manual",
          agentTool: {
            name: "remote_manual",
            description: "Manual allowlist node-host tool",
          },
          handle: async () => "{}",
        },
      },
      {
        pluginId: "remote",
        pluginName: "Remote",
        source: "/extensions/remote/index.ts",
        rootDir: "/extensions/remote",
        command: {
          command: "remote.dangerous",
          dangerous: true,
          agentTool: {
            name: "remote_dangerous",
            description: "Dangerous node-host tool",
            defaultPlatforms: ["linux"],
          },
          handle: async () => "{}",
        },
      },
    );
    setActivePluginRegistry(registry);

    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      platform: "linux",
      deviceFamily: "Linux",
    });

    expect(allowlist.has("remote.echo")).toBe(true);
    expect(allowlist.has("remote.manual")).toBe(false);
    expect(allowlist.has("remote.dangerous")).toBe(false);
    expect(
      normalizeDeclaredNodeCommands({
        declaredCommands: ["remote.echo", "remote.dangerous"],
        allowlist,
      }),
    ).toEqual(["remote.echo"]);
  });

  it("does not allow connected node plugin tools without a registry default or config allowlist", () => {
    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      platform: "macos",
      deviceFamily: "Mac",
      commands: ["remote.echo"],
    });

    expect(allowlist.has("remote.echo")).toBe(false);
    expect(
      isNodeCommandAllowed({
        command: "remote.echo",
        declaredCommands: ["remote.echo"],
        allowlist,
      }),
    ).toEqual({ ok: false, reason: "command not allowlisted" });
  });

  it("does not grant host command defaults for platform prefix aliases", () => {
    const cfg = {} as OpenClawConfig;
    const cases = [
      { platform: "darwin", deviceFamily: "iPhone" },
      { platform: "darwin", deviceFamily: "Mac" },
      { platform: "macos" },
      { platform: "macos", deviceFamily: "Mac" },
      { platform: "macos", deviceFamily: "iPhone" },
      { platform: "macOS 26.3.1", deviceFamily: "iPhone" },
      { platform: "macOS 26.3.1", deviceFamily: "Mac" },
      { platform: "windows" },
      { platform: "windows", deviceFamily: "Windows" },
      { platform: "windows", deviceFamily: "iPhone" },
      { platform: "linux" },
      { platform: "linux", deviceFamily: "Linux" },
      { platform: "linux", deviceFamily: "iPhone" },
      { platform: "Darwin-x64" },
      { platform: "macintosh" },
      { platform: "win32" },
      { platform: "linux-gnu" },
      {
        platform: "macos",
        deviceFamily: "Mac",
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
      },
    ];

    for (const node of cases) {
      const allowlist = resolveNodeCommandAllowlist(cfg, node);
      expect(allowlist.has("system.run")).toBe(false);
      expect(allowlist.has("system.run.prepare")).toBe(false);
      expect(allowlist.has("system.which")).toBe(false);
      expect(allowlist.has("system.execApprovals.get")).toBe(false);
      expect(allowlist.has("system.execApprovals.set")).toBe(false);
      expect(allowlist.has("browser.proxy")).toBe(false);
      expect(allowlist.has("screen.snapshot")).toBe(false);
      expect(allowlist.has("system.notify")).toBe(true);
    }
  });

  it("allows exec approval commands only through desktop node pairing approval", () => {
    const cfg = {} as OpenClawConfig;
    const desktopNode = { platform: "windows", deviceFamily: "Windows" };

    const pairingAllowlist = resolveNodePairingCommandAllowlist(cfg, desktopNode);
    expect(pairingAllowlist.has("system.execApprovals.get")).toBe(true);
    expect(pairingAllowlist.has("system.execApprovals.set")).toBe(true);

    const unapprovedRuntimeAllowlist = resolveNodeCommandAllowlist(cfg, desktopNode);
    expect(unapprovedRuntimeAllowlist.has("system.execApprovals.get")).toBe(false);
    expect(unapprovedRuntimeAllowlist.has("system.execApprovals.set")).toBe(false);

    const approvedRuntimeAllowlist = resolveNodeCommandAllowlist(cfg, {
      ...desktopNode,
      approvedCommands: ["system.execApprovals.get", "system.execApprovals.set"],
    });
    expect(approvedRuntimeAllowlist.has("system.execApprovals.get")).toBe(true);
    expect(approvedRuntimeAllowlist.has("system.execApprovals.set")).toBe(true);
  });

  it("keeps defaults for first-party native platform labels with matching families", () => {
    const cfg = {} as OpenClawConfig;

    const iosAllowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "iOS 18.4.0",
      deviceFamily: "iPhone",
    });
    expect(iosAllowlist.has("device.info")).toBe(true);
    expect(iosAllowlist.has("photos.latest")).toBe(true);
    expect(iosAllowlist.has("watch.status")).toBe(true);
    expect(iosAllowlist.has("watch.notify")).toBe(true);
    expect(iosAllowlist.has("health.summary")).toBe(false);
    expect(iosAllowlist.has("system.run")).toBe(false);

    const ipadAllowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "iPadOS 18.4.0",
      deviceFamily: "iPad",
    });
    expect(ipadAllowlist.has("device.info")).toBe(true);
    expect(ipadAllowlist.has("motion.activity")).toBe(true);
    expect(ipadAllowlist.has("watch.status")).toBe(false);
    expect(ipadAllowlist.has("watch.notify")).toBe(false);
    expect(ipadAllowlist.has("system.run")).toBe(false);

    const macAllowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "macOS 15.5.0",
      deviceFamily: "Mac",
    });
    expect(macAllowlist.has("system.run")).toBe(false);
    expect(macAllowlist.has("system.which")).toBe(false);
    expect(macAllowlist.has("screen.snapshot")).toBe(false);

    const watchAllowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "watchOS 11.5.0",
      deviceFamily: "Apple Watch",
    });
    expect(watchAllowlist.has("device.info")).toBe(true);
    expect(watchAllowlist.has("device.status")).toBe(true);
    expect(watchAllowlist.has("system.notify")).toBe(true);
    expect(watchAllowlist.has("watch.status")).toBe(false);
    expect(watchAllowlist.has("watch.notify")).toBe(false);
    expect(watchAllowlist.has("camera.list")).toBe(false);
    expect(watchAllowlist.has("system.run")).toBe(false);
  });

  it("requires matching watchOS platform and device-family metadata", () => {
    const cfg = {} as OpenClawConfig;
    const mismatch = resolveNodeCommandAllowlist(cfg, {
      platform: "watchOS 11.5.0",
      deviceFamily: "iPhone",
    });
    expect(mismatch.has("device.info")).toBe(false);

    const familyOnly = resolveNodeCommandAllowlist(cfg, { deviceFamily: "Apple Watch" });
    expect(familyOnly.has("device.info")).toBe(true);
    expect(familyOnly.has("system.run")).toBe(false);
  });

  it("keeps plugin defaults out of the fixed watchOS command surface", () => {
    installCanvasPluginDefaults();

    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      platform: "watchOS 11.5.0",
      deviceFamily: "Apple Watch",
    });

    expect(allowlist.has("device.info")).toBe(true);
    expect(allowlist.has("canvas.snapshot")).toBe(false);
    expect(allowlist.has("canvas.present")).toBe(false);
  });

  it("keeps explicitly approved host commands for desktop platforms", () => {
    const cfg = {} as OpenClawConfig;
    const cases = [
      { platform: "macos", deviceFamily: "Mac" },
      { platform: "windows", deviceFamily: "Windows" },
      { platform: "linux", deviceFamily: "Linux" },
    ];

    for (const node of cases) {
      const allowlist = resolveNodeCommandAllowlist(cfg, {
        ...node,
        approvedCommands: ["system.run", "system.which"],
      });
      expect(allowlist.has("system.run")).toBe(true);
      expect(allowlist.has("system.which")).toBe(true);
    }
  });

  it("keeps approved host commands on live desktop node sessions", () => {
    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      nodeId: "node-1",
      connId: "conn-1",
      platform: "linux",
      deviceFamily: "Linux",
      commands: ["browser.proxy", "browser.proxy.upload.v1", "system.run"],
    });

    expect(allowlist.has("browser.proxy")).toBe(true);
    expect(allowlist.has("browser.proxy.upload.v1")).toBe(true);
    expect(allowlist.has("system.run")).toBe(true);
  });

  it("uses the app-recommendation kill switch for gateway device.apps access", () => {
    const macNode = {
      platform: "macos",
      deviceFamily: "Mac",
      commands: ["device.apps"],
    };
    expect(resolveNodeCommandAllowlist({} as OpenClawConfig, macNode).has("device.apps")).toBe(
      true,
    );
    expect(
      resolveNodeCommandAllowlist(
        { wizard: { appRecommendations: false } } as OpenClawConfig,
        macNode,
      ).has("device.apps"),
    ).toBe(false);
  });

  it("allows approved node-host MCP calls while commands.deny still wins", () => {
    const node = {
      platform: "linux",
      deviceFamily: "Linux",
      commands: ["mcp.tools.call.v1"],
      approvedCommands: ["mcp.tools.call.v1"],
    };
    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, node);
    expect(
      resolveNodePairingCommandAllowlist({} as OpenClawConfig, node).has("mcp.tools.call.v1"),
    ).toBe(true);
    expect(allowlist.has("mcp.tools.call.v1")).toBe(true);
    expect(
      isNodeCommandAllowed({
        command: "mcp.tools.call.v1",
        declaredCommands: node.commands,
        allowlist,
      }),
    ).toEqual({ ok: true });

    const denied = resolveNodeCommandAllowlist(
      { gateway: { nodes: { commands: { deny: ["mcp.tools.call.v1"] } } } } as OpenClawConfig,
      node,
    );
    expect(denied.has("mcp.tools.call.v1")).toBe(false);
  });

  it("does not treat unconnected declared host commands as approved", () => {
    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      platform: "linux",
      deviceFamily: "Linux",
      commands: ["browser.proxy", "system.run"],
    });

    expect(allowlist.has("browser.proxy")).toBe(false);
    expect(allowlist.has("system.run")).toBe(false);
  });

  it("does not grandfather approved non-default commands after config removal", () => {
    const staleApproval = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      platform: "macos",
      deviceFamily: "Mac",
      approvedCommands: ["screen.record"],
    });
    expect(staleApproval.has("screen.record")).toBe(false);

    const currentConfigApproval = resolveNodeCommandAllowlist(
      {
        gateway: {
          nodes: {
            commands: { allow: ["screen.record"] },
          },
        },
      } as OpenClawConfig,
      {
        platform: "macos",
        deviceFamily: "Mac",
        approvedCommands: ["screen.record"],
      },
    );
    expect(currentConfigApproval.has("screen.record")).toBe(true);
  });

  it.each([
    ["macos", "Mac"],
    ["windows", "Windows"],
    ["linux", "Linux"],
  ])(
    "allows node-enabled and paired computer.act on %s without a persistent allow",
    (platform, deviceFamily) => {
      const desktopNode = {
        platform,
        deviceFamily,
        commands: ["computer.act", "screen.snapshot"],
        approvedCommands: ["computer.act", "screen.snapshot"],
      };
      const enabled = resolveNodeCommandAllowlist({} as OpenClawConfig, desktopNode);
      expect(enabled.has("computer.act")).toBe(true);
      expect(
        isNodeCommandAllowed({
          command: "computer.act",
          declaredCommands: desktopNode.commands,
          allowlist: enabled,
        }),
      ).toEqual({ ok: true });

      const denied = resolveNodeCommandAllowlist(
        {
          gateway: {
            nodes: { commands: { allow: ["computer.act"], deny: ["computer.act"] } },
          },
        } as OpenClawConfig,
        desktopNode,
      );
      expect(denied.has("computer.act")).toBe(false);
    },
  );

  it("keeps computer.act declarable through desktop pairing allowlists only", () => {
    for (const [platform, deviceFamily] of [
      ["macos", "Mac"],
      ["windows", "Windows"],
      ["linux", "Linux"],
    ]) {
      const pairing = resolveNodePairingCommandAllowlist({} as OpenClawConfig, {
        platform,
        deviceFamily,
        commands: ["computer.act", "screen.snapshot"],
      });
      expect(pairing.has("computer.act")).toBe(true);
      expect(pairing.has("screen.snapshot")).toBe(true);
    }

    for (const [platform, deviceFamily] of [
      ["ios", "iPhone"],
      ["android", "Android"],
    ]) {
      const pairing = resolveNodePairingCommandAllowlist({} as OpenClawConfig, {
        platform,
        deviceFamily,
        commands: ["computer.act"],
      });
      expect(pairing.has("computer.act")).toBe(false);
    }

    const windowsPairing = resolveNodePairingCommandAllowlist({} as OpenClawConfig, {
      platform: "windows",
      deviceFamily: "Windows",
      commands: ["screen.record"],
    });
    // Dangerous commands outside PLATFORM_DEFAULTS stay out of pairing too.
    expect(windowsPairing.has("screen.record")).toBe(false);
  });

  it("applies an operator-authored computer.act deny at pairing and invocation", () => {
    const cfg = {
      gateway: {
        nodes: { commands: { deny: ["computer.act"] } },
      },
    } as OpenClawConfig;
    const macNode = { platform: "macos", deviceFamily: "Mac", commands: ["computer.act"] };
    expect(resolveNodePairingCommandAllowlist(cfg, macNode).has("computer.act")).toBe(false);
    expect(resolveNodeCommandAllowlist(cfg, macNode).has("computer.act")).toBe(false);
  });

  it("scopes a plugin dangerous flag to plugin surfaces, not core platform defaults", () => {
    // A bundled computer-use provider plugin registers computer.act as dangerous
    // so it needs a registered invoke policy. That flag must not revoke the core
    // desktop platform default, whose grant is node enablement plus pairing.
    const registry = createEmptyPluginRegistry();
    for (const command of ["computer.act", "cua.driver.reset"]) {
      registry.nodeHostCommands.push({
        pluginId: "cua-computer",
        pluginName: "CUA Computer",
        source: "/extensions/cua-computer/index.ts",
        rootDir: "/extensions/cua-computer",
        command: {
          command,
          cap: "computer",
          dangerous: true,
          agentTool: {
            name: command.replaceAll(".", "_"),
            description: "Computer surface",
            defaultPlatforms: ["windows"],
          },
          handle: async () => "{}",
        },
      });
      registry.nodeInvokePolicies.push({
        pluginId: "cua-computer",
        pluginName: "CUA Computer",
        source: "/extensions/cua-computer/index.ts",
        rootDir: "/extensions/cua-computer",
        pluginConfig: {},
        policy: {
          commands: [command],
          dangerous: true,
          handle: async (ctx) => await ctx.invokeNode(),
        },
      });
    }
    setActivePluginRegistry(registry);

    const node = {
      platform: "windows",
      deviceFamily: "Windows",
      commands: ["computer.act", "cua.driver.reset"],
      approvedCommands: ["computer.act", "cua.driver.reset"],
    };
    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, node);
    expect(allowlist.has("computer.act")).toBe(true);
    expect(allowlist.has("cua.driver.reset")).toBe(false);
    expect(
      isNodeCommandAllowed({
        command: "computer.act",
        declaredCommands: node.commands,
        allowlist,
      }),
    ).toEqual({ ok: true });

    const opted = resolveNodeCommandAllowlist(
      {
        gateway: {
          nodes: { commands: { allow: ["cua.driver.reset"] } },
        },
      } as OpenClawConfig,
      node,
    );
    expect(opted.has("cua.driver.reset")).toBe(true);
  });

  it("drops a capability whose declared commands all failed the allowlist", () => {
    const denied = resolveNodePairingCommandAllowlist(
      { gateway: { nodes: { commands: { deny: ["computer.act"] } } } } as OpenClawConfig,
      { platform: "macos", deviceFamily: "Mac", commands: ["computer.act", "screen.snapshot"] },
    );
    expect(
      retainFulfilledNodeCapabilities({
        caps: ["canvas", "screen", "computer"],
        withheldCommands: ["computer.act"],
        admittedCommands: normalizeDeclaredNodeCommands({
          declaredCommands: ["computer.act", "screen.snapshot"],
          allowlist: denied,
        }),
      }),
    ).toEqual(["canvas", "screen"]);

    // A capability the node never backed with a core-owned command is untouched.
    expect(
      retainFulfilledNodeCapabilities({
        caps: ["computer"],
        admittedCommands: [],
        withheldCommands: [],
      }),
    ).toEqual(["computer"]);
  });

  it("allows node-enabled and paired mobile UI without a persistent allow", () => {
    const node = {
      platform: "android",
      deviceFamily: "Android",
      commands: ["mobile.ui.observe", "mobile.ui.act"],
      approvedCommands: ["mobile.ui.observe", "mobile.ui.act"],
    };
    const enabled = resolveNodeCommandAllowlist({} as OpenClawConfig, node);
    expect(enabled.has("mobile.ui.observe")).toBe(true);
    expect(enabled.has("mobile.ui.act")).toBe(true);
    expect(
      isNodeCommandAllowed({
        command: "mobile.ui.act",
        declaredCommands: node.commands,
        allowlist: enabled,
      }),
    ).toEqual({ ok: true });

    const denied = resolveNodeCommandAllowlist(
      {
        gateway: {
          nodes: {
            commands: {
              allow: ["mobile.ui.observe", "mobile.ui.act"],
              deny: ["mobile.ui.act"],
            },
          },
        },
      } as OpenClawConfig,
      node,
    );
    expect(denied.has("mobile.ui.observe")).toBe(true);
    expect(denied.has("mobile.ui.act")).toBe(false);
  });

  it("keeps mobile UI commands declarable only on Android pairing surfaces", () => {
    const freshSetup = {
      gateway: {
        nodes: { denyCommands: ["mobile.ui.observe", "mobile.ui.act"] },
      },
    } as OpenClawConfig;
    const androidPairing = resolveNodePairingCommandAllowlist(freshSetup, {
      platform: "android",
      deviceFamily: "Android",
      commands: ["mobile.ui.observe", "mobile.ui.act"],
    });
    expect(androidPairing.has("mobile.ui.observe")).toBe(true);
    expect(androidPairing.has("mobile.ui.act")).toBe(true);

    const iosPairing = resolveNodePairingCommandAllowlist({} as OpenClawConfig, {
      platform: "ios",
      deviceFamily: "iPhone",
      commands: ["mobile.ui.observe", "mobile.ui.act"],
    });
    expect(iosPairing.has("mobile.ui.observe")).toBe(false);
    expect(iosPairing.has("mobile.ui.act")).toBe(false);
  });

  it("requires explicit gateway opt-in for iOS health summaries", () => {
    const node = {
      platform: "iOS 18.4.0",
      deviceFamily: "iPhone",
      commands: ["health.summary"],
    };
    expect(resolveNodeCommandAllowlist({} as OpenClawConfig, node).has("health.summary")).toBe(
      false,
    );

    const enabled = {
      gateway: { nodes: { commands: { allow: ["health.summary"] } } },
    } as OpenClawConfig;
    expect(resolveNodePairingCommandAllowlist(enabled, node).has("health.summary")).toBe(true);
    expect(resolveNodeCommandAllowlist(enabled, node).has("health.summary")).toBe(true);

    const denied = {
      gateway: {
        nodes: {
          commands: { allow: ["health.summary"], deny: ["health.summary"] },
        },
      },
    } as OpenClawConfig;
    expect(resolveNodeCommandAllowlist(denied, node).has("health.summary")).toBe(false);
  });

  it("requires a persistent allow for sms.send and keeps deny-wins semantics", () => {
    const node = {
      platform: "android",
      deviceFamily: "Android",
      commands: ["sms.send"],
      approvedCommands: ["sms.send"],
    };
    expect(resolveNodeCommandAllowlist({} as OpenClawConfig, node).has("sms.send")).toBe(false);

    const enabled = {
      gateway: { nodes: { commands: { allow: ["sms.send"] } } },
    } as OpenClawConfig;
    expect(resolveNodeCommandAllowlist(enabled, node).has("sms.send")).toBe(true);

    const denied = {
      gateway: {
        nodes: { commands: { allow: ["sms.send"], deny: ["sms.send"] } },
      },
    } as OpenClawConfig;
    expect(resolveNodeCommandAllowlist(denied, node).has("sms.send")).toBe(false);
  });

  it("reads foreground restriction metadata from plugin node policies", () => {
    expect(isForegroundRestrictedPluginNodeCommand("canvas.snapshot")).toBe(false);

    installCanvasPluginDefaults();

    expect(isForegroundRestrictedPluginNodeCommand("canvas.snapshot")).toBe(true);
    expect(isForegroundRestrictedPluginNodeCommand("system.run")).toBe(false);
  });
});
