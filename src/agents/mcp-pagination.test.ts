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

  it("keeps the per-request safety budget behind one absolute deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const requestTimeouts: number[] = [];
    let page = 0;
    const listing = collectMcpPaginatedItems({
      label: "MCP tool listing",
      itemLabel: "tools",
      ...limits,
      timeoutMs: 50,
      loadPage: async ({ requestTimeoutMs }) => {
        requestTimeouts.push(requestTimeoutMs);
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
    expect(requestTimeouts).toEqual([50, 50]);
  });

  it("reports the collector deadline before a nested request timeout", async () => {
    vi.useFakeTimers();
    const listing = collectMcpPaginatedItems({
      label: "MCP resource listing",
      itemLabel: "resources",
      ...limits,
      timeoutMs: 50,
      loadPage: async ({ requestTimeoutMs }) =>
        await new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("nested request timed out")), requestTimeoutMs);
        }),
    });
    const rejected = expect(listing).rejects.toThrow("MCP resource listing timed out after 50ms");

    await vi.advanceTimersByTimeAsync(50);
    await rejected;
  });

  it("rejects a final page when synchronous processing crosses the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let mappedItems = 0;
    const listing = collectMcpPaginatedItems({
      label: "MCP resource listing",
      itemLabel: "resources",
      ...limits,
      timeoutMs: 50,
      loadPage: async () => ({ items: ["resource"] }),
      mapItem: (item) => {
        mappedItems += 1;
        vi.setSystemTime(1_050);
        return item;
      },
    });

    await expect(listing).rejects.toThrow("timed out after 50ms");
    expect(mappedItems).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects when a page loader synchronously aborts its caller before resolving", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let mappedItems = 0;
    const listing = collectMcpPaginatedItems({
      label: "MCP prompt listing",
      itemLabel: "prompts",
      ...limits,
      signal: controller.signal,
      loadPage: async () => {
        controller.abort("runtime disposed");
        return { items: ["must-not-return"] };
      },
      mapItem: (item) => {
        mappedItems += 1;
        return item;
      },
    });

    const failure = await listing.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ message: "MCP prompt listing aborted" });
    expect(mappedItems).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
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
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("MCP prompt listing aborted"),
              ),
            { once: true },
          );
        }),
    });

    controller.abort(new Error("runtime disposed"));
    await expect(listing).rejects.toThrow("runtime disposed");
  });
});
