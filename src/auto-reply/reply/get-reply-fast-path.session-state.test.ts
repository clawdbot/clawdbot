import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { MODEL_SELECTION_LOCKED_RESET_MESSAGE } from "../../sessions/model-overrides.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { buildFastReplyCommandContext, initFastReplySessionState } from "./get-reply-fast-path.js";
import { buildGetReplyCtx } from "./get-reply.test-fixtures.js";

async function seedFastPathSessionStore(
  storePath: string,
  entries: Record<string, Record<string, unknown>>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ storePath, sessionKey }, entry as unknown as SessionEntry);
  }
}

function readFastPathSessionEntry(storePath: string, sessionKey: string): Record<string, unknown> {
  return (
    (loadSessionEntry({ storePath, sessionKey }) as unknown as
      | Record<string, unknown>
      | undefined) ?? {}
  );
}

describe("get-reply fast-path session state", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("uses native command target session keys during fast bootstrap", () => {
    const storePath = "/tmp/sessions.json";
    const result = initFastReplySessionState({
      ctx: buildGetReplyCtx({
        SessionKey: "telegram:slash:123",
        CommandSource: "native",
        CommandTargetSessionKey: "agent:main:main",
      }),
      cfg: { session: { store: storePath } } as OpenClawConfig,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: "/tmp/workspace",
    });

    expect(result.sessionKey).toBe("agent:main:main");
    expect(result.sessionCtx.SessionKey).toBe("agent:main:main");
    expect(result.sessionEntry).not.toHaveProperty("sessionFile");
  });

  it("stamps trusted creation provenance during fast bootstrap", () => {
    const result = initFastReplySessionState({
      ctx: buildGetReplyCtx({
        SessionKey: "agent:main:dashboard:created",
        SessionCreation: {
          via: "operator",
          actor: { type: "human", id: "profile-ada" },
        },
      }),
      cfg: { session: { store: "/tmp/sessions.json" } } as OpenClawConfig,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: "/tmp/workspace",
    });

    expect(result.sessionEntry).toMatchObject({
      createdVia: "operator",
      createdActor: { type: "human", id: "profile-ada" },
      createdAt: expect.any(Number),
    });
  });

  it("preserves usage footer mode during fast reset bootstrap", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fast-reset-usage-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await seedFastPathSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "existing-fast-reset-usage",
        updatedAt: Date.now(),
        responseUsage: "full",
      },
    });

    const result = initFastReplySessionState({
      ctx: buildGetReplyCtx({
        Body: "/reset",
        RawBody: "/reset",
        CommandBody: "/reset",
        SessionKey: sessionKey,
      }),
      cfg: { session: { store: storePath } } as OpenClawConfig,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: home,
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.sessionEntry.responseUsage).toBe("full");
  });

  it("preserves the exact multiline reset payload during fast bootstrap", () => {
    const payload = "keep [Q3]\nline 2";
    const result = initFastReplySessionState({
      ctx: buildGetReplyCtx({
        Body: `/new ${payload}`,
        BodyForCommands: `/new ${payload}`,
        RawBody: `[Telegram id:456] İpek: /NEW: ${payload}`,
        SenderName: "İpek",
        SessionKey: "agent:main:telegram:payload",
      }),
      cfg: {
        session: { store: "/tmp/sessions.json", resetTriggers: ["/new"] },
      } as OpenClawConfig,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: "/tmp/workspace",
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.bodyStripped).toBe(payload);
    expect(result.sessionCtx.agentText).toBe(payload);
  });

  it("does not reset from a command projection when the raw projection is explicitly empty", () => {
    const result = initFastReplySessionState({
      ctx: buildGetReplyCtx({
        Body: "/new payload",
        BodyForCommands: "/new payload",
        RawBody: "",
        SessionKey: "agent:main:telegram:empty-raw",
      }),
      cfg: {
        session: { store: "/tmp/sessions.json", resetTriggers: ["/new"] },
      } as OpenClawConfig,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: "/tmp/workspace",
    });

    expect(result.resetTriggered).toBe(false);
  });

  it("preserves node provenance and lineage during fast reset bootstrap", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fast-reset-lineage-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:lineage";
    await seedFastPathSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "existing-fast-reset-lineage",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
        parentSessionKey: "agent:main:dashboard:parent",
        spawnedWorkspaceDir: "/tmp/workspace",
        spawnedCwd: "/tmp/repo",
        forkSource: { sessionKey: "agent:main:main", sessionId: "source-generation" },
        createdVia: "spawn",
        createdActor: { type: "agent", id: "agent:main:main" },
        createdAt: 1_234,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
      },
    });

    const result = initFastReplySessionState({
      ctx: buildGetReplyCtx({
        Body: "/reset",
        RawBody: "/reset",
        CommandBody: "/reset",
        SessionKey: sessionKey,
      }),
      cfg: { session: { store: storePath } } as OpenClawConfig,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: home,
    });

    expect(result.sessionEntry).toMatchObject({
      previousSessionId: "existing-fast-reset-lineage",
      spawnedBy: "agent:main:main",
      parentSessionKey: "agent:main:dashboard:parent",
      spawnedWorkspaceDir: "/tmp/workspace",
      spawnedCwd: "/tmp/repo",
      forkSource: { sessionKey: "agent:main:main", sessionId: "source-generation" },
      createdVia: "spawn",
      createdActor: { type: "agent", id: "agent:main:main" },
      createdAt: 1_234,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
    });
  });

  it("rejects a fast reset bootstrap for a model-locked session", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fast-reset-locked-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await seedFastPathSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "existing-fast-reset-locked",
        updatedAt: Date.now(),
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    });

    expect(() =>
      initFastReplySessionState({
        ctx: buildGetReplyCtx({
          Body: "/reset",
          RawBody: "/reset",
          CommandBody: "/reset",
          SessionKey: sessionKey,
        }),
        cfg: { session: { store: storePath } } as OpenClawConfig,
        agentId: "main",
        commandAuthorized: true,
        workspaceDir: home,
      }),
    ).toThrow(MODEL_SELECTION_LOCKED_RESET_MESSAGE);
    expect(readFastPathSessionEntry(storePath, sessionKey)).toMatchObject({
      sessionId: "existing-fast-reset-locked",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });
  });

  it("captures the initial SQLite session entry during fast bootstrap", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fast-initial-entry-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await seedFastPathSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "existing-fast-initial",
        updatedAt: Date.now(),
        responseUsage: "tokens",
      },
    });

    const result = initFastReplySessionState({
      ctx: buildGetReplyCtx({
        Body: "hello",
        RawBody: "hello",
        CommandBody: "hello",
        SessionKey: sessionKey,
      }),
      cfg: { session: { store: storePath } } as OpenClawConfig,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: home,
    });

    expect(result.initialSessionEntry?.sessionId).toBe("existing-fast-initial");
    expect(result.initialSessionEntry?.responseUsage).toBe("tokens");
    expect(result.initialSessionEntry).not.toBe(result.sessionEntry);
  });

  it("maps explicit gateway origin into command context", () => {
    const command = buildFastReplyCommandContext({
      ctx: buildGetReplyCtx({
        Provider: "internal",
        Surface: "internal",
        OriginatingChannel: "slack",
        OriginatingTo: "user:U123",
        From: undefined,
        To: undefined,
        SenderId: "gateway-client",
      }),
      cfg: {} as OpenClawConfig,
      sessionKey: "main",
      isGroup: false,
      triggerBodyNormalized: "/codex bind",
      commandAuthorized: true,
    });

    expect(command.channel).toBe("slack");
    expect(command.channelId).toBe("slack");
    expect(command.from).toBe("gateway-client");
    expect(command.to).toBe("user:U123");
  });

  it("preserves multiline slash skill payloads in fast command context", () => {
    const body = "/skill demo_skill first line\nsecond line";
    const command = buildFastReplyCommandContext({
      ctx: buildGetReplyCtx({
        Body: body,
        RawBody: body,
        CommandBody: body,
      }),
      cfg: {} as OpenClawConfig,
      sessionKey: "main",
      isGroup: false,
      triggerBodyNormalized: body,
      commandAuthorized: true,
    });

    expect(command.commandBodyNormalized).toBe("/skill demo_skill first line\nsecond line");
  });

  it("keeps the existing session for /reset newline soft during fast bootstrap", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fast-reset-newline-soft-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await seedFastPathSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "existing-fast-reset-newline-soft",
        updatedAt: Date.now(),
      },
    });

    const result = initFastReplySessionState({
      ctx: buildGetReplyCtx({
        Body: "/reset \nsoft",
        RawBody: "/reset \nsoft",
        CommandBody: "/reset \nsoft",
        SessionKey: sessionKey,
      }),
      cfg: { session: { store: storePath } } as OpenClawConfig,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: home,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe("existing-fast-reset-newline-soft");
  });

  it("keeps the existing session for /reset: soft during fast bootstrap", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fast-reset-colon-soft-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await seedFastPathSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "existing-fast-reset-colon-soft",
        updatedAt: Date.now(),
      },
    });

    const result = initFastReplySessionState({
      ctx: buildGetReplyCtx({
        Body: "/reset: soft",
        RawBody: "/reset: soft",
        CommandBody: "/reset: soft",
        SessionKey: sessionKey,
      }),
      cfg: { session: { store: storePath } } as OpenClawConfig,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: home,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe("existing-fast-reset-colon-soft");
  });
});
