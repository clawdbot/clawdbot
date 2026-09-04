import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as conversationRuntime from "openclaw/plugin-sdk/conversation-binding-runtime";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "../../api.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { nativeCommandRuntime } from "./native-command.runtime.js";
import { createMockCommandInteraction } from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof conversationRuntime>()),
  ensureConfiguredBindingRouteReady: vi.fn(async () => ({ ok: true })),
}));

describe("Discord native verbose menu", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "discord-verbose-menu" });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", plugin: discordPlugin, source: "test" }]),
    );
    vi.mocked(conversationRuntime.ensureConfiguredBindingRouteReady).mockResolvedValue({
      ok: true,
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    setActivePluginRegistry(createTestRegistry([]));
    await state.cleanup();
  });

  it.each(["ready", "unavailable", "unauthorized"] as const)(
    "preserves the %s command route",
    async (mode) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { target: { verboseDefault: "full" } } },
        commands: { allowFrom: { discord: ["user:123456789012345678"] } },
        channels: {
          discord: {
            dmPolicy: "allowlist",
            allowFrom: ["123456789012345678"],
            dm: { enabled: true },
          },
        },
        bindings:
          mode === "unavailable"
            ? [
                {
                  type: "acp",
                  agentId: "target",
                  match: {
                    channel: "discord",
                    accountId: "default",
                    peer: { kind: "direct", id: "234567890123456789" },
                  },
                  acp: { mode: "persistent" },
                },
              ]
            : undefined,
      };
      await state.writeConfig(cfg);
      if (mode === "unavailable") {
        vi.mocked(conversationRuntime.ensureConfiguredBindingRouteReady).mockResolvedValue({
          ok: false,
          error: "fixture unavailable",
        });
      }
      const interaction = createMockCommandInteraction({
        userId: mode === "unauthorized" ? "987654321098765432" : "123456789012345678",
        channelId: "234567890123456789",
      });
      const dispatch = vi.spyOn(nativeCommandRuntime, "dispatchChannelInboundTurn");
      const command = createDiscordNativeCommand({
        command: { name: "verbose", description: "Verbose mode", acceptsArgs: true },
        cfg,
        discordConfig: cfg.channels?.discord ?? {},
        accountId: "default",
        sessionPrefix: "discord:slash",
        ephemeralDefault: true,
        threadBindings: createNoopThreadBindingManager("default"),
      });
      await command.run(interaction);
      if (mode === "unavailable") {
        expect(conversationRuntime.ensureConfiguredBindingRouteReady).toHaveBeenCalled();
      }
      expect(dispatch).not.toHaveBeenCalled();
      expect(interaction.followUp).toHaveBeenCalledWith(
        expect.objectContaining({
          content:
            mode === "ready"
              ? "Current verbose level: full.\nChoose on, off, or full for /verbose."
              : mode === "unavailable"
                ? "Configured ACP binding is unavailable right now. Please try again."
                : "You are not authorized to use this command.",
        }),
      );
      const payload = interaction.followUp.mock.calls[0]?.[0];
      expect(Boolean(payload?.components?.length)).toBe(mode === "ready");
    },
  );
});
