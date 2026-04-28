import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { MsgContext } from "../templating.js";
import { handleDockCommand } from "./commands-dock.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

function installDockCommandRegistry() {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        plugin: createChannelTestPluginBase({
          id: "telegram",
          capabilities: { nativeCommands: true, chatTypes: ["direct"] },
          config: { defaultAccountId: () => "primary" },
        }),
        source: "test",
      },
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
}

function buildDockParams(commandBody: string, ctxOverrides?: Partial<MsgContext>) {
  const sessionEntry = {
    sessionId: "session-dock",
    updatedAt: 1,
    lastChannel: "telegram",
    lastTo: "42",
    lastAccountId: "primary",
  };
  const params = buildCommandTestParams(
    commandBody,
    {
      commands: { text: true },
      session: {
        identityLinks: {
          alice: ["telegram:42", "discord:UserCase123"],
        },
      },
      channels: { telegram: { allowFrom: ["*"] }, discord: { allowFrom: ["*"] } },
    },
    {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      SenderId: "42",
      From: "42",
      ...ctxOverrides,
    },
  );
  params.sessionKey = "agent:main:main";
  params.sessionEntry = sessionEntry;
  params.sessionStore = { [params.sessionKey]: sessionEntry };
  return params;
}

describe("handleDockCommand", () => {
  beforeEach(() => {
    installDockCommandRegistry();
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("switches the current session route with the canonical dock command", async () => {
    const params = buildDockParams("/dock-discord");

    const result = await handleDockCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Docked replies to discord." },
    });
    expect(params.sessionStore?.[params.sessionKey]).toMatchObject({
      lastChannel: "discord",
      lastTo: "UserCase123",
      lastAccountId: "default",
    });
  });

  it("accepts generated underscore aliases such as Telegram native /dock_discord", async () => {
    const params = buildDockParams("/dock_discord");

    const result = await handleDockCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(params.sessionEntry?.lastChannel).toBe("discord");
    expect(params.sessionEntry?.lastTo).toBe("UserCase123");
  });

  it("does not claim unrelated slash commands", async () => {
    const result = await handleDockCommand(buildDockParams("/status"), true);

    expect(result).toBeNull();
  });

  it("returns an identityLinks hint when no linked target exists", async () => {
    const params = buildDockParams("/dock-discord", { SenderId: "404", From: "404" });

    const result = await handleDockCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "Cannot dock to discord: add this sender and a discord:... peer to session.identityLinks.",
      },
    });
    expect(params.sessionEntry?.lastChannel).toBe("telegram");
  });

  it("fails closed when no session entry can be persisted", async () => {
    const params = buildDockParams("/dock-discord");
    params.sessionEntry = undefined;
    params.sessionStore = undefined;

    const result = await handleDockCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Cannot dock to discord: no active session entry was found." },
    });
  });

  it("ignores dock commands when text command handling is disabled", async () => {
    const result = await handleDockCommand(buildDockParams("/dock-discord"), false);

    expect(result).toBeNull();
  });
});
