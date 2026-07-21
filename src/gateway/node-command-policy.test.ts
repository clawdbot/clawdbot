/**
 * Node command policy regression tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  pinActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  isForegroundRestrictedPluginNodeCommand,
  isNodeCommandAllowed,
  normalizeDeclaredNodeCommands,
  resolveNodeCommandAllowlist,
  resolveNodePairingCommandAllowlist,
} from "./node-command-policy.js";
import { filterLegacyNodeProtocolFeatures } from "./node-legacy-protocol-filter.js";

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

  it("normalizes declared node commands against the allowlist", () => {
    const allowlist = new Set(["canvas.snapshot", "system.run"]);
    expect(
      normalizeDeclaredNodeCommands({
        declaredCommands: [" canvas.snapshot ", "", "system.run", "system.run", "screen.record"],
        allowlist,
      }),
    ).toEqual(["canvas.snapshot", "system.run"]);
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
        "location.get",
        "device.info",
      ],
    });
  });

  it("keeps plugin node defaults from the pinned Gateway registry", () => {
    const startupRegistry = installCanvasPluginDefaults();
    pinActivePluginChannelRegistry(startupRegistry);
    const transientRegistry = createEmptyPluginRegistry();
    const startupPolicy = startupRegistry.nodeInvokePolicies[0];
    if (!startupPolicy) {
      throw new Error("expected canvas node policy");
    }
    transientRegistry.nodeInvokePolicies.push({
      ...startupPolicy,
      pluginId: "transient",
      policy: {
        ...startupPolicy.policy,
        commands: ["transient.read"],
      },
    });
    setActivePluginRegistry(transientRegistry);

    const allowlist = resolveNodeCommandAllowlist({} as OpenClawConfig, {
      platform: "macos",
      deviceFamily: "Mac",
    });

    expect(allowlist.has("canvas.snapshot")).toBe(true);
    expect(allowlist.has("canvas.present")).toBe(true);
    expect(allowlist.has("transient.read")).toBe(false);
  });

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
      commands: ["browser.proxy", "system.run"],
    });

    expect(allowlist.has("browser.proxy")).toBe(true);
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

  it("allows approved node-host MCP calls while denyCommands still wins", () => {
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
      { gateway: { nodes: { denyCommands: ["mcp.tools.call.v1"] } } } as OpenClawConfig,
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
            allowCommands: ["screen.record"],
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
    "keeps computer.act out of the %s runtime allowlist until explicitly allowed",
    (platform, deviceFamily) => {
      const desktopNode = {
        platform,
        deviceFamily,
        commands: ["computer.act", "screen.snapshot"],
      };
      const unarmed = resolveNodeCommandAllowlist({} as OpenClawConfig, desktopNode);
      expect(unarmed.has("computer.act")).toBe(false);
      expect(
        resolveNodeCommandAllowlist({} as OpenClawConfig, {
          ...desktopNode,
          approvedCommands: ["computer.act"],
        }).has("computer.act"),
      ).toBe(false);

      const armed = resolveNodeCommandAllowlist(
        { gateway: { nodes: { allowCommands: ["computer.act"] } } } as OpenClawConfig,
        desktopNode,
      );
      expect(armed.has("computer.act")).toBe(true);

      const denied = resolveNodeCommandAllowlist(
        {
          gateway: { nodes: { allowCommands: ["computer.act"], denyCommands: ["computer.act"] } },
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

  it("keeps computer.act declarable at pairing even when fresh-setup denyCommands blocks it", () => {
    // Fresh gateway setup seeds denyCommands from DEFAULT_DANGEROUS_NODE_COMMANDS,
    // which includes computer.act. The pairing surface must still retain it so
    // the node can be armed later; invoke-time policy still blocks it at runtime.
    const cfg = {
      gateway: { nodes: { denyCommands: ["computer.act", "screen.record", "camera.snap"] } },
    } as OpenClawConfig;
    const macNode = { platform: "macos", deviceFamily: "Mac", commands: ["computer.act"] };
    expect(resolveNodePairingCommandAllowlist(cfg, macNode).has("computer.act")).toBe(true);
    // Runtime allowlist still gates it until armed via allowCommands.
    expect(resolveNodeCommandAllowlist(cfg, macNode).has("computer.act")).toBe(false);
    // Arming (allowCommands opt-in) makes it runtime-invocable.
    const armedCfg = {
      gateway: { nodes: { allowCommands: ["computer.act"] } },
    } as OpenClawConfig;
    expect(resolveNodeCommandAllowlist(armedCfg, macNode).has("computer.act")).toBe(true);
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

    const armed = {
      gateway: { nodes: { allowCommands: ["health.summary"] } },
    } as OpenClawConfig;
    expect(resolveNodePairingCommandAllowlist(armed, node).has("health.summary")).toBe(true);
    expect(resolveNodeCommandAllowlist(armed, node).has("health.summary")).toBe(true);

    const denied = {
      gateway: {
        nodes: {
          allowCommands: ["health.summary"],
          denyCommands: ["health.summary"],
        },
      },
    } as OpenClawConfig;
    expect(resolveNodeCommandAllowlist(denied, node).has("health.summary")).toBe(false);
  });

  it("reads foreground restriction metadata from plugin node policies", () => {
    expect(isForegroundRestrictedPluginNodeCommand("canvas.snapshot")).toBe(false);

    installCanvasPluginDefaults();

    expect(isForegroundRestrictedPluginNodeCommand("canvas.snapshot")).toBe(true);
    expect(isForegroundRestrictedPluginNodeCommand("system.run")).toBe(false);
  });
});
