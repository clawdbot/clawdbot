import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runIMessageCatchup } from "./catchup-bridge.js";
import { resolveCatchupConfig } from "./catchup.js";
import type { IMessagePayload } from "./types.js";

type RpcCall = {
  method: string;
  params: unknown;
};

function makeFakeClient(responder: (call: RpcCall) => unknown): {
  client: {
    request: <T>(method: string, params: unknown) => Promise<T>;
  };
  calls: RpcCall[];
} {
  const calls: RpcCall[] = [];
  const client = {
    request: async <T>(method: string, params: unknown): Promise<T> => {
      calls.push({ method, params });
      return responder({ method, params }) as T;
    },
  };
  return { client, calls };
}

function makeRow(opts: {
  id: number;
  guid: string;
  chat_id: number;
  created_at: string;
  is_from_me?: boolean;
  text?: string;
  sender?: string;
}): Record<string, unknown> {
  return {
    id: opts.id,
    guid: opts.guid,
    chat_id: opts.chat_id,
    sender: opts.sender ?? "+15551234",
    is_from_me: opts.is_from_me ?? false,
    text: opts.text ?? "hello",
    created_at: opts.created_at,
    chat_identifier: "+15551234",
    chat_guid: `iMessage;-;${opts.sender ?? "+15551234"}`,
    is_group: false,
  };
}

