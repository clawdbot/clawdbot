// Tests reset model selection and persisted model override cleanup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { ModelAliasIndex } from "./model-selection-directive.js";

const loadPreparedModelCatalog = vi.hoisted(() => vi.fn(async () => modelCatalog));

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalog,
}));

import { applyResetModelOverride } from "./session-reset-model.js";

const modelCatalog: ModelCatalogEntry[] = [
  { provider: "minimax", id: "m2.7", name: "M2.7" },
  { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
];

function createResetFixture(entry: Partial<SessionEntry> = {}) {
  const cfg = {} as OpenClawConfig;
  const aliasIndex: ModelAliasIndex = { byAlias: new Map(), byKey: new Map() };
  const sessionEntry: SessionEntry = {
    sessionId: "s1",
    updatedAt: Date.now(),
    delivery: { kind: "none" },
    ...entry,
  };
  return {
    cfg,
    aliasIndex,
    sessionEntry,
    sessionStore: { "agent:main:dm:1": sessionEntry } as Record<string, SessionEntry>,
    sessionCtx: { BodyStripped: "minimax summarize" },
    ctx: { ChatType: "direct" },
  };
}

async function applyResetFixture(params: {
  resetTriggered: boolean;
  sessionEntry?: Partial<SessionEntry>;
}) {
  const fixture = createResetFixture(params.sessionEntry);
  await applyResetModelOverride({
    cfg: fixture.cfg,
    resetTriggered: params.resetTriggered,
    bodyStripped: "minimax summarize",
    sessionCtx: fixture.sessionCtx,
    ctx: fixture.ctx,
    sessionEntry: fixture.sessionEntry,
    sessionStore: fixture.sessionStore,
    sessionKey: "agent:main:dm:1",
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    aliasIndex: fixture.aliasIndex,
    modelCatalog,
  });
  return fixture;
}

describe("applyResetModelOverride", () => {
  it("loads the reset catalog for the active agent owner", async () => {
    const fixture = createResetFixture();

    await applyResetModelOverride({
      cfg: fixture.cfg,
      agentId: "worker",
      agentDir: "/tmp/shared-agent",
      workspaceDir: "/tmp/shared-workspace",
      resetTriggered: true,
      bodyStripped: "minimax summarize",
      sessionCtx: fixture.sessionCtx,
      ctx: fixture.ctx,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex: fixture.aliasIndex,
    });

    expect(loadPreparedModelCatalog).toHaveBeenCalledWith({
      config: fixture.cfg,
      agentId: "worker",
      agentDir: "/tmp/shared-agent",
      workspaceDir: "/tmp/shared-workspace",
      readOnly: true,
    });
  });

  it("selects a model hint and strips it from the body", async () => {
    const { sessionEntry, sessionCtx } = await applyResetFixture({
      resetTriggered: true,
    });

    expect(sessionEntry.providerOverride).toBe("minimax");
    expect(sessionEntry.modelOverride).toBe("m2.7");
    expect(sessionCtx.BodyStripped).toBe("summarize");
  });

  it.each([
    { name: "empty catalog", catalog: [] },
    {
      name: "unrelated catalog",
      catalog: [{ provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" }],
    },
  ] satisfies Array<{ name: string; catalog: ModelCatalogEntry[] }>)(
    "honors a configured primary missing from the $name",
    async ({ catalog }) => {
      const fixture = createResetFixture({
        providerOverride: "openai",
        modelOverride: "gpt-4o-mini",
      });
      fixture.cfg.agents = {
        defaults: { model: { primary: "custom/private-model" } },
      };
      fixture.sessionCtx.BodyStripped = "custom/private-model summarize";

      const result = await applyResetModelOverride({
        cfg: fixture.cfg,
        resetTriggered: true,
        bodyStripped: fixture.sessionCtx.BodyStripped,
        sessionCtx: fixture.sessionCtx,
        ctx: fixture.ctx,
        sessionEntry: fixture.sessionEntry,
        sessionStore: fixture.sessionStore,
        sessionKey: "agent:main:dm:1",
        defaultProvider: "custom",
        defaultModel: "private-model",
        aliasIndex: fixture.aliasIndex,
        modelCatalog: catalog,
      });

      expect(result.selection).toMatchObject({
        provider: "custom",
        model: "private-model",
        isDefault: true,
      });
      expect(result.cleanedBody).toBe("summarize");
      expect(fixture.sessionCtx.BodyStripped).toBe("summarize");
      expect(fixture.sessionEntry.providerOverride).toBeUndefined();
      expect(fixture.sessionEntry.modelOverride).toBeUndefined();
    },
  );

  it("does not let the configured primary bypass an explicit model policy", async () => {
    const fixture = createResetFixture();
    fixture.cfg.agents = {
      defaults: {
        model: { primary: "custom/private-model" },
        modelPolicy: { allow: ["openai/*"] },
      },
    };
    fixture.sessionCtx.BodyStripped = "custom/private-model summarize";

    const result = await applyResetModelOverride({
      cfg: fixture.cfg,
      resetTriggered: true,
      bodyStripped: fixture.sessionCtx.BodyStripped,
      sessionCtx: fixture.sessionCtx,
      ctx: fixture.ctx,
      sessionEntry: fixture.sessionEntry,
      sessionStore: fixture.sessionStore,
      sessionKey: "agent:main:dm:1",
      defaultProvider: "custom",
      defaultModel: "private-model",
      aliasIndex: fixture.aliasIndex,
      modelCatalog,
    });

    expect(result).toEqual({});
    expect(fixture.sessionCtx.BodyStripped).toBe("custom/private-model summarize");
    expect(fixture.sessionEntry.providerOverride).toBeUndefined();
    expect(fixture.sessionEntry.modelOverride).toBeUndefined();
  });

  it("clears auth profile overrides when reset applies a model", async () => {
    const { sessionEntry } = await applyResetFixture({
      resetTriggered: true,
      sessionEntry: {
        authProfileOverride: "anthropic:default",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 2,
      },
    });

    expect(sessionEntry.authProfileOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("adopts a concurrent model winner instead of acknowledging the reset hint", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-model-race-"));
    const storePath = path.join(tempRoot, "sessions.json");
    const fixture = createResetFixture();
    const concurrentEntry: SessionEntry = {
      ...fixture.sessionEntry,
      updatedAt: fixture.sessionEntry.updatedAt + 1,
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
      modelOverrideSource: "user",
    };
    await replaceSessionEntry({ sessionKey: "agent:main:dm:1", storePath }, concurrentEntry);

    try {
      const result = await applyResetModelOverride({
        cfg: fixture.cfg,
        resetTriggered: true,
        bodyStripped: "minimax summarize",
        sessionCtx: fixture.sessionCtx,
        ctx: fixture.ctx,
        sessionEntry: fixture.sessionEntry,
        sessionStore: fixture.sessionStore,
        sessionKey: "agent:main:dm:1",
        storePath,
        defaultProvider: "openai",
        defaultModel: "gpt-4o-mini",
        aliasIndex: fixture.aliasIndex,
        modelCatalog,
      });

      expect(result.selection).toBeUndefined();
      expect(result.cleanedBody).toBe("summarize");
      expect(fixture.sessionEntry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-4o-mini",
        modelOverrideSource: "user",
      });
      expect(fixture.sessionEntry.updatedAt).toBeGreaterThanOrEqual(concurrentEntry.updatedAt);
      expect(fixture.sessionStore["agent:main:dm:1"]).toEqual(fixture.sessionEntry);
      expect(loadSessionEntry({ sessionKey: "agent:main:dm:1", storePath })).toEqual(
        fixture.sessionEntry,
      );
    } finally {
      clearSessionStoreCacheForTest();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("checks the persisted winner for an explicit same-value reset hint", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-model-race-"));
    const storePath = path.join(tempRoot, "sessions.json");
    const fixture = createResetFixture({
      providerOverride: "minimax",
      modelOverride: "m2.7",
      modelOverrideSource: "user",
    });
    const concurrentEntry: SessionEntry = {
      ...fixture.sessionEntry,
      updatedAt: fixture.sessionEntry.updatedAt + 1,
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
    };
    await replaceSessionEntry({ sessionKey: "agent:main:dm:1", storePath }, concurrentEntry);

    try {
      const result = await applyResetModelOverride({
        cfg: fixture.cfg,
        resetTriggered: true,
        bodyStripped: "minimax summarize",
        sessionCtx: fixture.sessionCtx,
        ctx: fixture.ctx,
        sessionEntry: fixture.sessionEntry,
        sessionStore: fixture.sessionStore,
        sessionKey: "agent:main:dm:1",
        storePath,
        defaultProvider: "openai",
        defaultModel: "gpt-4o-mini",
        aliasIndex: fixture.aliasIndex,
        modelCatalog,
      });

      expect(result.selection).toBeUndefined();
      expect(fixture.sessionEntry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-4o-mini",
      });
      expect(fixture.sessionStore["agent:main:dm:1"]).toEqual(fixture.sessionEntry);
    } finally {
      clearSessionStoreCacheForTest();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a reset-model hint when the session rotates during persistence", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-model-rotation-"));
    const storePath = path.join(tempRoot, "sessions.json");
    const fixture = createResetFixture();
    const rotatedEntry: SessionEntry = {
      sessionId: "s2",
      updatedAt: fixture.sessionEntry.updatedAt + 1,
      delivery: { kind: "none" },
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
      modelOverrideSource: "user",
    };
    await replaceSessionEntry({ sessionKey: "agent:main:dm:1", storePath }, rotatedEntry);

    try {
      await expect(
        applyResetModelOverride({
          cfg: fixture.cfg,
          resetTriggered: true,
          bodyStripped: "minimax summarize",
          sessionCtx: fixture.sessionCtx,
          ctx: fixture.ctx,
          sessionEntry: fixture.sessionEntry,
          sessionStore: fixture.sessionStore,
          sessionKey: "agent:main:dm:1",
          storePath,
          defaultProvider: "openai",
          defaultModel: "gpt-4o-mini",
          aliasIndex: fixture.aliasIndex,
          modelCatalog,
        }),
      ).rejects.toThrow(/changed while starting work/i);

      expect(fixture.sessionEntry.sessionId).toBe("s1");
      expect(fixture.sessionEntry.modelOverride).toBeUndefined();
      expect(fixture.sessionStore["agent:main:dm:1"]).toBe(fixture.sessionEntry);
      expect(loadSessionEntry({ sessionKey: "agent:main:dm:1", storePath })).toEqual(rotatedEntry);
    } finally {
      clearSessionStoreCacheForTest();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips when resetTriggered is false", async () => {
    const { sessionEntry, sessionCtx } = await applyResetFixture({
      resetTriggered: false,
    });

    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionCtx.BodyStripped).toBe("minimax summarize");
  });
});
