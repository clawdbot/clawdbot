import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ReefInboxConnection, ReefInboxEntryParkedError, type WebSocketLike } from "./transport.js";
import {
  ControlledSocket,
  createClient,
  parseRequestUrl,
  receiptEntry,
} from "./transport.test-helpers.js";

afterEach(() => vi.useRealTimers());

async function startInbox() {
  vi.useFakeTimers();
  const sockets: ControlledSocket[] = [];
  const retained = new Map<number, ReturnType<typeof receiptEntry>>();
  const parked = new Set<number>();
  const attempts: number[] = [];
  const completed: number[] = [];
  const persisted: number[] = [];
  const requestedAfter: number[] = [];
  const respond = (input: URL | RequestInfo) => {
    const after = Number(parseRequestUrl(input).searchParams.get("after"));
    requestedAfter.push(after);
    const entries = [...retained.values()]
      .filter((entry) => entry.seq > after)
      .toSorted((left, right) => left.seq - right.seq)
      .slice(0, 200);
    return Response.json({ entries, cursor: entries.at(-1)?.seq ?? after });
  };
  const fetcher = vi.fn<typeof fetch>(async (input) => respond(input));
  const abort = new AbortController();
  const inbox = new ReefInboxConnection(
    createClient(fetcher),
    async ([entry]) => {
      const seq = entry!.seq;
      attempts.push(seq);
      if (parked.has(seq)) {
        throw new ReefInboxEntryParkedError("review approval pending");
      }
      completed.push(seq);
    },
    () => {
      const socket = new ControlledSocket();
      sockets.push(socket);
      return socket as unknown as WebSocketLike;
    },
    { initialCursor: 7, persistCursor: (cursor) => persisted.push(cursor) },
  );
  const running = inbox.start(abort.signal);
  onTestFinished(async () => {
    abort.abort();
    await running;
  });
  sockets[0]!.emit("open");
  await vi.advanceTimersByTimeAsync(0);
  const notify = async (...sequences: number[]) => {
    for (const seq of sequences) {
      const entry = receiptEntry(seq);
      retained.set(seq, entry);
      sockets.at(-1)!.emit("message", { data: JSON.stringify({ type: "entry", entry }) });
    }
    await vi.advanceTimersByTimeAsync(0);
  };
  return {
    inbox,
    sockets,
    retained,
    parked,
    attempts,
    completed,
    persisted,
    requestedAfter,
    fetcher,
    respond,
    notify,
  };
}

