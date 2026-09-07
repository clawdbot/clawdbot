import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/io.js";
import {
  loadTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
} from "../config/sessions/session-accessor.js";
import {
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "../config/sessions/session-transcript-read-fence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { withCodexSessionTranscriptMirrorWriteLock } from "./codex-session-transcript-runtime.js";
import { getSessionEntry, upsertSessionEntry } from "./session-store-runtime.js";
import {
  appendAssistantMirrorMessageByIdentity,
  appendSessionTranscriptMessageByIdentity,
  publishSessionTranscriptUpdateByIdentity,
  readLatestAssistantTextByIdentity,
  readSessionTranscriptEvents,
  readSessionTranscriptRawDelta,
  readSessionTranscriptVisibleMessageDelta,
  readVisibleSessionTranscriptMessageEntries,
  resolveSessionTranscriptIdentity,
  resolveSessionTranscriptTarget,
  withSessionTranscriptWriteLock,
  type SessionTranscriptMessageEntry,
  type SessionTranscriptReadParams,
} from "./session-transcript-runtime.js";
import { withTempHome } from "./test-env.js";

const identity = {
  agentId: "main",
  sessionId: "configured-store-session",
  sessionKey: "agent:main:configured-store",
};
const configuredText = "Message from the configured store";
const defaultText = "Competing message with the same session id";
const appendedText = "Appended through the SDK";

function messageContents(events: readonly unknown[]): unknown[] {
  return events.flatMap((event) => {
    const record = event as { type?: unknown; message?: { content?: unknown } };
    return record.type === "message" ? [record.message?.content] : [];
  });
}

function assistantEntryContents(entries: readonly SessionTranscriptMessageEntry[]): unknown[] {
  return entries.map(({ message }) => {
    if (message.role !== "assistant") {
      throw new Error(`Expected assistant transcript entry, got ${message.role}`);
    }
    return message.content;
  });
}

async function seedTranscript(scope: SessionTranscriptReadParams, content: string) {
  await upsertSessionEntry({
    ...scope,
    entry: { sessionId: scope.sessionId, updatedAt: 1 },
  });
  await appendSessionTranscriptMessageByIdentity({
    ...scope,
    message: { role: "assistant", content, timestamp: 1 },
  });
}

async function withConfiguredStores(
  run: (stores: {
    configured: SessionTranscriptReadParams;
    competing: SessionTranscriptReadParams;
    defaultDatabasePath: string;
  }) => Promise<void>,
  seedCompeting = true,
) {
  await withTempHome(
    async (home) => {
      const stateDir = path.join(fs.realpathSync(home), ".openclaw");
      const configured = { ...identity, storePath: path.join(stateDir, "custom", "sessions.json") };
      const competing = {
        ...identity,
        storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
      };
      const config = { session: { store: configured.storePath }, plugins: { enabled: false } };
      const previous = getRuntimeConfigSnapshot();
      const previousSource = getRuntimeConfigSourceSnapshot();
      fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
      setRuntimeConfigSnapshot(config);
      try {
        await seedTranscript(configured, configuredText);
        if (seedCompeting) {
          await seedTranscript(competing, defaultText);
        }
        await run({
          configured,
          competing,
          defaultDatabasePath: path.join(
            stateDir,
            "agents",
            "main",
            "agent",
            "openclaw-agent.sqlite",
          ),
        });
      } finally {
        if (previous) {
          setRuntimeConfigSnapshot(previous, previousSource ?? undefined);
        } else {
          clearRuntimeConfigSnapshot();
        }
      }
    },
    {
      prefix: "openclaw-sdk-configured-store-",
      env: { OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json") },
    },
  );
}

const readers: Array<{
  name: string;
  read: (scope: SessionTranscriptReadParams) => Promise<unknown[]>;
}> = [
  {
    name: "events",
    read: async (scope) => messageContents(await readSessionTranscriptEvents(scope)),
  },
  {
    name: "raw delta",
    read: async (scope) => {
      const page = await readSessionTranscriptRawDelta({
        ...scope,
        maxEvents: 10,
        maxBytes: 10_000,
      });
      expect(page.kind).toBe("page");
      return page.kind === "page" ? messageContents(page.events.map((row) => row.event)) : [];
    },
  },
  {
    name: "visible entries",
    read: async (scope) =>
      assistantEntryContents(await readVisibleSessionTranscriptMessageEntries(scope)),
  },
  {
    name: "visible delta",
    read: async (scope) => {
      const page = await readSessionTranscriptVisibleMessageDelta({
        ...scope,
        maxMessages: 10,
        maxBytes: 10_000,
      });
      expect(page.kind).toBe("page");
      return page.kind === "page" ? assistantEntryContents(page.entries) : [];
    },
  },
  {
    name: "latest assistant",
    read: async (scope) => [(await readLatestAssistantTextByIdentity(scope))?.text],
  },
];

const writers: Array<{
  name: string;
  contents: unknown[];
  write: (
    scope: SessionTranscriptReadParams & { config?: OpenClawConfig },
    priorContent: string,
  ) => Promise<void>;
}> = [
  {
    name: "direct single append",
    contents: [appendedText],
    write: async (scope) => {
      await expect(
        appendSessionTranscriptMessageByIdentity({
          ...scope,
          message: { role: "assistant", content: appendedText },
        }),
      ).resolves.toMatchObject({ appended: true });
    },
  },
  {
    name: "projected lock append",
    contents: [appendedText],
    write: async (scope, priorContent) => {
      await withSessionTranscriptWriteLock(scope, async (locked) => {
        expect.soft(messageContents(await locked.readEvents())).toEqual([priorContent]);
        await expect(
          locked.appendMessage({
            message: { role: "assistant", content: appendedText },
          }),
        ).resolves.toMatchObject({ appended: true });
        expect
          .soft(messageContents(await locked.readEvents()))
          .toEqual([priorContent, appendedText]);
      });
    },
  },
  {
    name: "assistant mirror append",
    contents: [[{ type: "text", text: appendedText }]],
    write: async (scope) => {
      await expect(
        appendAssistantMirrorMessageByIdentity({
          ...scope,
          text: appendedText,
          updateMode: "none",
        }),
      ).resolves.toMatchObject({ ok: true });
    },
  },
];

describe("configured SDK transcript store parity", () => {
  it.each(readers)(
    "routes $name reads and projected identities to the configured store",
    async ({ read }) => {
      await withConfiguredStores(async ({ configured, competing }) => {
        // Explicit reads prove both stores really contain distinct transcripts for the same id.
        expect(await read(configured)).toEqual([configuredText]);
        expect(await read(competing)).toEqual([defaultText]);
        const projectedIdentity = await resolveSessionTranscriptIdentity(identity);
        const projectedTarget = await resolveSessionTranscriptTarget(identity);
        expect(projectedIdentity).not.toHaveProperty("storePath");
        expect(projectedTarget).not.toHaveProperty("storePath");
        for (const target of [identity, projectedIdentity, projectedTarget]) {
          expect.soft(await read(target)).toEqual([configuredText]);
        }
        expect(await read({ ...projectedIdentity, storePath: competing.storePath })).toEqual([
          defaultText,
        ]);
      });
    },
  );

  describe.each(["configured", "supplied config", "explicit override"] as const)(
    "%s writes",
    (route) => {
      it.each(writers)("keeps $name in its selected store", async ({ write, contents }) => {
        await withConfiguredStores(async ({ configured, competing }) => {
          const override = route === "explicit override";
          if (route === "supplied config") {
            setRuntimeConfigSnapshot({ session: { store: competing.storePath } });
          }
          const target = override
            ? competing
            : {
                ...identity,
                ...(route === "supplied config"
                  ? { config: { session: { store: configured.storePath } } }
                  : {}),
              };
          await write(target, override ? defaultText : configuredText);
          expect
            .soft(messageContents(await readSessionTranscriptEvents(configured)))
            .toEqual([configuredText, ...(override ? [] : contents)]);
          expect
            .soft(messageContents(await readSessionTranscriptEvents(competing)))
            .toEqual([defaultText, ...(override ? contents : [])]);
        });
      });
    },
  );

  it.each([
    { name: "public", lock: withSessionTranscriptWriteLock },
    { name: "private mirror", lock: withCodexSessionTranscriptMirrorWriteLock },
  ])("pins $name lock access and publication across an awaited config change", async ({ lock }) => {
    await withConfiguredStores(async ({ configured, competing }) => {
      const internalUpdates: InternalSessionTranscriptUpdate[] = [];
      const publicUpdates: SessionTranscriptUpdate[] = [];
      const offInternal = onInternalSessionTranscriptUpdate((update) =>
        internalUpdates.push(update),
      );
      const offPublic = onSessionTranscriptUpdate((update) => publicUpdates.push(update));
      // Explicit env must survive target projection, including the post-callback publisher.
      const env = { ...process.env };
      try {
        await lock({ ...identity, env }, async (locked) => {
          expect(locked.target).not.toHaveProperty("storePath");
          expect.soft(messageContents(await locked.readEvents())).toEqual([configuredText]);
          await Promise.resolve();
          setRuntimeConfigSnapshot({ session: { store: competing.storePath } });
          const appended = await locked.appendMessage({
            message: { role: "assistant", content: appendedText, idempotencyKey: "pinned-message" },
          });
          expect
            .soft(messageContents(await locked.readEvents()))
            .toEqual([configuredText, appendedText]);
          await locked.publishUpdate({ messageId: appended?.messageId });
          expect(internalUpdates).toEqual([]);
        });
        expect(internalUpdates).toMatchObject([
          {
            target: {
              ...identity,
              storePath: resolveSessionTranscriptDatabasePath({
                ...configured,
                agentId: "main",
                storePath: configured.storePath!,
              }),
            },
          },
        ]);
        expect(publicUpdates).toHaveLength(1);
        expect(publicUpdates[0]?.target).toEqual(identity);
        expect(messageContents(await readSessionTranscriptEvents(competing))).toEqual([
          defaultText,
        ]);
        expect(messageContents(await readSessionTranscriptEvents(configured))).toEqual([
          configuredText,
          appendedText,
        ]);
      } finally {
        offInternal();
        offPublic();
      }
    });
  });

  it("pins private mirror facts and committed message sequences to the configured store", async () => {
    await withConfiguredStores(async ({ configured, competing }) => {
      await withCodexSessionTranscriptMirrorWriteLock(identity, async (locked) => {
        await Promise.resolve();
        setRuntimeConfigSnapshot({ session: { store: competing.storePath } });
        const appended = await locked.appendMessageWithMessageSequence({
          message: { role: "assistant", content: appendedText, idempotencyKey: "mirror-pinned" },
        });
        expect.soft(appended).toMatchObject({ messageSeq: 2, result: { appended: true } });
        const facts = await locked.readMessageFacts({ idempotencyKeys: ["mirror-pinned"] });
        expect(facts.existingIdempotencyKeys).toEqual(new Set(["mirror-pinned"]));
        expect(facts.messagesByIdempotencyKey.get("mirror-pinned")).toMatchObject({
          content: appendedText,
        });
      });
      expect
        .soft(messageContents(await readSessionTranscriptEvents(configured)))
        .toEqual([configuredText, appendedText]);
      expect
        .soft(messageContents(await readSessionTranscriptEvents(competing)))
        .toEqual([defaultText]);
    });
  });

  it.each(["configured", "explicit override", "assistant mirror"])(
    "publishes the selected physical store for %s",
    async (route) => {
      await withConfiguredStores(async ({ configured, competing }) => {
        const updates: InternalSessionTranscriptUpdate[] = [];
        const off = onInternalSessionTranscriptUpdate((update) => updates.push(update));
        const selected = route === "explicit override" ? competing : configured;
        try {
          if (route === "assistant mirror") {
            await appendAssistantMirrorMessageByIdentity({ ...identity, text: appendedText });
          } else {
            await publishSessionTranscriptUpdateByIdentity(
              route === "explicit override" ? competing : identity,
            );
          }
          expect(updates).toMatchObject([
            {
              target: {
                ...identity,
                storePath: resolveSessionTranscriptDatabasePath({
                  ...selected,
                  agentId: "main",
                  storePath: selected.storePath!,
                }),
              },
            },
          ]);
        } finally {
          off();
        }
      });
    },
  );

  it("leaves raw default-scoped reads in the default database under configured runtime storage", async () => {
    await withConfiguredStores(async () => {
      expect(
        messageContents(loadTranscriptEventsSync({ ...identity, env: { ...process.env } })),
      ).toEqual([defaultText]);
    });
  });

  it("preserves exact read-fence keys instead of remapping a mismatched key by session id", async () => {
    await withConfiguredStores(async ({ configured, competing }) => {
      const admitted = await appendSessionTranscriptMessageByIdentity({
        ...configured,
        message: { role: "user", content: "admitted turn" },
      });
      if (!admitted?.anchor) {
        throw new Error("expected admission anchor");
      }
      const receipt = {
        ...admitted.anchor,
        logicalTurnId: "configured-read-fence",
        role: "user" as const,
      };
      await runWithSessionTranscriptReadFence(receipt, async () => {
        for (const { read } of readers) {
          expect.soft(await read(identity)).toEqual([configuredText]);
          await expect(
            read({ ...identity, sessionKey: "agent:main:wrong-key" }),
          ).rejects.toBeInstanceOf(SessionTranscriptReadFenceError);
          await expect(read(competing)).rejects.toBeInstanceOf(SessionTranscriptReadFenceError);
        }
      });
    });
  });

  it("keeps non-strict transcript-only writes and rejects reassignment to another key", async () => {
    await withConfiguredStores(async ({ configured }) => {
      const transcriptOnly = {
        ...identity,
        sessionId: "transcript-only",
        sessionKey: "agent:main:transcript-only",
      };
      await appendSessionTranscriptMessageByIdentity({
        ...transcriptOnly,
        message: { role: "assistant", content: appendedText },
      });
      expect(
        messageContents(
          await readSessionTranscriptEvents({ ...transcriptOnly, storePath: configured.storePath }),
        ),
      ).toEqual([appendedText]);
      expect(
        getSessionEntry({ ...transcriptOnly, storePath: configured.storePath }),
      ).toBeUndefined();
      await expect(
        appendSessionTranscriptMessageByIdentity({
          ...configured,
          sessionKey: "agent:main:wrong-owner",
          message: { role: "assistant", content: "must reject" },
        }),
      ).rejects.toThrow("is owned by");
    });
  });

  it("does not materialize or pollute a default database for an omitted-path read and append", async () => {
    await withConfiguredStores(async ({ configured, competing, defaultDatabasePath }) => {
      expect(fs.existsSync(defaultDatabasePath)).toBe(false);
      const projected = await resolveSessionTranscriptIdentity(identity);
      expect(projected).not.toHaveProperty("storePath");
      expect
        .soft(messageContents(await readSessionTranscriptEvents(projected)))
        .toEqual([configuredText]);
      await appendSessionTranscriptMessageByIdentity({
        ...projected,
        message: { role: "assistant", content: appendedText },
      });
      expect.soft(fs.existsSync(defaultDatabasePath)).toBe(false);
      expect
        .soft(messageContents(await readSessionTranscriptEvents(configured)))
        .toEqual([configuredText, appendedText]);
      expect.soft(messageContents(await readSessionTranscriptEvents(competing))).toEqual([]);
      expect(getSessionEntry(competing)).toBeUndefined();
    }, false);
  });

  it("keeps incognito transcripts off both durable stores despite explicit overrides", async () => {
    await withConfiguredStores(async ({ configured, competing }) => {
      const privateIdentity = {
        ...identity,
        sessionId: "private-session",
        sessionKey: "agent:main:dashboard:incognito-configured-store",
      };
      await seedTranscript(
        { ...privateIdentity, storePath: configured.storePath },
        "Private message",
      );
      for (const target of [
        privateIdentity,
        { ...privateIdentity, storePath: competing.storePath },
      ]) {
        expect(messageContents(await readSessionTranscriptEvents(target))).toEqual([
          "Private message",
        ]);
      }
      for (const durable of [configured, competing]) {
        expect(
          await readSessionTranscriptEvents({ ...durable, sessionId: privateIdentity.sessionId }),
        ).toEqual([]);
      }
    });
  });
});
