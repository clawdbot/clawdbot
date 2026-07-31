import { afterEach, describe, expect, it, vi } from "vitest";
import { collectMcpPaginatedItems } from "./mcp-pagination.js";

const limits = {
  timeoutMs: 1_000,
  maxPages: 4,
  maxItems: 8,
  maxBytes: 1_024,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("collectMcpPaginatedItems", () => {
  it.each(["tool", "resource", "prompt"])(
    "preserves normal %s ordering and treats an empty cursor as present",
    async (operation) => {
      const cursors: Array<string | undefined> = [];
      const result = await collectMcpPaginatedItems({
        label: `MCP ${operation} listing`,
        itemLabel: `${operation}s`,
        ...limits,
        loadPage: async ({ cursor }) => {
          cursors.push(cursor);
          return cursor === undefined
            ? { items: [`${operation}-one`], nextCursor: "" }
            : { items: [`${operation}-two`] };
        },
      });

      expect(cursors).toEqual([undefined, ""]);
      expect(result).toEqual([`${operation}-one`, `${operation}-two`]);
    },
  );

  it("rejects repeated and cyclic cursors", async () => {
    await expect(
      collectMcpPaginatedItems({
        label: "MCP tool listing",
        itemLabel: "tools",
        ...limits,
        loadPage: async ({ cursor }) => ({
          items: [cursor ?? "first"],
          nextCursor: cursor === undefined ? "a" : cursor === "a" ? "b" : "a",
        }),
      }),
    ).rejects.toThrow("repeated pagination cursor");
  });

  it("bounds endless pages, retained items, and aggregate serialized bytes", async () => {
    await expect(
      collectMcpPaginatedItems({
        label: "MCP tool listing",
        itemLabel: "tools",
        ...limits,
        maxPages: 2,
        loadPage: async ({ cursor }) => ({
          items: [cursor ?? "first"],
          nextCursor: `${cursor ?? "cursor"}-next`,
        }),
      }),
    ).rejects.toThrow("exceeded 2 pages");

    await expect(
      collectMcpPaginatedItems({
        label: "MCP resource listing",
        itemLabel: "resources",
        ...limits,
        maxItems: 2,
        loadPage: async () => ({ items: ["one", "two", "three"] }),
      }),
    ).rejects.toThrow("exceeded 2 resources");

    await expect(
      collectMcpPaginatedItems({
        label: "MCP prompt listing",
        itemLabel: "prompts",
        ...limits,
        maxBytes: 64,
        loadPage: async () => ({
          items: ["prompt"],
          serializedValue: { prompts: [{ description: "x".repeat(128) }] },
        }),
      }),
    ).rejects.toThrow("exceeded 64 bytes");
  });

  it("gives every page only the remaining absolute deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const requestTimeouts: number[] = [];
    let page = 0;
    const listing = collectMcpPaginatedItems({
      label: "MCP tool listing",
      itemLabel: "tools",
      ...limits,
      timeoutMs: 50,
      loadPage: async ({ timeoutMs }) => {
        requestTimeouts.push(timeoutMs);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 30);
        });
        page += 1;
        return { items: [`tool-${page}`], nextCursor: `cursor-${page}` };
      },
    });
    const rejected = expect(listing).rejects.toThrow("timed out after 50ms");

    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(requestTimeouts).toEqual([50, 20]);
  });

  it("aborts an in-flight page through the caller signal", async () => {
    const controller = new AbortController();
    const listing = collectMcpPaginatedItems({
      label: "MCP prompt listing",
      itemLabel: "prompts",
      ...limits,
      signal: controller.signal,
      loadPage: async ({ signal }) =>
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });

    controller.abort(new Error("runtime disposed"));
    await expect(listing).rejects.toThrow("runtime disposed");
  });
});