describe("Reef parked cursor ownership", () => {
  it("holds multiple parks across reconnect and folds sparse completions without redelivery", async () => {
    const {
      inbox,
      sockets,
      retained,
      parked,
      persisted,
      completed,
      attempts,
      requestedAfter,
      notify,
    } = await startInbox();
    parked.add(8).add(12);
    for (const seq of [8, 10, 12, 15]) {
      retained.set(seq, receiptEntry(seq));
    }
    await inbox.poll();
    expect(requestedAfter).toEqual([7, 7]);
    expect(persisted).toEqual([]);
    expect(completed).toEqual([10, 15]);

    parked.delete(8);
    await inbox.poll();
    expect(persisted).toEqual([8, 10]);
    sockets[0]!.close();
    await vi.advanceTimersByTimeAsync(250);
    expect(sockets).toHaveLength(2);
    sockets[1]!.emit("open");
    await vi.advanceTimersByTimeAsync(0);
    const previousAttempts = [...attempts];
    await notify(20);
    expect(attempts).toEqual([...previousAttempts, 20]);
    expect(persisted).toEqual([8, 10]);

    parked.clear();
    await inbox.poll();
    expect(completed).toEqual([10, 15, 8, 20, 12]);
    expect(persisted).toEqual([8, 10, 12, 15, 20]);
    const pulls = requestedAfter.length;
    await notify(25);
    expect(persisted.at(-1)).toBe(25);
    expect(requestedAfter).toHaveLength(pulls);
  });

  it("publishes a REST park before queued live frames and retries only the parked entry", async () => {
    const { inbox, retained, parked, fetcher, respond, notify, persisted, completed, attempts } =
      await startInbox();
    parked.add(8);
    retained.set(8, receiptEntry(8));
    const pulling = createDeferred<void>();
    const release = createDeferred<void>();
    fetcher.mockImplementationOnce(async (input) => {
      const response = respond(input);
      pulling.resolve();
      await release.promise;
      return response;
    });
    const polling = inbox.poll();
    try {
      await pulling.promise;
      await notify(10);
      expect(attempts).toEqual([]);
    } finally {
      release.resolve();
      await polling;
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toEqual([8, 10]);
    expect(persisted).toEqual([]);
    parked.clear();
    await inbox.poll();
    expect(completed).toEqual([10, 8]);
    expect(persisted).toEqual([8, 10]);
  });

  it.each(["failure", "abort"] as const)(
    "retains an older barrier when a partial REST drain ends in %s",
    async (interruption) => {
      const { inbox, retained, parked, fetcher, respond, notify, persisted, completed } =
        await startInbox();
      parked.add(8);
      retained.set(8, receiptEntry(8));
      retained.set(9, receiptEntry(9));
      await inbox.poll();
      expect(persisted).toEqual([]);
      parked.clear();
      const pollAbort = new AbortController();
      const pulling = createDeferred<void>();
      const release = createDeferred<void>();
      fetcher.mockImplementationOnce(async (input) => respond(input));
      fetcher.mockImplementationOnce(async () => {
        pulling.resolve();
        await release.promise;
        throw new Error("partial pull failed");
      });
      const polling = inbox.poll(pollAbort.signal);
      const rejected = expect(polling).rejects.toThrow(
        interruption === "abort" ? /abort/i : "partial pull failed",
      );
      try {
        await pulling.promise;
        expect(persisted.at(-1)).toBe(9);
        if (interruption === "abort") {
          pollAbort.abort();
        }
      } finally {
        release.resolve();
        await rejected;
      }
      await notify(12);
      expect(persisted.at(-1)).toBe(9);
      expect(completed).toEqual([9, 8, 12]);
      await inbox.poll();
      expect(completed).toEqual([9, 8, 12]);
      expect(persisted.at(-1)).toBe(12);
    },
  );

  it("keeps a newly observed park when a later REST handler fails", async () => {
    const { inbox, retained, notify, persisted, completed } = await startInbox();
    retained.set(8, receiptEntry(8));
    retained.set(10, receiptEntry(10));
    const handler = vi.spyOn(inbox, "onEntries");
    handler.mockRejectedValueOnce(new ReefInboxEntryParkedError("pending review"));
    handler.mockRejectedValueOnce(new Error("handler failed"));
    await expect(inbox.poll()).rejects.toThrow("handler failed");
    await notify(12);
    expect(persisted).toEqual([]);
    expect(completed).toEqual([12]);
    await inbox.poll();
    expect(completed).toEqual([12, 8, 10]);
    expect(persisted).toEqual([8, 10, 12]);
  });

  it.each(["page gap", "tail", "empty mailbox"])(
    "prunes acknowledged completions in the %s without redispatching delayed live frames",
    async (absence) => {
      const { inbox, sockets, retained, parked, completed, persisted } = await startInbox();
      parked.add(8);
      for (const seq of [8, 10, 12]) {
        retained.set(seq, receiptEntry(seq));
      }
      await inbox.poll();
      expect(completed).toEqual([10, 12]);
      retained.delete(10);
      if (absence !== "page gap") {
        retained.delete(12);
      }
      if (absence === "empty mailbox") {
        retained.delete(8);
      }
      await inbox.poll();
      // Inspect cardinality only: acknowledged traffic must not accumulate
      // behind a long-lived park while the durable cursor cannot advance.
      expect(inbox["processedAboveCursor"].size).toBe(absence === "page gap" ? 1 : 0);
      sockets[0]!.emit("message", {
        data: JSON.stringify({ type: "entry", entry: receiptEntry(10) }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(completed).toEqual([10, 12]);
      expect(persisted).toEqual(absence === "empty mailbox" ? [12] : []);
    },
  );

  it.each(["retained completion", "empty mailbox"])(
    "clears an expired park after REST proves %s without replaying completed callbacks",
    async (recovery) => {
      const { inbox, retained, parked, notify, persisted, completed, requestedAfter } =
        await startInbox();
      parked.add(8);
      retained.set(8, receiptEntry(8));
      retained.set(12, receiptEntry(12));
      await inbox.poll();
      expect(persisted).toEqual([]);
      retained.delete(8);
      if (recovery === "empty mailbox") {
        retained.clear();
      }
      await inbox.poll();
      expect(completed).toEqual([12]);
      expect(persisted).toEqual([12]);
      const pulls = requestedAfter.length;
      await notify(15);
      expect(completed).toEqual([12, 15]);
      expect(persisted).toEqual([12, 15]);
      expect(requestedAfter).toHaveLength(pulls);
    },
  );
});
