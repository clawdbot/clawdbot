import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSessionEntry, upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildBuiltinChatCommands } from "../commands-registry.shared.js";
import { takeCommandSessionMetadataChanges } from "./command-session-metadata.js";
import { handleNameCommand } from "./commands-name.js";
import type { HandleCommandsParams } from "./commands-types.js";

const sessionKey = "agent:main:web:main";
let tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

async function createStorePath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-name-command-"));
  tempRoots.push(root);
  return path.join(root, "sessions.json");
}

function buildNameParams(
  commandBodyNormalized: string,
  storePath: string,
  overrides: { isAuthorizedSender?: boolean; commandSource?: string; sessionKey?: string } = {},
): HandleCommandsParams {
  const activeSessionKey = overrides.sessionKey ?? sessionKey;
  return {
    cfg: {} as OpenClawConfig,
    ctx: {
      Provider: "web",
      Surface: "web",
      CommandSource: overrides.commandSource ?? "text",
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: overrides.isAuthorizedSender ?? true,
      senderIsOwner: true,
      senderId: "tester",
      channel: "web",
      channelId: "web",
      surface: "web",
      ownerList: [],
      rawBodyNormalized: commandBodyNormalized,
    },
    directives: {},
    sessionStore: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: activeSessionKey,
    storePath,
    workspaceDir: "/tmp",
    provider: "openai",
    model: "gpt-5.5",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

describe("name command", () => {
  it("registers and loads the command on text and native surfaces", () => {
    const command = buildBuiltinChatCommands().find((entry) => entry.key === "name");

    expect(command).toMatchObject({
      nativeName: "name",
      textAliases: ["/name"],
      acceptsArgs: true,
      scope: "both",
      category: "session",
    });
    expect(command?.args).toEqual([
      expect.objectContaining({
        name: "title",
        captureRemaining: true,
      }),
    ]);
  });

  it("renames the current session and persists the label", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey },
      { sessionId: "sess-main", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );

    const params = buildNameParams("/name Billing rework", storePath);
    const result = await handleNameCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Billing rework");
    expect(loadSessionEntry({ storePath, sessionKey })?.label).toBe("Billing rework");
    expect(params.sessionEntry?.label).toBe("Billing rework");
    expect(takeCommandSessionMetadataChanges(params.ctx)).toEqual([
      { sessionKey, reason: "command-metadata" },
    ]);
  });

  it("suggests a name without mutating when no argument is given", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey },
      { sessionId: "sess-main", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );

    const params = buildNameParams("/name", storePath);
    params.sessionEntry = loadSessionEntry({ storePath, sessionKey });
    const result = await handleNameCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Use /name <title>");
    expect(loadSessionEntry({ storePath, sessionKey })?.label).toBeUndefined();
    expect(takeCommandSessionMetadataChanges(params.ctx)).toBeUndefined();
  });

  it("rejects a label already used by another session", async () => {
    const storePath = await createStorePath();
    const now = Date.now();
    await upsertSessionEntry(
      { storePath, sessionKey },
      { sessionId: "sess-main", updatedAt: now, totalTokens: 0, totalTokensFresh: true },
    );
    await upsertSessionEntry(
      { storePath, sessionKey: "agent:main:web:other" },
      {
        sessionId: "sess-other",
        updatedAt: now,
        totalTokens: 0,
        totalTokensFresh: true,
        label: "Taken",
      },
    );

    const params = buildNameParams("/name Taken", storePath);
    const result = await handleNameCommand(params, true);

    expect(result?.reply?.text).toContain("label already in use");
    expect(loadSessionEntry({ storePath, sessionKey })?.label).toBeUndefined();
    expect(takeCommandSessionMetadataChanges(params.ctx)).toBeUndefined();
  });

  it("reads the persisted name when params.sessionEntry is absent", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: "sess-main",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
        label: "Billing rework",
        displayName: "Dashboard session",
      },
    );

    const params = buildNameParams("/name", storePath);
    const result = await handleNameCommand(params, true);

    expect(result?.reply?.text).toContain("Current session name: Billing rework");
    expect(result?.reply?.text).toContain("Suggested name: Dashboard session");
  });

  it("seeds a brand-new native session entry that is not yet persisted", async () => {
    const storePath = await createStorePath();
    const params = buildNameParams("/name First native", storePath, { commandSource: "slash" });
    // Native slash sessions hand the handler an in-memory entry that the fast
    // path has not written to the store yet. The rename must seed it instead of
    // reporting "no active session to name".
    params.sessionEntry = {
      sessionId: "sess-native",
      updatedAt: 1,
      totalTokens: 0,
      totalTokensFresh: true,
    };

    const result = await handleNameCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("First native");
    expect(loadSessionEntry({ storePath, sessionKey })?.label).toBe("First native");
    expect(params.sessionEntry?.label).toBe("First native");
    expect(takeCommandSessionMetadataChanges(params.ctx)).toEqual([
      { sessionKey, reason: "command-metadata" },
    ]);
  });

  it("does not rename for an unauthorized sender", async () => {
    const storePath = await createStorePath();
    await upsertSessionEntry(
      { storePath, sessionKey },
      { sessionId: "sess-main", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    );

    const params = buildNameParams("/name Secret", storePath, { isAuthorizedSender: false });
    const result = await handleNameCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(loadSessionEntry({ storePath, sessionKey })?.label).toBeUndefined();
    expect(takeCommandSessionMetadataChanges(params.ctx)).toBeUndefined();
  });

  it("ignores other commands and disabled text commands", async () => {
    const storePath = await createStorePath();
    const params = buildNameParams("/name Anything", storePath);
    expect(await handleNameCommand(params, false)).toBeNull();
    expect(await handleNameCommand(buildNameParams("/goal status", storePath), true)).toBeNull();
  });
});
