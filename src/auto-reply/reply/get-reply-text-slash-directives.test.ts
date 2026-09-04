import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import { buildTestCtx } from "./test-ctx.js";
import { createTypingController } from "./typing.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
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
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

async function resolveTextSlashDirective(
  body: string,
  options?: { botUsername?: string; commandsText?: boolean; surface?: string },
) {
  const storePath = path.join(tempDirs.make("openclaw-text-slash-directive-"), "sessions.json");
  const surface = options?.surface ?? "webchat";
  const sessionKey = `agent:main:${surface}:direct:user-1`;
  const ctx = buildTestCtx({
    Body: body,
    BodyForAgent: body,
    CommandBody: body,
    CommandSource: "text",
    CommandAuthorized: true,
    CommandTurn: {
      kind: "text-slash",
      source: "text",
      authorized: true,
      commandName: body.slice(1).split(/\s+/, 1)[0],
      body,
    },
    Provider: surface,
    Surface: surface,
    BotUsername: options?.botUsername,
    GatewayClientScopes: ["operator.admin"],
    SessionKey: sessionKey,
  });
  const sessionEntry = { sessionId: "session-1", updatedAt: 1 };
  await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);
  const result = await resolveReplyDirectives({
    ctx,
    cfg: markCompleteReplyConfig({
      session: { store: storePath },
      commands: options?.commandsText === undefined ? undefined : { text: options.commandsText },
    }),
    agentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    agentCfg: {},
    sessionCtx: ctx,
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    sessionKey,
    storePath,
    sessionScope: "per-sender",
    groupResolution: undefined,
    isGroup: false,
    triggerBodyNormalized: body,
    resetTriggered: false,
    commandAuthorized: true,
    defaultProvider: "openai",
    defaultModel: "gpt-5.5",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
    provider: "openai",
    model: "gpt-5.5",
    hasResolvedHeartbeatModelOverride: false,
    typing: createTypingController({}),
  });
  return { result, sessionKey, storePath };
}

describe("text slash directive ownership", () => {
  it("rejects positional exec arguments instead of sending them to the model", async () => {
    const { result } = await resolveTextSlashDirective("/exec gateway");

    expect(result).toMatchObject({
      kind: "reply",
      reply: { text: 'Unexpected argument "gateway" for /exec.' },
    });
  });

  it("preserves canonical exec key/value arguments", async () => {
    const { result, sessionKey, storePath } = await resolveTextSlashDirective("/exec host=gateway");

    expect(result).toMatchObject({
      kind: "reply",
      reply: { text: expect.stringContaining("Exec defaults set (host=gateway).") },
    });
    expect(loadExactSessionEntry({ sessionKey, storePath })?.entry.execHost).toBe("gateway");
  });

  it("rejects positional exec arguments addressed to the current bot", async () => {
    const { result } = await resolveTextSlashDirective("/exec@openclaw gateway", {
      botUsername: "openclaw",
    });

    expect(result).toMatchObject({
      kind: "reply",
      reply: { text: 'Unexpected argument "gateway" for /exec.' },
    });
  });

  it("preserves text exec commands when text routing is disabled on a native surface", async () => {
    const body = "/exec host=gateway";
    const { result, sessionKey, storePath } = await resolveTextSlashDirective(body, {
      commandsText: false,
      surface: "discord",
    });

    expect(result).toMatchObject({ kind: "continue", result: { cleanedBody: body } });
    expect(loadExactSessionEntry({ sessionKey, storePath })?.entry.execHost).toBeUndefined();
  });
});
