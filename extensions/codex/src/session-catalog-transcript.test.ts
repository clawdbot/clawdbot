// One Codex turn can hold thousands of items and one item can hold megabytes of
// tool output, so these cover the two bounds a transcript read owes its client:
// bytes inside an item, and items inside a page.
import { describe, expect, it, vi } from "vitest";
import { toGenericTranscriptItem } from "./session-catalog-transcript-item.js";
import {
  CODEX_LOCAL_SESSION_HOST_ID,
  createEligibleControl,
  createRuntime,
  readCodexSessionTranscript,
} from "./session-catalog.test-helpers.js";

// Sized like a real `rg` sweep: big enough to bury a browser, small enough
// that the whole page still clears the app-server ingestion guard.
const HUGE_OUTPUT = "x".repeat(250 * 1024);

function turnPage(items: unknown[], nextCursor?: string) {
  return {
    data: [{ id: "turn-1", items }] as never,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function commandItem(id: string, output: string) {
  return {
    id,
    type: "commandExecution",
    command: ["rg", "pattern"],
    aggregatedOutput: output,
    exitCode: 0,
  };
}

describe("Codex transcript item projection", () => {
  it("previews oversized tool output instead of forwarding the whole payload", () => {
    const item = toGenericTranscriptItem(commandItem("item-1", HUGE_OUTPUT) as never);

    expect(item.type).toBe("toolResult");
    expect(item.truncated).toBe(true);
    expect(Buffer.byteLength(item.text ?? "", "utf8")).toBe(4096);
    expect(Buffer.byteLength(JSON.stringify(item), "utf8")).toBeLessThan(16 * 1024);
  });

  it("keeps small tool output whole and unflagged", () => {
    const item = toGenericTranscriptItem(commandItem("item-1", "3 matches") as never);

    expect(item.text).toBe("3 matches");
    expect(item.truncated).toBeUndefined();
  });

  it("leaves agent messages unclamped", () => {
    const text = "answer ".repeat(2000);
    const item = toGenericTranscriptItem({ id: "item-1", type: "agentMessage", text } as never);

    expect(item.text).toBe(text);
    expect(item.truncated).toBeUndefined();
  });
});

describe("Codex transcript read bounds", () => {
  it("bounds a turn page that holds more items than the requested limit", async () => {
    const items = Array.from({ length: 60 }, (_, index) =>
      commandItem(`item-${index}`, HUGE_OUTPUT),
    );
    const listTurnPage = vi.fn(async () => turnPage(items));

    const page = await readCodexSessionTranscript({
      runtime: createRuntime().runtime,
      control: createEligibleControl({ listTurnPage }),
      hostId: CODEX_LOCAL_SESSION_HOST_ID,
      threadId: "thread-1",
      limit: 50,
    });

    expect(page.items).toHaveLength(50);
    expect(page.items.every((item) => item.truncated === true)).toBe(true);
    // 60 items x 250 KB of tool output previously crossed the wire in one page,
    // doubled again by the raw item copy that rode along with it.
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThan(1024 * 1024);
    expect(page.nextCursor).toBeTruthy();
  });

  it("resumes inside the same upstream turn page, then advances to the next one", async () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      id: `item-${index}`,
      type: "agentMessage",
      text: `message ${index}`,
    }));
    const listTurnPage = vi.fn(async () => turnPage(items, "turns-page-2"));
    const control = createEligibleControl({ listTurnPage });
    const read = (cursor?: string) =>
      readCodexSessionTranscript({
        runtime: createRuntime().runtime,
        control,
        hostId: CODEX_LOCAL_SESSION_HOST_ID,
        threadId: "thread-1",
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });

    const first = await read();
    expect(first.items.map((item) => item.id)).toEqual(["item-4", "item-3"]);

    const second = await read(first.nextCursor);
    expect(second.items.map((item) => item.id)).toEqual(["item-2", "item-1"]);
    expect(listTurnPage).toHaveBeenLastCalledWith({
      threadId: "thread-1",
      limit: 2,
      sortDirection: "desc",
      itemsView: "full",
    });

    const third = await read(second.nextCursor);
    expect(third.items.map((item) => item.id)).toEqual(["item-0"]);

    // The turn page is exhausted, so the next cursor carries the upstream turn
    // cursor and restarts the item offset.
    const fourth = await read(third.nextCursor);
    expect(listTurnPage).toHaveBeenLastCalledWith({
      threadId: "thread-1",
      limit: 2,
      sortDirection: "desc",
      itemsView: "full",
      cursor: "turns-page-2",
    });
    expect(fourth.items.map((item) => item.id)).toEqual(["item-4", "item-3"]);
  });

  it("stops paging when the upstream page is exhausted and has no further turns", async () => {
    const listTurnPage = vi.fn(async () =>
      turnPage([{ id: "item-0", type: "agentMessage", text: "only" }]),
    );

    const page = await readCodexSessionTranscript({
      runtime: createRuntime().runtime,
      control: createEligibleControl({ listTurnPage }),
      hostId: CODEX_LOCAL_SESSION_HOST_ID,
      threadId: "thread-1",
      limit: 50,
    });

    expect(page.items.map((item) => item.id)).toEqual(["item-0"]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("keeps the upstream backwards cursor out of the read result", async () => {
    const listTurnPage = vi.fn(async () => ({
      data: [
        { id: "turn-1", items: [{ id: "item-0", type: "agentMessage", text: "only" }] },
      ] as never,
      backwardsCursor: "turns-page-0",
    }));

    const page = await readCodexSessionTranscript({
      runtime: createRuntime().runtime,
      control: createEligibleControl({ listTurnPage }),
      hostId: CODEX_LOCAL_SESSION_HOST_ID,
      threadId: "thread-1",
      limit: 50,
    });

    // The read result schema is closed and no client consumes it; leaking it
    // also hands back a cursor this read would reject on the way in.
    expect(page).not.toHaveProperty("backwardsCursor");
  });

  it("rejects a transcript cursor that is not a canonical composite cursor", async () => {
    const listTurnPage = vi.fn(async () => turnPage([]));

    await expect(
      readCodexSessionTranscript({
        runtime: createRuntime().runtime,
        control: createEligibleControl({ listTurnPage }),
        hostId: CODEX_LOCAL_SESSION_HOST_ID,
        threadId: "thread-1",
        limit: 50,
        cursor: "turns-page-2",
      }),
    ).rejects.toThrow(/transcript request cursor/);
    expect(listTurnPage).not.toHaveBeenCalled();
  });
});
