import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";

const resolveTelegramMiniAppUrls = vi.hoisted(() => vi.fn());

vi.mock("./url.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./url.js")>()),
  resolveTelegramMiniAppUrls,
}));

const { createTelegramMiniAppDashboardCommand } = await import("./command.js");

function commandContext(overrides: Partial<PluginCommandContext>): PluginCommandContext {
  return {
    channel: "telegram",
    isAuthorizedSender: true,
    commandBody: "/dashboard",
    config: {},
    requestConversationBinding: async () => ({ status: "error", message: "unused" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
    ...overrides,
  };
}

describe("createTelegramMiniAppDashboardCommand", () => {
  it("returns a DM-only message for group invocations", async () => {
    const command = createTelegramMiniAppDashboardCommand(
      createTestPluginApi({
        config: {
          channels: {
            telegram: {
              accounts: {
                ops: { allowFrom: ["123"] },
              },
            },
          },
        },
      }),
    );

    await expect(
      command.handler(
        commandContext({
          from: "telegram:group:-100",
          sessionKey: "telegram:group:-100",
          senderIsOwner: true,
        }),
      ),
    ).resolves.toEqual({ text: "open this in a DM with the bot" });
    expect(resolveTelegramMiniAppUrls).not.toHaveBeenCalled();
  });

  it("returns a web app button for owner DM invocations", async () => {
    resolveTelegramMiniAppUrls.mockResolvedValue({
      pageUrl: "https://host.tailnet.ts.net/__openclaw_tg_miniapp/",
      controlUiUrl: "https://host.tailnet.ts.net/openclaw",
      gatewayUrl: "wss://host.tailnet.ts.net",
    });
    const command = createTelegramMiniAppDashboardCommand(
      createTestPluginApi({
        config: {
          channels: {
            telegram: {
              accounts: {
                ops: { allowFrom: ["123"] },
              },
            },
          },
        },
      }),
    );

    const result = await command.handler(
      commandContext({
        from: "telegram:123",
        sessionKey: "telegram:direct:123",
        senderIsOwner: false,
        accountId: "ops",
      }),
    );

    expect(result.text).toBe("Open OpenClaw dashboard.");
    expect(result.presentation?.blocks).toEqual([
      {
        type: "buttons",
        buttons: [
          {
            label: "Open dashboard",
            webApp: {
              url: "https://host.tailnet.ts.net/__openclaw_tg_miniapp/?accountId=ops",
            },
          },
        ],
      },
    ]);
  });
});
