import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { retainLegacyDefaultAgentId } from "../legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { loadTranscriptEvents, replaceSessionEntry } from "./session-accessor.js";
import { persistSessionTranscriptTurn } from "./session-accessor.transcript-turn.js";

describe("transcript turn logical ownership", () => {
  it("rejects a bare-key write for an ownerless explicit fleet", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = {
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
        session: { store: storePath },
      } satisfies OpenClawConfig;

      await expect(
        persistSessionTranscriptTurn(
          {
            sessionId: "ownerless-transcript-session",
            sessionKey: "main",
            storePath,
          },
          {
            config: cfg,
            messages: [{ message: { role: "user", content: "must not be attributed" } }],
            updateMode: "none",
          },
        ),
      ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
    });
  });

  it("attributes a bare-key write to the retained compatibility owner", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = retainLegacyDefaultAgentId(
        {
          agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
          session: { store: storePath },
        },
        "ops",
      );
      const scope = {
        sessionId: "retained-owner-transcript-session",
        sessionKey: "main",
        storePath,
      };
      await replaceSessionEntry(
        { agentId: "ops", sessionKey: scope.sessionKey, storePath },
        { sessionId: scope.sessionId, updatedAt: 1 },
      );

      await expect(
        persistSessionTranscriptTurn(scope, {
          config: cfg,
          messages: [{ message: { role: "user", content: "retained owner" } }],
          updateMode: "none",
        }),
      ).resolves.toMatchObject({ appendedCount: 1 });
      await expect(loadTranscriptEvents({ ...scope, agentId: "ops" })).resolves.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ content: "retained owner", role: "user" }),
          type: "message",
        }),
      );
    });
  });

  it("rejects a conflicting scope agent for a persisted fixed-store owner", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = {
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
        session: { store: storePath },
      } satisfies OpenClawConfig;
      const scope = {
        agentId: "research",
        sessionId: "persisted-owner-transcript-session",
        sessionKey: "global",
        storePath,
      };

      await expect(
        persistSessionTranscriptTurn(scope, {
          config: cfg,
          messages: [{ message: { role: "user", content: "wrong owner" } }],
          updateMode: "none",
        }),
      ).rejects.toBeInstanceOf(AgentSelectionRequiredError);

      await replaceSessionEntry(
        { agentId: "ops", sessionKey: scope.sessionKey, storePath },
        { sessionId: scope.sessionId, updatedAt: 1 },
      );
      await expect(
        persistSessionTranscriptTurn(
          { ...scope, agentId: "ops" },
          {
            config: cfg,
            messages: [{ message: { role: "user", content: "right owner" } }],
            updateMode: "none",
          },
        ),
      ).resolves.toMatchObject({ appendedCount: 1 });
    });
  });

  it("rejects a bare-key write for a retired persisted owner", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = {
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "retired" } },
          entries: { ops: {}, research: {} },
        },
        session: { store: storePath },
      } satisfies OpenClawConfig;

      await expect(
        persistSessionTranscriptTurn(
          {
            sessionId: "retired-owner-transcript-session",
            sessionKey: "global",
            storePath,
          },
          {
            config: cfg,
            messages: [{ message: { role: "user", content: "retired owner" } }],
            updateMode: "none",
          },
        ),
      ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
    });
  });

  it("allows an explicit agent write to a different per-agent store", async () => {
    await withTempHome(async (home) => {
      const fixedStorePath = path.join(home, "shared-sessions.json");
      const researchStorePath = path.join(home, "research-sessions.json");
      const cfg = {
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
        session: { store: fixedStorePath },
      } satisfies OpenClawConfig;
      const scope = {
        agentId: "research",
        sessionId: "research-global-session",
        sessionKey: "global",
        storePath: researchStorePath,
      };
      await replaceSessionEntry(
        { agentId: "research", sessionKey: scope.sessionKey, storePath: researchStorePath },
        { sessionId: scope.sessionId, updatedAt: 1 },
      );

      await expect(
        persistSessionTranscriptTurn(scope, {
          config: cfg,
          expectedSessionId: scope.sessionId,
          messages: [{ message: { role: "user", content: "research store" } }],
          updateMode: "none",
        }),
      ).resolves.toMatchObject({ appendedCount: 1 });
      await expect(loadTranscriptEvents({ ...scope, agentId: "research" })).resolves.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ content: "research store", role: "user" }),
          type: "message",
        }),
      );
    });
  });

  it.each([false, true])(
    "completes a pathless injected write before a later failure: %s",
    async (failSecondAppend) => {
      await withTempHome(async (home) => {
        const configuredStorePath = path.join(home, "shared-sessions.json");
        const sessionEntry = { sessionId: "injected-research", updatedAt: 1 };
        const sessionStore = { global: sessionEntry };
        const cfg = {
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "ops" } },
            entries: { ops: {}, research: {} },
          },
          session: { store: configuredStorePath },
        } satisfies OpenClawConfig;

        const completed: string[] = [];
        const turn = persistSessionTranscriptTurn(
          {
            agentId: "research",
            sessionId: sessionEntry.sessionId,
            sessionKey: "global",
            sessionStore,
          },
          {
            config: cfg,
            messages: [
              {
                eventId: "injected-first",
                message: { role: "user", content: "injected research" },
              },
              ...(failSecondAppend
                ? [
                    {
                      message: { role: "user", content: "cannot commit" },
                      prepareMessageAfterIdempotencyCheck: () => {
                        throw new Error("second append failed");
                      },
                    },
                  ]
                : []),
            ],
            onMessageCommitted: (messageId) => {
              completed.push(messageId);
            },
            updateMode: "none",
          },
        );
        if (failSecondAppend) {
          await expect(turn).rejects.toThrow("second append failed");
        } else {
          await expect(turn).resolves.toMatchObject({ appendedCount: 1 });
        }
        expect(completed).toEqual(["injected-first"]);
        expect(
          await loadTranscriptEvents({
            agentId: "research",
            sessionId: sessionEntry.sessionId,
            sessionKey: "global",
            storePath: configuredStorePath,
          }),
        ).toContainEqual(expect.objectContaining({ id: "injected-first" }));
      });
    },
  );

  it("keeps a pathless injected session store ownerless without an explicit agent", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
        session: { store: path.join(home, "shared-sessions.json") },
      } satisfies OpenClawConfig;

      await expect(
        persistSessionTranscriptTurn(
          {
            sessionId: "injected-ownerless",
            sessionKey: "global",
            sessionStore: { global: { sessionId: "injected-ownerless", updatedAt: 1 } },
          },
          {
            config: cfg,
            messages: [{ message: { role: "user", content: "must select" } }],
            updateMode: "none",
          },
        ),
      ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
    });
  });

  it.runIf(process.platform !== "win32")(
    "treats a symlink alias as the configured owned fixed store",
    async () => {
      await withTempHome(async (home) => {
        const fixedStorePath = path.join(home, "shared-store.sqlite");
        const aliasStorePath = path.join(home, "shared-store-alias.sqlite");
        await fs.writeFile(fixedStorePath, "");
        await fs.symlink(fixedStorePath, aliasStorePath);
        const cfg = {
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "ops" } },
            entries: { ops: {}, research: {} },
          },
          session: { store: fixedStorePath },
        } satisfies OpenClawConfig;

        await expect(
          persistSessionTranscriptTurn(
            {
              agentId: "research",
              sessionId: "aliased-store-session",
              sessionKey: "global",
              storePath: aliasStorePath,
            },
            {
              config: cfg,
              messages: [{ message: { role: "user", content: "wrong owner" } }],
              updateMode: "none",
            },
          ),
        ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
      });
    },
  );
});
