// Tests runtime-loaded fast-path command behavior for get-reply.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { projectSessionDeliveryFields } from "../../utils/delivery-context.shared.js";
import {
  createReplyRuntimeMocks,
  createTempHomeHarness,
  installReplyRuntimeMocks,
  makeEmbeddedTextResult,
  makeReplyConfig,
  resetReplyRuntimeMocks,
} from "../reply.test-harness.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
const agentMocks = createReplyRuntimeMocks();
const { withTempHome } = createTempHomeHarness({ prefix: "openclaw-getreply-fast-" });

installReplyRuntimeMocks(agentMocks);

describe("getReplyFromConfig fast-path runtime", () => {
  beforeAll(async () => {
    ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetReplyRuntimeMocks(agentMocks);
    agentMocks.runEmbeddedAgent.mockResolvedValue(makeEmbeddedTextResult("warm runtime"));
    await withTempHome(async (home) => {
      await getReplyFromConfig(
        {
          Body: "warm runtime",
          BodyForAgent: "warm runtime",
          RawBody: "warm runtime",
          CommandBody: "warm runtime",
          From: "+1001",
          To: "+2000",
          SessionKey: "agent:main:whatsapp:+2000",
          Provider: "whatsapp",
          Surface: "whatsapp",
          ChatType: "direct",
        },
        {},
        makeReplyConfig(home) as OpenClawConfig,
      );
    });
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetReplyRuntimeMocks(agentMocks);
    setActivePluginRegistry(createTestRegistry([]));
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps old-style runtime tests fast with marked temp-home configs", async () => {
    await withTempHome(async (home) => {
      let seenPrompt: string | undefined;
      agentMocks.runEmbeddedAgent.mockImplementation(async (params) => {
        seenPrompt = params.prompt;
        return makeEmbeddedTextResult("ok");
      });

      const res = await getReplyFromConfig(
        {
          Body: "hello",
          BodyForAgent: "hello",
          RawBody: "hello",
          CommandBody: "hello",
          From: "+1001",
          To: "+2000",
          media: [
            { path: "/tmp/a.png", url: "/tmp/a.png" },
            { path: "/tmp/b.png", url: "/tmp/b.png" },
          ],
          SessionKey: "agent:main:whatsapp:+2000",
          Provider: "whatsapp",
          Surface: "whatsapp",
          ChatType: "direct",
        },
        {},
        makeReplyConfig(home) as OpenClawConfig,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(seenPrompt).toContain("[media attached: 2 files]");
      expect(seenPrompt).toContain("hello");
    });
  });

  it("handles dock on the native fast path before agent admission", async () => {
    await withTempHome(async (home) => {
      const cfg = makeReplyConfig(home) as OpenClawConfig;
      const storePath = `${home}/sessions.sqlite`;
      const sessionKey = "agent:main:telegram:123";
      cfg.session = {
        store: storePath,
        identityLinks: { alice: ["telegram:UserCase123", "discord:UserCase123"] },
      };
      const entry = {
        sessionId: "session-dock-fast-path",
        updatedAt: 1,
        delivery: {
          kind: "external",
          route: {
            channel: "telegram",
            accountId: "primary",
            target: { to: "UserCase123", chatType: "direct" },
          },
          context: { channel: "telegram", to: "UserCase123", accountId: "primary" },
          origin: {
            provider: "telegram",
            surface: "telegram",
            chatType: "direct",
            from: "telegram:UserCase123",
            to: "UserCase123",
            accountId: "primary",
          },
        },
      } satisfies SessionEntry;
      await replaceSessionEntry({ storePath, sessionKey }, entry);
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
              config: { defaultAccountId: () => "default" },
            }),
            source: "test",
          },
        ]),
      );

      const reply = await getReplyFromConfig(
        {
          Body: "/dock-discord",
          BodyForAgent: "/dock-discord",
          RawBody: "/dock-discord",
          CommandBody: "/dock-discord",
          CommandSource: "native",
          CommandAuthorized: true,
          SenderId: "UserCase123",
          From: "telegram:UserCase123",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "direct",
        },
        undefined,
        cfg,
      );

      expect(reply).toEqual({
        text: "Docked replies to discord.",
        replyToId: undefined,
        replyToCurrent: false,
      });
      expect(agentMocks.runEmbeddedAgent).not.toHaveBeenCalled();
      expect(
        projectSessionDeliveryFields(loadSessionEntry({ storePath, sessionKey })?.delivery),
      ).toMatchObject({
        lastChannel: "discord",
        lastTo: "UserCase123",
        lastAccountId: "default",
      });
    });
  });

  it("routes structured native command turns through the target session before legacy sync", async () => {
    await withTempHome(async (home) => {
      agentMocks.runEmbeddedAgent.mockResolvedValue(makeEmbeddedTextResult("ok"));

      await getReplyFromConfig(
        {
          Body: "hello",
          BodyForAgent: "hello",
          RawBody: "hello",
          CommandBody: "hello",
          CommandTurn: {
            kind: "native",
            source: "native",
            authorized: true,
          },
          CommandTargetSessionKey: "agent:main:telegram:direct:target",
          SessionKey: "telegram:slash:source",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "direct",
        },
        {},
        makeReplyConfig(home) as OpenClawConfig,
      );

      expect(agentMocks.runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:telegram:direct:target",
        }),
      );
    });
  });

  it("ignores stale native legacy source for structured normal turns before routing", async () => {
    await withTempHome(async (home) => {
      agentMocks.runEmbeddedAgent.mockResolvedValue(makeEmbeddedTextResult("ok"));

      await getReplyFromConfig(
        {
          Body: "hello",
          BodyForAgent: "hello",
          RawBody: "hello",
          CommandBody: "hello",
          CommandSource: "native",
          CommandTurn: {
            kind: "normal",
            source: "message",
            authorized: false,
          },
          CommandTargetSessionKey: "agent:main:telegram:direct:stale-target",
          SessionKey: "agent:main:telegram:direct:source",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "direct",
        },
        {},
        makeReplyConfig(home) as OpenClawConfig,
      );

      expect(agentMocks.runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:telegram:direct:source",
        }),
      );
    });
  });
});
