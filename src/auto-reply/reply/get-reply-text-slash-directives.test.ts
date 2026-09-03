import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import { buildTestCtx } from "./test-ctx.js";
import { createTypingController } from "./typing.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
});

async function resolveTextSlashDirective(body: string) {
  const storePath = path.join(tempDirs.make("openclaw-text-slash-directive-"), "sessions.json");
  const sessionKey = "agent:main:webchat:direct:user-1";
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
    Provider: "webchat",
    Surface: "webchat",
    GatewayClientScopes: ["operator.admin"],
    SessionKey: sessionKey,
  });
  const sessionEntry = { sessionId: "session-1", updatedAt: 1 };
  await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);
  const result = await resolveReplyDirectives({
    ctx,
    cfg: markCompleteReplyConfig({ session: { store: storePath } }),
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
});
