import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { MoltbotConfig } from "../config/config.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createIMessageTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  extractHookToken,
  normalizeAgentPayload,
  normalizeWakePayload,
  resolveHooksConfig,
} from "./hooks.js";

describe("gateway hooks helpers", () => {
  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });
  test("resolveHooksConfig normalizes paths + requires token", () => {
    const base = {
      hooks: {
        enabled: true,
        token: "secret",
        path: "hooks///",
      },
    } as MoltbotConfig;
    const resolved = resolveHooksConfig(base);
    expect(resolved?.basePath).toBe("/hooks");
    expect(resolved?.token).toBe("secret");
  });

  test("resolveHooksConfig rejects root path", () => {
    const cfg = {
      hooks: { enabled: true, token: "x", path: "/" },
    } as MoltbotConfig;
    expect(() => resolveHooksConfig(cfg)).toThrow("hooks.path may not be '/'");
  });

  test("extractHookToken prefers bearer > header > query", () => {
    const req = {
      headers: {
        authorization: "Bearer top",
        "x-moltbot-token": "header",
      },
    } as unknown as IncomingMessage;
    const url = new URL("http://localhost/hooks/wake?token=query");
    const result1 = extractHookToken(req, url);
    expect(result1.token).toBe("top");
    expect(result1.fromQuery).toBe(false);

    const req2 = {
      headers: { "x-moltbot-token": "header" },
    } as unknown as IncomingMessage;
    const result2 = extractHookToken(req2, url);
    expect(result2.token).toBe("header");
    expect(result2.fromQuery).toBe(false);

    const req3 = { headers: {} } as unknown as IncomingMessage;
    const result3 = extractHookToken(req3, url);
    expect(result3.token).toBe("query");
    expect(result3.fromQuery).toBe(true);
  });

  test("normalizeWakePayload trims + validates", () => {
    expect(normalizeWakePayload({ text: "  hi " })).toEqual({
      ok: true,
      value: { text: "hi", mode: "now" },
    });
    expect(normalizeWakePayload({ text: "  ", mode: "now" }).ok).toBe(false);
  });

  test("normalizeAgentPayload defaults + validates channel", () => {
    const ok = normalizeAgentPayload({ message: "hello" }, { idFactory: () => "fixed" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.sessionKey).toBe("hook:fixed");
      expect(ok.value.channel).toBe("last");
      expect(ok.value.name).toBe("Hook");
      expect(ok.value.deliver).toBe(true);
    }

    const explicitNoDeliver = normalizeAgentPayload(
      { message: "hello", deliver: false },
      { idFactory: () => "fixed" },
    );
    expect(explicitNoDeliver.ok).toBe(true);
    if (explicitNoDeliver.ok) {
      expect(explicitNoDeliver.value.deliver).toBe(false);
    }

    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: createIMessageTestPlugin(),
        },
      ]),
    );
    const imsg = normalizeAgentPayload(
      { message: "yo", channel: "imsg" },
      { idFactory: () => "x" },
    );
    expect(imsg.ok).toBe(true);
    if (imsg.ok) {
      expect(imsg.value.channel).toBe("imessage");
    }

    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "msteams",
          source: "test",
          plugin: createMSTeamsPlugin({ aliases: ["teams"] }),
        },
      ]),
    );
    const teams = normalizeAgentPayload(
      { message: "yo", channel: "teams" },
      { idFactory: () => "x" },
    );
    expect(teams.ok).toBe(true);
    if (teams.ok) {
      expect(teams.value.channel).toBe("msteams");
    }

    const bad = normalizeAgentPayload({ message: "yo", channel: "sms" });
    expect(bad.ok).toBe(false);
  });
});

const emptyRegistry = createTestRegistry([]);

const createMSTeamsPlugin = (params: { aliases?: string[] }): ChannelPlugin => ({
  id: "msteams",
  meta: {
    id: "msteams",
    label: "Microsoft Teams",
    selectionLabel: "Microsoft Teams (Bot Framework)",
    docsPath: "/channels/msteams",
    blurb: "Bot Framework; enterprise support.",
    aliases: params.aliases,
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => ({}),
  },
});
