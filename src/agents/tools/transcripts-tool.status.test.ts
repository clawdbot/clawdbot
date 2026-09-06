import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { TranscriptSourceProvider } from "../../transcripts/provider-types.js";
import { createTranscriptsTool } from "./transcripts-tool.js";

const { getTranscriptSourceProviderMock } = vi.hoisted(() => ({
  getTranscriptSourceProviderMock: vi.fn(),
}));
vi.mock("../../transcripts/provider-registry.js", () => ({
  getTranscriptSourceProvider: getTranscriptSourceProviderMock,
  listTranscriptSourceProviders: () => [],
}));
const tempDirs = createTempDirTracker();

describe("transcripts status display", () => {
  afterEach(() => {
    getTranscriptSourceProviderMock.mockReset();
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
  });

  it.each([
    { limit: "entry count", idChars: 24, count: 8, shown: 5 },
    { limit: "character budget", idChars: 900, count: 3, shown: 2 },
    { limit: "oversized source locator", idChars: 2_200, count: 1, shown: 1 },
  ])(
    "bounds status by $limit without clipping canonical selectors",
    async ({ idChars, count, shown }) => {
      getTranscriptSourceProviderMock.mockReturnValue({
        id: "room-audio",
        name: "Room Audio",
        sourceKinds: ["live-audio"],
        start: async (request) => ({ ok: true, session: request.session }),
        stop: async (request) => ({ ok: true, sessionId: request.sessionId }),
      } satisfies TranscriptSourceProvider);
      const tool = createTranscriptsTool({
        stateDir: tempDirs.make("openclaw-transcripts-status-"),
        caller: { kind: "operator", source: "local" },
      });
      const sessionIds = [
        ...Array.from({ length: count }, (_, index) => `notes-${index}-${"?".repeat(idChars)}`),
        "readable-tail",
      ];
      const startedSessionIds: string[] = [];
      const selectors: string[] = [];
      try {
        for (const sessionId of sessionIds) {
          const result = await tool.execute("budget-start", {
            action: "start",
            providerId: "room-audio",
            sessionId,
            title: "Long meeting title\n".repeat(100),
            channelId: sessionId === "readable-tail" ? "room-a" : "r".repeat(idChars),
          });
          startedSessionIds.push(sessionId);
          const text = result.content.find((item) => item.type === "text")?.text ?? "";
          const selector = text.match(/\nSelector: (.+)$/)?.[1];
          if (typeof selector !== "string") {
            throw new Error("Start must return a canonical selector");
          }
          selectors.push(selector);
        }
        const result = await tool.execute("budget-status", { action: "status" });
        const text = result.content.find((item) => item.type === "text")?.text ?? "";
        const listing = text.split("\n").slice(2).join("\n");
        const rows = listing.split("\n").filter((line) => line.startsWith("{"));
        expect(listing.length).toBeLessThanOrEqual(2_000);
        expect(rows).toHaveLength(shown);
        expect(listing).toContain("active sessions omitted (display limit)");
        for (const row of rows) {
          expect(selectors).toContain(JSON.parse(row).selector);
        }
        if (idChars > 24) {
          expect(rows.some((row) => JSON.parse(row).selector === selectors.at(-1))).toBe(true);
        }
        expect(result.details).toMatchObject({
          active: sessionIds.map((sessionId) => expect.objectContaining({ sessionId })),
        });
      } finally {
        for (const sessionId of startedSessionIds) {
          await tool.execute("budget-stop", { action: "stop", sessionId });
        }
      }
    },
  );
});
