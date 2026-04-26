import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { shouldBypassAcpDispatchForCommand } from "./dispatch-acp-command-bypass.js";
import { buildTestCtx } from "./test-ctx.js";

describe("shouldBypassAcpDispatchForCommand", () => {
  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("returns false for plain-text ACP turns", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      BodyForCommands: "write a test",
      BodyForAgent: "write a test",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(false);
  });

  it("returns true for ACP slash commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/acp cancel",
      BodyForCommands: "/acp cancel",
      BodyForAgent: "/acp cancel",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns true for native ACP slash commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandSource: "native",
      CommandBody: "/acp close",
      BodyForCommands: "/acp close",
      BodyForAgent: "/acp close",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns false for ACP slash commands addressed to another bot", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/acp@otherbot cancel",
      BodyForCommands: "/acp@otherbot cancel",
      BodyForAgent: "/acp@otherbot cancel",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(false);
  });

  it("returns true for local status commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/status",
      BodyForCommands: "/status",
      BodyForAgent: "/status",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns true for local unfocus commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/unfocus",
      BodyForCommands: "/unfocus",
      BodyForAgent: "/unfocus",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns true for ACP reset-tail slash commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandSource: "native",
      CommandBody: "/new continue with deployment",
      BodyForCommands: "/new continue with deployment",
      BodyForAgent: "/new continue with deployment",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns true for bare ACP reset slash commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/reset",
      BodyForCommands: "/reset",
      BodyForAgent: "/reset",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns false for unrelated slash commands when text commands are disabled", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/foo cancel",
      BodyForCommands: "/foo cancel",
      BodyForAgent: "/foo cancel",
      CommandSource: "text",
    });
    const cfg = {
      commands: {
        text: false,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(false);
  });

  it("returns true for ACP slash commands when text commands are disabled", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/acp cancel",
      BodyForCommands: "/acp cancel",
      BodyForAgent: "/acp cancel",
      CommandSource: "text",
    });
    const cfg = {
      commands: {
        text: false,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(true);
  });

  it("returns false for local status commands when text commands are disabled on text-native surfaces", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          plugin: createChannelTestPluginBase({
            id: "discord",
            capabilities: { nativeCommands: true, chatTypes: ["direct"] },
          }),
          source: "test",
        },
      ]),
    );

    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/status",
      BodyForCommands: "/status",
      BodyForAgent: "/status",
      CommandSource: "text",
    });
    const cfg = {
      commands: {
        text: false,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(false);
  });

  it("returns true for native local status commands when text commands are disabled", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/status",
      BodyForCommands: "/status",
      BodyForAgent: "/status",
      CommandSource: "native",
    });
    const cfg = {
      commands: {
        text: false,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(true);
  });

  it("returns false for unauthorized bang-prefixed commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "!poll",
      BodyForCommands: "!poll",
      BodyForAgent: "!poll",
      CommandAuthorized: false,
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(false);
  });

  it("returns false for bang-prefixed commands when text commands are disabled", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "!poll",
      BodyForCommands: "!poll",
      BodyForAgent: "!poll",
      CommandAuthorized: true,
      CommandSource: "text",
    });
    const cfg = {
      commands: {
        text: false,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(false);
  });

  it("returns true for authorized bang-prefixed commands when text commands are enabled", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "!poll",
      BodyForCommands: "!poll",
      BodyForAgent: "!poll",
      CommandAuthorized: true,
      CommandSource: "text",
    });
    const cfg = {
      commands: {
        bash: true,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(true);
  });
});