describe("runIMessageCatchup", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-catchup-bridge-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("fetches chats then per-chat history and dispatches each row in rowid order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    const dispatched: IMessagePayload[] = [];
    const { client, calls } = makeFakeClient(({ method, params }) => {
      if (method === "chats.list") {
        return {
          chats: [
            { id: 1, last_message_at: "2026-05-08T11:55:00.000Z" },
            { id: 2, last_message_at: "2026-05-08T11:50:00.000Z" },
          ],
        };
      }
      if (method === "messages.history") {
        const p = params as { chat_id: number };
        if (p.chat_id === 1) {
          return {
            messages: [
              makeRow({ id: 102, guid: "g-102", chat_id: 1, created_at: "2026-05-08T11:55:00Z" }),
              makeRow({ id: 100, guid: "g-100", chat_id: 1, created_at: "2026-05-08T11:50:00Z" }),
            ],
          };
        }
        return {
          messages: [
            makeRow({ id: 101, guid: "g-101", chat_id: 2, created_at: "2026-05-08T11:51:00Z" }),
          ],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const summary = await runIMessageCatchup({
      client: client as never,
      accountId: "default",
      config: resolveCatchupConfig({ enabled: true, perRunLimit: 50, maxAgeMinutes: 60 }),
      includeAttachments: false,
      dispatchPayload: async (msg) => {
        dispatched.push(msg);
      },
    });

    expect(summary.querySucceeded).toBe(true);
    expect(summary.replayed).toBe(3);
    expect(dispatched.map((m) => m.guid)).toEqual(["g-100", "g-101", "g-102"]);
    expect(calls[0]?.method).toBe("chats.list");
    expect(calls.filter((c) => c.method === "messages.history")).toHaveLength(2);
  });

  it("skips chats whose last_message_at is older than the catchup window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    let historyCalls = 0;
    const { client } = makeFakeClient(({ method, params }) => {
      if (method === "chats.list") {
        return {
          chats: [
            { id: 1, last_message_at: "2026-05-08T11:55:00.000Z" },
            { id: 99, last_message_at: "2025-12-01T00:00:00.000Z" }, // ancient
          ],
        };
      }
      if (method === "messages.history") {
        historyCalls += 1;
        const p = params as { chat_id: number };
        return {
          messages: [
            makeRow({
              id: 200,
              guid: `g-${p.chat_id}`,
              chat_id: p.chat_id,
              created_at: "2026-05-08T11:55:00Z",
            }),
          ],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const summary = await runIMessageCatchup({
      client: client as never,
      accountId: "default",
      config: resolveCatchupConfig({ enabled: true, perRunLimit: 50, maxAgeMinutes: 60 }),
      includeAttachments: false,
      dispatchPayload: async () => {},
    });

    expect(summary.querySucceeded).toBe(true);
    expect(historyCalls).toBe(1);
    expect(summary.replayed).toBe(1);
  });

  it("returns querySucceeded=false when chats.list throws", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    const { client } = makeFakeClient(({ method }) => {
      if (method === "chats.list") {
        throw new Error("rpc timeout");
      }
      throw new Error(`unexpected method ${method}`);
    });

    const summary = await runIMessageCatchup({
      client: client as never,
      accountId: "default",
      config: resolveCatchupConfig({ enabled: true, perRunLimit: 50, maxAgeMinutes: 60 }),
      includeAttachments: false,
      dispatchPayload: async () => {
        throw new Error("dispatch should not be called when fetch fails");
      },
    });

    expect(summary.querySucceeded).toBe(false);
    expect(summary.replayed).toBe(0);
  });

  it("continues across chats when a single messages.history call throws", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    const dispatched: string[] = [];
    const { client } = makeFakeClient(({ method, params }) => {
      if (method === "chats.list") {
        return {
          chats: [
            { id: 1, last_message_at: "2026-05-08T11:55:00.000Z" },
            { id: 2, last_message_at: "2026-05-08T11:50:00.000Z" },
          ],
        };
      }
      if (method === "messages.history") {
        const p = params as { chat_id: number };
        if (p.chat_id === 1) {
          throw new Error("permission denied");
        }
        return {
          messages: [
            makeRow({ id: 300, guid: "g-300", chat_id: 2, created_at: "2026-05-08T11:51:00Z" }),
          ],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const summary = await runIMessageCatchup({
      client: client as never,
      accountId: "default",
      config: resolveCatchupConfig({ enabled: true, perRunLimit: 50, maxAgeMinutes: 60 }),
      includeAttachments: false,
      dispatchPayload: async (msg) => {
        if (msg.guid) {
          dispatched.push(msg.guid);
        }
      },
    });

    expect(summary.querySucceeded).toBe(true);
    expect(summary.replayed).toBe(1);
    expect(dispatched).toEqual(["g-300"]);
  });

  it("caps cross-chat results at perRunLimit, oldest first", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    const dispatched: string[] = [];
    const { client } = makeFakeClient(({ method, params }) => {
      if (method === "chats.list") {
        return {
          chats: [
            { id: 1, last_message_at: "2026-05-08T11:55:00.000Z" },
            { id: 2, last_message_at: "2026-05-08T11:55:00.000Z" },
          ],
        };
      }
      if (method === "messages.history") {
        const p = params as { chat_id: number };
        const base = p.chat_id * 100;
        return {
          messages: Array.from({ length: 4 }, (_, i) =>
            makeRow({
              id: base + i,
              guid: `g-${base + i}`,
              chat_id: p.chat_id,
              created_at: "2026-05-08T11:55:00Z",
            }),
          ),
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const summary = await runIMessageCatchup({
      client: client as never,
      accountId: "default",
      config: resolveCatchupConfig({ enabled: true, perRunLimit: 5, maxAgeMinutes: 60 }),
      includeAttachments: false,
      dispatchPayload: async (msg) => {
        if (msg.guid) {
          dispatched.push(msg.guid);
        }
      },
    });

    expect(summary.fetchedCount).toBe(5);
    expect(summary.replayed).toBe(5);
    // Oldest-first by rowid: 100, 101, 102, 103, 200 (chat 1's first 4, then chat 2's first).
    expect(dispatched).toEqual(["g-100", "g-101", "g-102", "g-103", "g-200"]);
    // Regression for clawsweeper #79387 finding: the cursor must NOT
    // advance past the last dispatched row when perRunLimit truncates
    // the cross-chat page. Without the cap-aware watermark clamp, the
    // bridge would emit a watermark covering the raw rows it dropped
    // (rowids 201, 202, 203 from chat 2), and the catchup loop would
    // persist `lastSeenRowid` past them — so the promised "next startup
    // picks up the rest" warning would lie and those rows would be
    // permanently lost. Cursor must stop at the last dispatched rowid (200).
    expect(summary.cursorAfter.lastSeenRowid).toBe(200);
  });

  it("treats a dispatch throw as a failure and holds the cursor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    const { client } = makeFakeClient(({ method }) => {
      if (method === "chats.list") {
        return { chats: [{ id: 1, last_message_at: "2026-05-08T11:55:00.000Z" }] };
      }
      return {
        messages: [
          makeRow({ id: 500, guid: "g-500", chat_id: 1, created_at: "2026-05-08T11:55:00Z" }),
        ],
      };
    });

    const summary = await runIMessageCatchup({
      client: client as never,
      accountId: "default",
      config: resolveCatchupConfig({
        enabled: true,
        perRunLimit: 50,
        maxAgeMinutes: 60,
        maxFailureRetries: 3,
      }),
      includeAttachments: false,
      dispatchPayload: async () => {
        throw new Error("model unavailable");
      },
    });

    expect(summary.failed).toBe(1);
    expect(summary.replayed).toBe(0);
    // Cursor clamps to `failed.rowid - 1` (== 499), strictly below the held
    // failure, so the next pass refetches row 500 — and never leapfrogs it.
    expect(summary.cursorAfter.lastSeenRowid).toBe(499);
  });

  it("emits a high-watermark even when every row fails payload validation", async () => {
    // Regression: without this, a chat whose only fresh row is unparseable
    // (corrupt text column, schema drift) would stall catchup forever — the
    // row never reaches the cursor loop, the cursor never advances past it,
    // the next pass re-fetches and re-drops the same row. The bridge probes
    // raw `id` / `created_at` per row before parsing and emits the highest
    // values it saw as a watermark so the cursor loop can still advance.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    const { client } = makeFakeClient(({ method }) => {
      if (method === "chats.list") {
        return { chats: [{ id: 1, last_message_at: "2026-05-08T11:55:00.000Z" }] };
      }
      return {
        messages: [
          // Junk row — wrong types in everything except id + created_at, so
          // parseIMessageNotification rejects it but the watermark probe
          // still records id=999 and the parsed created_at.
          {
            id: 999,
            guid: 42, // wrong type
            chat_id: "x", // wrong type
            sender: false, // wrong type
            is_from_me: "no", // wrong type
            text: 7, // wrong type
            created_at: "2026-05-08T11:55:00.000Z",
          },
        ],
      };
    });

    const summary = await runIMessageCatchup({
      client: client as never,
      accountId: "default",
      config: resolveCatchupConfig({ enabled: true, perRunLimit: 50, maxAgeMinutes: 60 }),
      includeAttachments: false,
      dispatchPayload: async () => {},
    });

    expect(summary.querySucceeded).toBe(true);
    expect(summary.replayed).toBe(0);
    expect(summary.fetchedCount).toBe(0);
    // Cursor advances to the watermark — next pass won't keep re-fetching this row.
    expect(summary.cursorAfter.lastSeenRowid).toBe(999);
  });

  it("filters rows that fail payload validation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    const dispatched: string[] = [];
    const { client } = makeFakeClient(({ method }) => {
      if (method === "chats.list") {
        return { chats: [{ id: 1, last_message_at: "2026-05-08T11:55:00.000Z" }] };
      }
      return {
        messages: [
          // Valid row.
          makeRow({ id: 600, guid: "g-600", chat_id: 1, created_at: "2026-05-08T11:55:00Z" }),
          // Junk row — wrong types — must be dropped silently.
          { id: "not-a-number", guid: 42, chat_id: "x" },
          // Missing guid.
          {
            ...makeRow({ id: 601, guid: "", chat_id: 1, created_at: "2026-05-08T11:55:00Z" }),
            guid: undefined,
          },
        ],
      };
    });

    const summary = await runIMessageCatchup({
      client: client as never,
      accountId: "default",
      config: resolveCatchupConfig({ enabled: true, perRunLimit: 50, maxAgeMinutes: 60 }),
      includeAttachments: false,
      dispatchPayload: async (msg) => {
        if (msg.guid) {
          dispatched.push(msg.guid);
        }
      },
    });

    expect(summary.replayed).toBe(1);
    expect(dispatched).toEqual(["g-600"]);
  });
});
