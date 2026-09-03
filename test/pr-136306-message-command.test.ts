import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../src/cli/deps.js";
import { messageCommand } from "../src/commands/message.js";
import { sanitizeForPlainText } from "../src/infra/outbound/sanitize-text.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { RuntimeEnv } from "../src/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../src/test-utils/channel-plugins.js";

vi.mock("../src/config/config.js", () => ({
  getRuntimeConfig: () => ({ channels: { telegram: { enabled: true } } }),
}));
vi.mock("../src/cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: async ({ config }: { config: unknown }) => ({
    effectiveConfig: config,
    resolvedConfig: config,
    diagnostics: [],
  }),
}));
vi.mock("../src/cli/command-secret-targets.js", () => ({
  getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
}));

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("unexpected CLI exit");
  }),
};

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.mocked(runtime.log).mockClear();
});

describe("messageCommand outbound label projection", () => {
  it("delivers the visible label through the shipped message command", async () => {
    const sendText = vi.fn(async ({ to, text }: { to: string; text: string }) => ({
      channel: "telegram" as const,
      messageId: "fixture-message",
      to,
      text,
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            messaging: {
              targetResolver: {
                looksLike: () => true,
                resolveTarget: async ({ input }) => ({
                  to: input,
                  kind: "user" as const,
                  source: "normalized" as const,
                }),
              },
            },
            outbound: {
              deliveryMode: "direct",
              sanitizeText: ({ text }) => sanitizeForPlainText(text),
              sendText,
            },
          }),
        },
      ]),
    );

    await messageCommand(
      {
        action: "send",
        channel: "telegram",
        target: "12345",
        message: "<https://example.com/a.pdf|Manual>",
        json: true,
      },
      {} as CliDeps,
      runtime,
    );

    expect(sendText.mock.calls.map(([call]) => ({ to: call.to, text: call.text }))).toEqual([
      { to: "12345", text: "Manual" },
    ]);
  });
});
