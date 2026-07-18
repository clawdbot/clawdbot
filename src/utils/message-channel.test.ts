// Message channel tests cover channel id normalization and routing helpers.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  isBrowserCopilotClient,
  isBrowserOperatorUiClient,
  isEphemeralGatewayClient,
  isInternalNonDeliveryChannel,
  isMarkdownCapableMessageChannel,
  isNativeApprovalChannel,
  isOperatorUiClient,
  resolveGatewayMessageChannel,
} from "./message-channel.js";

const INTERNAL_NON_DELIVERY_CHANNELS = [
  "heartbeat",
  "cron",
  "webhook",
  "voice",
  "sessions_send",
] as const;

const emptyRegistry = createTestRegistry([]);
const demoAliasPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "demo-alias-channel",
    label: "Demo Alias Channel",
    docsPath: "/channels/demo-alias-channel",
  }),
  meta: {
    ...createChannelTestPluginBase({
      id: "demo-alias-channel",
      label: "Demo Alias Channel",
      docsPath: "/channels/demo-alias-channel",
    }).meta,
    aliases: ["workspace-chat"],
  },
};

const demoMarkdownPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "demo-markdown-channel",
    label: "Demo Markdown Channel",
    docsPath: "/channels/demo-markdown-channel",
    markdownCapable: true,
  }),
};

describe("message-channel", () => {
  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("normalizes gateway message channels and rejects unknown values", () => {
    expect(resolveGatewayMessageChannel("discord")).toBe("discord");
    expect(resolveGatewayMessageChannel(" imsg ")).toBe("imessage");
    expect(resolveGatewayMessageChannel("web")).toBeUndefined();
    expect(resolveGatewayMessageChannel("nope")).toBeUndefined();
  });

  it("classifies ephemeral Gateway client modes", () => {
    for (const mode of ["cli", "backend", "probe", " CLI "]) {
      expect(isEphemeralGatewayClient({ mode })).toBe(true);
    }
    // "test" stays tracked: suites use test-mode clients as real-client stand-ins.
    for (const mode of ["ui", "webchat", "node", "test", "unknown", undefined]) {
      expect(isEphemeralGatewayClient({ mode })).toBe(false);
    }
  });

  it("classifies the browser copilot as a dedicated browser operator UI", () => {
    const client = { id: "openclaw-browser-copilot", mode: "ui" };
    expect(isBrowserCopilotClient(client)).toBe(true);
    expect(isBrowserOperatorUiClient(client)).toBe(true);
    expect(isOperatorUiClient(client)).toBe(true);
    expect(isBrowserCopilotClient({ id: "webchat", mode: "webchat" })).toBe(false);
    expect(isBrowserCopilotClient({ id: "openclaw-browser-copilot", mode: "webchat" })).toBe(true);
  });

  it("normalizes plugin aliases when registered", () => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "demo-alias-channel", plugin: demoAliasPlugin, source: "test" },
      ]),
    );
    expect(resolveGatewayMessageChannel("workspace-chat")).toBe("demo-alias-channel");
  });

  it("recognises internal non-delivery channel sources", () => {
    for (const channel of INTERNAL_NON_DELIVERY_CHANNELS) {
      expect(isInternalNonDeliveryChannel(channel)).toBe(true);
    }
    expect(isInternalNonDeliveryChannel("telegram")).toBe(false);
    expect(isInternalNonDeliveryChannel("webchat")).toBe(false);
    expect(isInternalNonDeliveryChannel("")).toBe(false);
    expect(isInternalNonDeliveryChannel("HEARTBEAT")).toBe(false);
  });

  it("lists native chat exec approval channels", () => {
    for (const channel of [
      "webchat",
      "discord",
      "googlechat",
      "imessage",
      "matrix",
      "qqbot",
      "signal",
      "slack",
      "telegram",
      "whatsapp",
    ]) {
      expect(isNativeApprovalChannel(channel)).toBe(true);
    }
    // Channels without a bundled exec-capable native approval runtime must not claim it.
    expect(isNativeApprovalChannel("feishu")).toBe(false);
    expect(isNativeApprovalChannel("msteams")).toBe(false);
    expect(isNativeApprovalChannel("line")).toBe(false);
    expect(isNativeApprovalChannel("heartbeat")).toBe(false);
    expect(isNativeApprovalChannel("")).toBe(false);
    expect(isNativeApprovalChannel("TELEGRAM")).toBe(false);
  });

  it("reads markdown capability from channel metadata", () => {
    expect(isMarkdownCapableMessageChannel("telegram")).toBe(true);
    expect(isMarkdownCapableMessageChannel("whatsapp")).toBe(false);
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "demo-markdown-channel", plugin: demoMarkdownPlugin, source: "test" },
      ]),
    );
    expect(isMarkdownCapableMessageChannel("demo-markdown-channel")).toBe(true);
  });

  it("reads Matrix markdown capability from bundled channel catalog metadata", async () => {
    const previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.resolve("extensions");
    vi.resetModules();
    try {
      const module = await import("./message-channel.js");
      expect(module.isMarkdownCapableMessageChannel("matrix")).toBe(true);
    } finally {
      if (previousBundledPluginsDir === undefined) {
        delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
      } else {
        process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = previousBundledPluginsDir;
      }
      vi.resetModules();
    }
  });

  it("treats registered plugin channels without markdown metadata as plain text", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "qa-channel",
          plugin: createChannelTestPluginBase({
            id: "qa-channel",
            label: "QA Channel",
            docsPath: "/channels/qa-channel",
          }),
          source: "test",
        },
      ]),
    );

    expect(isMarkdownCapableMessageChannel("qa-channel")).toBe(false);
  });
});
