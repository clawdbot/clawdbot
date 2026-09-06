import { describe, expect, it, vi } from "vitest";
import type { CodexThreadItem } from "./app-server/protocol.js";
import { toGenericTranscriptItem } from "./session-catalog-transcript-item.js";
import type { CodexSessionCatalogControl } from "./session-catalog-types.js";
import {
  CODEX_LOCAL_SESSION_HOST_ID,
  catalogThreadItem,
  createEligibleControl,
  createRuntime,
  idleThread,
  readCodexSessionTranscript,
} from "./session-catalog.test-helpers.js";

function nativeItemControl(source: CodexThreadItem[]) {
  const listItemPage = vi.fn<CodexSessionCatalogControl["listItemPage"]>(
    async ({ cursor, limit }) => {
      const newestFirst = source.toReversed();
      const anchor = cursor ? newestFirst.findIndex((item) => cursor === `native:${item.id}`) : -1;
      if (cursor && anchor < 0) {
        throw new Error("native item anchor is unavailable");
      }
      const selected = newestFirst.slice(anchor + 1, anchor + 1 + limit);
      const last = selected.at(-1);
      return {
        data: selected.map((item) => ({ turnId: "turn-1", item })),
        ...(last && anchor + 1 + selected.length < source.length
          ? { nextCursor: `native:${last.id}` }
          : {}),
      };
    },
  );
  return {
    listItemPage,
    control: createEligibleControl({
      requireEligibleThread: vi.fn(async () => idleThread({ historyMode: "paginated" })),
      listItemPage,
      listTurnPage: vi.fn(async () => ({
        data: [{ id: "turn-1", items: [...source] }],
        backwardsCursor: "native-turn:turn-1",
      })),
    }),
  };
}

function readTranscript(control: CodexSessionCatalogControl, limit: number, cursor?: string) {
  return readCodexSessionTranscript({
    runtime: createRuntime().runtime,
    control,
    hostId: CODEX_LOCAL_SESSION_HOST_ID,
    threadId: "thread-1",
    limit,
    ...(cursor ? { cursor } : {}),
  });
}

