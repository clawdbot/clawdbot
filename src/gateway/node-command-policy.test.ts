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

  it("reads foreground restriction metadata from plugin node policies", () => {
    expect(isForegroundRestrictedPluginNodeCommand("canvas.snapshot")).toBe(false);

    installCanvasPluginDefaults();

    expect(isForegroundRestrictedPluginNodeCommand("canvas.snapshot")).toBe(true);
    expect(isForegroundRestrictedPluginNodeCommand("system.run")).toBe(false);
  });
});
