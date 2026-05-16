import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  isForegroundRestrictedPluginNodeCommand,
  isNodeCommandAllowed,
  normalizeDeclaredNodeCommands,
  resolveNodeCommandAllowlist,
} from "./node-command-policy.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "./protocol/client-info.js";

describe("gateway/node-command-policy", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  function installCanvasPluginDefaults() {
    const registry = createEmptyPluginRegistry();
    (registry.nodeInvokePolicies ??= []).push({
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
      expect(allowlist.has("browser.proxy")).toBe(false);
      expect(allowlist.has("screen.snapshot")).toBe(false);
      expect(allowlist.has("system.notify")).toBe(true);
    }
  });

  it("keeps defaults for first-party native platform labels with matching families", () => {
    const cfg = {} as OpenClawConfig;

    const iosAllowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "iOS 18.4.0",
      deviceFamily: "iPhone",
    });
    expect(iosAllowlist.has("device.info")).toBe(true);
    expect(iosAllowlist.has("photos.latest")).toBe(true);
    expect(iosAllowlist.has("system.run")).toBe(false);

    const ipadAllowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "iPadOS 18.4.0",
      deviceFamily: "iPad",
    });
    expect(ipadAllowlist.has("device.info")).toBe(true);
    expect(ipadAllowlist.has("motion.activity")).toBe(true);
    expect(ipadAllowlist.has("system.run")).toBe(false);

    const macAllowlist = resolveNodeCommandAllowlist(cfg, {
      platform: "macOS 15.5.0",
      deviceFamily: "Mac",
    });
    expect(macAllowlist.has("system.run")).toBe(false);
    expect(macAllowlist.has("system.which")).toBe(false);
    expect(macAllowlist.has("screen.snapshot")).toBe(false);
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

  it("reads foreground restriction metadata from plugin node policies", () => {
    expect(isForegroundRestrictedPluginNodeCommand("canvas.snapshot")).toBe(false);

    installCanvasPluginDefaults();

    expect(isForegroundRestrictedPluginNodeCommand("canvas.snapshot")).toBe(true);
    expect(isForegroundRestrictedPluginNodeCommand("system.run")).toBe(false);
  });
});