describe("Codex catalog transcript", () => {
  it("preserves full tool text and raw data before transport paging", () => {
    const output = "result ".repeat(1000);
    const source = catalogThreadItem("tool-1", {
      type: "commandExecution",
      command: "rg pattern",
      aggregatedOutput: output,
      exitCode: 0,
    });

    expect(toGenericTranscriptItem(source)).toEqual({
      id: "tool-1",
      type: "toolResult",
      text: output,
      raw: source,
    });
  });

  it("keeps native item order and cursors when the requested page size changes", async () => {
    const source = Array.from({ length: 8 }, (_, index) =>
      catalogThreadItem(`item-${index}`, { text: `message ${index}` }),
    );
    const { control, listItemPage } = nativeItemControl(source);

    const first = await readTranscript(control, 3);
    const second = await readTranscript(control, 2, first.nextCursor);
    const third = await readTranscript(control, 4, second.nextCursor);

    expect(first.items.map((item) => item.id)).toEqual(["item-7", "item-6", "item-5"]);
    expect(second.items.map((item) => item.id)).toEqual(["item-4", "item-3"]);
    expect(third.items.map((item) => item.id)).toEqual(["item-2", "item-1", "item-0"]);
    expect(first.nextCursor).toBe("native:item-5");
    expect(second.nextCursor).toBe("native:item-3");
    expect(third.nextCursor).toBeUndefined();
    expect(first).not.toHaveProperty("backwardsCursor");
    expect(listItemPage).toHaveBeenNthCalledWith(2, {
      threadId: "thread-1",
      limit: 2,
      sortDirection: "desc",
      cursor: first.nextCursor,
    });
  });

  it("returns only 50 items from a native turn containing 57 items", async () => {
    const source = Array.from({ length: 57 }, (_, index) =>
      catalogThreadItem(`item-${index}`, { text: `message ${index}` }),
    );
    const { control } = nativeItemControl(source);

    const first = await readTranscript(control, 50);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBe("native:item-7");

    const second = await readTranscript(control, 50, first.nextCursor);
    expect(second.items).toHaveLength(7);
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(
      source.toReversed().map((item) => item.id),
    );
    expect(second.nextCursor).toBeUndefined();
  });

  it("cuts native pages by wire bytes without losing raw output or advancing past omitted items", async () => {
    const output = "海🌱\n".repeat(80_000);
    const source = Array.from({ length: 36 }, (_, index) =>
      catalogThreadItem(`tool-${index}`, {
        type: "commandExecution",
        aggregatedOutput: output,
      }),
    );
    const { control, listItemPage } = nativeItemControl(source);
    const first = await readTranscript(control, 50);
    const second = await readTranscript(control, 7, first.nextCursor);
    const third = await readTranscript(control, 50, second.nextCursor);
    const fourth = third.nextCursor
      ? await readTranscript(control, 50, third.nextCursor)
      : undefined;
    const pages = fourth ? [first, second, third, fourth] : [first, second, third];
    const delivered = pages.flatMap((page) => page.items);

    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThan(source.length);
    expect(first.nextCursor).toBe(`native:${first.items.at(-1)?.id}`);
    expect(listItemPage.mock.calls[1]?.[0].limit).toBeLessThan(50);
    expect(delivered.map((item) => item.id)).toEqual(source.toReversed().map((item) => item.id));
    expect(pages.at(-1)?.nextCursor).toBeUndefined();
    for (const page of pages) {
      expect(
        Buffer.byteLength(JSON.stringify({ payloadJSON: JSON.stringify(page) }), "utf8"),
      ).toBeLessThanOrEqual(20 * 1024 * 1024);
    }
    for (const item of delivered) {
      expect(item.raw).toMatchObject({ aggregatedOutput: output });
      expect(Buffer.byteLength(item.text ?? "", "utf8")).toBeLessThanOrEqual(512 * 1024);
      expect(item.text).toMatch(/…$/u);
      expect(item.truncated).toBe(true);
    }
    expect(source.every((item) => item.aggregatedOutput === output)).toBe(true);
  });

  it("fails visibly when one complete raw item cannot fit the wire budget", async () => {
    const { control } = nativeItemControl([
      catalogThreadItem("oversized", {
        type: "commandExecution",
        aggregatedOutput: "x".repeat(20 * 1024 * 1024),
      }),
    ]);

    await expect(readTranscript(control, 1)).rejects.toThrow(
      "Codex transcript item exceeds the safe response size",
    );
  });

  it("resumes within a legacy turn after an append, then advances to the next native turn", async () => {
    const source = Array.from({ length: 7 }, (_, index) =>
      catalogThreadItem(`item-${index}`, { text: `message ${index}` }),
    );
    const listTurnPage = vi.fn<CodexSessionCatalogControl["listTurnPage"]>(async ({ cursor }) => {
      if (cursor === "older-turns") {
        return {
          data: [{ id: "older", items: [catalogThreadItem("oldest", { text: "oldest" })] }],
          backwardsCursor: "older-anchor",
        };
      }
      if (cursor && cursor !== "turn-anchor") {
        throw new Error("unexpected native turn cursor");
      }
      return {
        data: [{ id: "turn-1", items: [...source] }],
        backwardsCursor: "turn-anchor",
        nextCursor: "older-turns",
      };
    });
    const control = createEligibleControl({ listTurnPage });

    const first = await readTranscript(control, 3);
    source.push(catalogThreadItem("appended", { text: "newer message" }));
    const second = await readTranscript(control, 2, first.nextCursor);
    const third = await readTranscript(control, 4, second.nextCursor);
    const fourth = await readTranscript(control, 4, third.nextCursor);

    expect(
      [first, second, third, fourth].flatMap((page) => page.items.map((item) => item.id)),
    ).toEqual(["item-6", "item-5", "item-4", "item-3", "item-2", "item-1", "item-0", "oldest"]);
    expect(third.nextCursor).toBe("older-turns");
    expect(fourth.nextCursor).toBeUndefined();
    expect(listTurnPage.mock.calls.map(([request]) => request.limit)).toEqual([1, 1, 1, 1]);
    expect(listTurnPage.mock.calls[1]?.[0].cursor).toBe("turn-anchor");
  });

  it("reports a removed legacy item anchor instead of restarting its page", async () => {
    const source = ["oldest", "middle", "newest"].map((id) => catalogThreadItem(id, { text: id }));
    const control = createEligibleControl({
      listTurnPage: vi.fn(async () => ({
        data: [{ id: "turn-1", items: [...source] }],
        backwardsCursor: "turn-anchor",
      })),
    });
    const first = await readTranscript(control, 1);
    source.pop();

    await expect(readTranscript(control, 2, first.nextCursor)).rejects.toThrow(
      "Codex transcript changed; refresh the session before loading older items",
    );
  });

  it("reports an absent native turn anchor instead of dropping the remainder", async () => {
    const control = createEligibleControl({
      listTurnPage: vi.fn(async () => ({
        data: [
          {
            id: "turn-1",
            items: [
              catalogThreadItem("oldest", { text: "oldest" }),
              catalogThreadItem("newest", { text: "newest" }),
            ],
          },
        ],
      })),
    });

    await expect(readTranscript(control, 1)).rejects.toThrow(
      "Codex app-server did not provide a transcript continuation anchor",
    );
  });
});
