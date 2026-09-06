import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  isPublicSessionShareActive,
  readPublicSessionShare,
} from "./control-ui-public-session-read.js";
import * as transcriptReaders from "./session-transcript-readers.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
const locator = {
  agentId: "main",
  sessionKey: "agent:main:public-history",
  sessionId: "public-history-generation",
  shareId: "a".repeat(48),
};

async function seed(messages: string[], target = locator) {
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    updatedAt: 1,
    label: "Public example",
    publicShare: { id: target.shareId, sessionId: target.sessionId, createdAt: 1 },
  });
  await replaceTranscriptEvents(target, [
    { type: "session", version: 3, id: target.sessionId },
    ...messages.map((content, index) => ({
      type: "message",
      id: `message-${index}`,
      parentId: index ? `message-${index - 1}` : null,
      message: { role: "user", content },
    })),
  ]);
}

describe("anonymous published session reader", () => {
  it("pages exact published history using source positions rather than rendered counts", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed(Array.from({ length: 205 }, (_, index) => `Message ${index}`));
      const latest = await readPublicSessionShare(cfg, locator);
      expect(latest).toMatchObject({
        title: "Public example",
        totalMessages: 205,
        olderOffset: 100,
        truncated: false,
      });
      expect(latest?.messages).toHaveLength(100);
      expect(latest?.messages[0]).toMatchObject({ content: "Message 105" });
      const older = await readPublicSessionShare(cfg, locator, { offset: latest?.olderOffset });
      expect(older?.olderOffset).toBe(200);
      expect(older?.messages[0]).toMatchObject({ content: "Message 5" });
      const first = await readPublicSessionShare(cfg, locator, { offset: older?.olderOffset });
      expect(first?.messages).toHaveLength(5);
      expect(first?.olderOffset).toBeUndefined();
    });
  });

  it("enforces the byte bound and advances past oversized source rows without losing older messages", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed(["Oldest", "x".repeat(1024 * 1024 + 1), "Newest"]);
      const latest = await readPublicSessionShare(cfg, locator);
      expect(latest?.messages).toMatchObject([{ content: "Newest" }]);
      expect(latest?.olderOffset).toBe(1);
      const oversized = await readPublicSessionShare(cfg, locator, { offset: 1 });
      expect(oversized).toMatchObject({ messages: [], truncated: true, olderOffset: 2 });
      const oldest = await readPublicSessionShare(cfg, locator, { offset: 2 });
      expect(oldest?.messages).toMatchObject([{ content: "Oldest" }]);
      expect(oldest?.olderOffset).toBeUndefined();
    });
  });

  it("rejects private, unknown-agent, mismatched-instance and mismatched-grant requests", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed(["Published"]);
      expect(isPublicSessionShareActive(cfg, locator)).toBe(true);
      for (const target of [
        { ...locator, agentId: "other" },
        { ...locator, sessionKey: "agent:other:public-history" },
        { ...locator, sessionKey: "main" },
        { ...locator, sessionId: "old-generation" },
        { ...locator, shareId: "b".repeat(48) },
        { ...locator, sessionKey: "agent:main:incognito-private" },
      ]) {
        expect(await readPublicSessionShare(cfg, target)).toBeNull();
      }
      expect(await readPublicSessionShare({ agents: { entries: {} } }, locator)).toBeNull();
      await patchSessionEntryCore(locator, () => ({ publicShare: undefined }));
      expect(isPublicSessionShareActive(cfg, locator)).toBe(false);
      expect(await readPublicSessionShare(cfg, locator)).toBeNull();
    });
  });

  it.each(["revoke", "reset"] as const)(
    "rechecks %s after awaited history before releasing content",
    async (action) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await seed(["Must not escape after closure"]);
        const read = transcriptReaders.readSessionMessagesPageWithStatsAsync;
        vi.spyOn(transcriptReaders, "readSessionMessagesPageWithStatsAsync").mockImplementationOnce(
          async (...args) => {
            const result = await read(...args);
            await patchSessionEntryCore(locator, () =>
              action === "reset" ? { sessionId: "replacement" } : { publicShare: undefined },
            );
            return result;
          },
        );
        expect(await readPublicSessionShare(cfg, locator)).toBeNull();
        expect(loadSessionEntry(locator)?.publicShare).toBeUndefined();
      });
    },
  );

  it("reads the exact global node in its configured store without resolving aliases", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const global = { ...locator, sessionKey: "global" };
      await seed(["Global publication"], global);
      expect((await readPublicSessionShare(cfg, global))?.messages).toMatchObject([
        { content: "Global publication" },
      ]);
    });
  });
});
