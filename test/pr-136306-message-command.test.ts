import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "../extensions/telegram/api.js";
import type { CliDeps } from "../src/cli/deps.js";
import { messageCommand } from "../src/commands/message.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { RuntimeEnv } from "../src/runtime.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";

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
    const sendMessageTelegram = vi.fn(async (to: string, text: string) => ({
      messageId: "fixture-message",
      to,
      text,
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: { ...telegramPlugin, actions: undefined },
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
      { sendMessageTelegram } satisfies CliDeps,
      runtime,
    );

    expect(sendMessageTelegram.mock.calls.map(([to, text]) => ({ to, text }))).toEqual([
      { to: "telegram:12345", text: "Manual" },
    ]);
  });
});
