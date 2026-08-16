// Slack tests cover cursor pagination behavior.
import { describe, expect, it, vi } from "vitest";
import { collectSlackCursorPages } from "./cursor-pages.js";

type MockPage = {
  items: string[];
  response_metadata?: { next_cursor?: string };
};

function collect(fetchPage: (cursor?: string) => Promise<MockPage>) {
  return collectSlackCursorPages<string, MockPage>({
    fetchPage,
    collectPageItems: (response) => response.items,
  });
}

describe("collectSlackCursorPages", () => {
  it("collects a single page without a cursor", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ items: ["a", "b"] });

    await expect(collect(fetchPage)).resolves.toEqual(["a", "b"]);
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(fetchPage).toHaveBeenCalledWith(undefined);
  });

  it("collects pages while cursors advance", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: ["a"],
        response_metadata: { next_cursor: "cursor-1" },
      })
      .mockResolvedValueOnce({
        items: ["b"],
        response_metadata: { next_cursor: "cursor-2" },
      })
      .mockResolvedValueOnce({ items: ["c"], response_metadata: { next_cursor: "" } });

    await expect(collect(fetchPage)).resolves.toEqual(["a", "b", "c"]);
    expect(fetchPage.mock.calls).toEqual([[undefined], ["cursor-1"], ["cursor-2"]]);
  });

  it("rejects a repeated cursor before another request", async () => {
    const fetchPage = vi.fn().mockResolvedValue({
      items: [],
      response_metadata: { next_cursor: "cursor-loop" },
    });

    await expect(collect(fetchPage)).rejects.toThrow(
      "Slack cursor pagination repeated a cursor after 2 pages",
    );
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("rejects a multi-cursor cycle", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [], response_metadata: { next_cursor: "cursor-a" } })
      .mockResolvedValueOnce({ items: [], response_metadata: { next_cursor: "cursor-b" } })
      .mockResolvedValueOnce({ items: [], response_metadata: { next_cursor: "cursor-a" } });

    await expect(collect(fetchPage)).rejects.toThrow(
      "Slack cursor pagination repeated a cursor after 3 pages",
    );
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("treats a whitespace-only cursor as terminal", async () => {
    const fetchPage = vi.fn().mockResolvedValue({
      items: ["done"],
      response_metadata: { next_cursor: "   " },
    });

    await expect(collect(fetchPage)).resolves.toEqual(["done"]);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("enforces the advancing-cursor page backstop", async () => {
    const fetchPage = vi.fn(async (cursor?: string) => ({
      items: [],
      response_metadata: { next_cursor: String(Number(cursor ?? "0") + 1) },
    }));

    await expect(collect(fetchPage)).rejects.toThrow(
      "Slack cursor pagination exceeded 10000 pages",
    );
    expect(fetchPage).toHaveBeenCalledTimes(10_000);
  });
});
