import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  createSessionEntryWithTranscript,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  appendSessionTranscriptMessageByIdentityStrict,
  appendSessionTranscriptMessagesByIdentity,
  readSessionTranscriptEvents,
  type SessionTranscriptReadParams,
} from "./session-transcript-runtime.js";

describe("guarded session transcript runtime SDK", () => {
  let state: OpenClawTestState;
  let storePath: string;

  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-sdk-transcript-", applyEnv: false });
    storePath = state.path("sessions.json");
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await state.cleanup();
  });

  describe.each([
    { name: "default main-agent store", agentId: "main", store: "default" },
    { name: "non-main agent and explicit env", agentId: "secondary", store: "env" },
    { name: "incognito store", agentId: "secondary", store: "incognito" },
    { name: "incognito store and explicit env", agentId: "secondary", store: "incognito-env" },
    {
      name: "explicit incognito store and env",
      agentId: "secondary",
      store: "incognito-env-explicit",
    },
    { name: "configured store", agentId: "secondary", store: "configured" },
    { name: "runtime snapshot store", agentId: "secondary", store: "snapshot" },
    { name: "explicit store overriding configuration", agentId: "secondary", store: "explicit" },
  ] as const)("guarded writes with $name", ({ agentId, store }) => {
    const incognito = store.startsWith("incognito");
    const explicitEnv = store === "env" || store.startsWith("incognito-env");
    const explicitStore = store === "explicit" || store === "incognito-env-explicit";
    let scope: SessionTranscriptReadParams & { config?: OpenClawConfig };
    let persistedScope: SessionTranscriptReadParams & { storePath: string };

    beforeEach(async () => {
      if (!explicitEnv) {
        state.applyEnv();
      }
      const config: OpenClawConfig | undefined =
        store === "configured" || store === "snapshot" || store === "explicit"
          ? { session: { store: state.path("configured", "{agentId}", "sessions.json") } }
          : undefined;
      if (store === "snapshot" && config) {
        setRuntimeConfigSnapshot(config);
      }
      const resolvedStorePath =
        store === "incognito-env-explicit"
          ? resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env })
          : store === "explicit"
            ? storePath
            : resolveSessionStorePathCore(config?.session?.store, { agentId, env: state.env });
      scope = {
        agentId,
        sessionId: "fresh-session",
        sessionKey: `agent:${agentId}:${incognito ? "dashboard:incognito-" : ""}fresh-session`,
        ...(explicitEnv ? { env: state.env } : {}),
        ...(config && store !== "snapshot" ? { config } : {}),
        ...(explicitStore ? { storePath: resolvedStorePath } : {}),
      };
      persistedScope = { ...scope, storePath: resolvedStorePath };
      const entry = {
        sessionId: scope.sessionId,
        updatedAt: 10,
        activeWriterRunId: "current-writer",
      };
      if (incognito && explicitEnv) {
        await upsertSessionEntryCore(persistedScope, entry);
        return;
      }
      // sessions.create uses this owner to create the row and header without an initial task.
      await expect(
        createSessionEntryWithTranscript(persistedScope, () => ({
          ok: true,
          entry,
        })),
      ).resolves.toMatchObject({ ok: true });
    });

    afterEach(() => {
      if (incognito) {
        const target = { agentId, env: state.env };
        expect(fs.existsSync(resolveOpenClawAgentSqlitePath(target))).toBe(false);
        expect(fs.existsSync(resolveIncognitoOpenClawAgentSqlitePath(target))).toBe(false);
      }
    });

    const withSupersededWriter = <T>(run: () => Promise<T>) =>
      withOwnedSessionTranscriptWrites(
        {
          sessionTarget: { ...persistedScope, expectedWriterRunId: "superseded-writer" },
          withTranscriptWrite: async (write) => await write(),
        },
        run,
      );

    it("atomically appends and idempotently replays an ordered message group", async () => {
      const messages = [
        {
          eventId: "batch-assistant",
          idempotencyLookup: "scan" as const,
          message: { role: "assistant", content: "checking", idempotencyKey: "batch:assistant" },
          now: 1_000,
        },
        {
          eventId: "batch-result",
          idempotencyLookup: "scan" as const,
          message: { role: "toolResult", content: "done", idempotencyKey: "batch:result" },
          now: 2_000,
        },
      ];

      const appended = await appendSessionTranscriptMessagesByIdentity({ ...scope, messages });
      const replayed = await appendSessionTranscriptMessagesByIdentity({ ...scope, messages });

      expect(appended.map((result) => result.appended)).toEqual([true, true]);
      expect(replayed.map((result) => result.appended)).toEqual([false, false]);
      const events = await readSessionTranscriptEvents(persistedScope);
      expect(events).toHaveLength(3);
      expect(events.slice(1)).toMatchObject([
        { id: "batch-assistant", parentId: null },
        { id: "batch-result", parentId: "batch-assistant" },
      ]);

      await expect(
        withSupersededWriter(() =>
          appendSessionTranscriptMessagesByIdentity({ ...scope, messages }),
        ),
      ).rejects.toThrow("Transcript session changed before batch append");

      await upsertSessionEntryCore(persistedScope, {
        sessionId: "replacement-session",
        updatedAt: 20,
      });
      await expect(
        appendSessionTranscriptMessagesByIdentity({ ...scope, messages }),
      ).rejects.toThrow("Transcript session changed before batch append");
      await expect(readSessionTranscriptEvents(persistedScope)).resolves.toEqual(events);
      await expect(
        readSessionTranscriptEvents({ ...persistedScope, sessionId: "replacement-session" }),
      ).resolves.toEqual([]);
    });

    it("distinguishes strict singleton results, suppression, and session rebound", async () => {
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "persisted" }],
        timestamp: 1_000,
        idempotencyKey: "strict:assistant",
      };
      await expect(
        appendSessionTranscriptMessageByIdentityStrict({ ...scope, message }),
      ).resolves.toMatchObject({ kind: "result", result: { appended: true } });

      await expect(
        appendSessionTranscriptMessageByIdentityStrict({
          ...scope,
          message: { role: "user", content: "blocked" },
          prepareMessageAfterIdempotencyCheck: () => undefined,
        }),
      ).resolves.toEqual({ kind: "suppressed" });
      const events = await readSessionTranscriptEvents(persistedScope);
      expect(events).toEqual([
        expect.objectContaining({ type: "session" }),
        expect.objectContaining({ type: "message", message }),
      ]);

      await expect(
        withSupersededWriter(() =>
          appendSessionTranscriptMessageByIdentityStrict({ ...scope, message }),
        ),
      ).resolves.toEqual({ kind: "rejected", reason: "session-rebound" });

      await upsertSessionEntryCore(persistedScope, {
        sessionId: "replacement-session",
        updatedAt: 20,
      });
      await expect(
        appendSessionTranscriptMessageByIdentityStrict({
          ...scope,
          message: { role: "assistant", content: "stale" },
        }),
      ).resolves.toEqual({ kind: "rejected", reason: "session-rebound" });
      await expect(readSessionTranscriptEvents(persistedScope)).resolves.toEqual(events);
      await expect(
        readSessionTranscriptEvents({ ...persistedScope, sessionId: "replacement-session" }),
      ).resolves.toEqual([]);
    });
  });
});
