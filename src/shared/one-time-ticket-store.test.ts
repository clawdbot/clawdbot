import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOneTimeTicketStore } from "./one-time-ticket-store.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("one-time ticket store", () => {
  it("revokes an unconsumed ticket on abort without reporting expiry", () => {
    const requester = new AbortController();
    const onExpire = vi.fn();
    const store = createOneTimeTicketStore<string>({ ttlMs: 100, onExpire });
    const { token } = store.mint("observer", { revokeSignal: requester.signal });

    requester.abort();

    expect(store.size).toBe(0);
    expect(store.consume(token)).toBeUndefined();
    expect(getEventListeners(requester.signal, "abort")).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it.each(["consume", "delete", "expire", "clear"])(
    "releases the revocation listener on %s",
    (end) => {
      const requester = new AbortController();
      const store = createOneTimeTicketStore<string>({ ttlMs: 100 });
      const { token } = store.mint("observer", { revokeSignal: requester.signal });
      expect(getEventListeners(requester.signal, "abort")).toHaveLength(1);

      if (end === "consume") {
        expect(store.consume(token)).toBe("observer");
      } else if (end === "delete") {
        expect(store.delete(token)).toBe(true);
      } else if (end === "expire") {
        vi.advanceTimersByTime(100);
      } else {
        store.clear();
      }

      expect(getEventListeners(requester.signal, "abort")).toHaveLength(0);
      requester.abort();
      expect(store.consume(token)).toBeUndefined();
    },
  );

  it("returns an immediately revoked token for an already-aborted signal", () => {
    const requester = new AbortController();
    requester.abort();
    const onExpire = vi.fn();
    const store = createOneTimeTicketStore<string>({ ttlMs: 100, onExpire });

    const { token } = store.mint("observer", { revokeSignal: requester.signal });

    expect(token).toMatch(/^[a-f0-9]{48}$/u);
    expect(store.size).toBe(0);
    expect(store.consume(token)).toBeUndefined();
    expect(getEventListeners(requester.signal, "abort")).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("mints opaque tickets and consumes a trimmed token only once", () => {
    const store = createOneTimeTicketStore<{ session: string }>({ ttlMs: 60_000 });
    const payload = { session: "observer" };
    const minted = store.mint(payload, { nowMs: 1_000 });

    expect(minted.token).toMatch(/^[a-f0-9]{48}$/u);
    expect(minted.expiresAtMs).toBe(61_000);
    expect(store.size).toBe(1);
    expect(store.consume(` \t${minted.token}\n`, 60_999)).toBe(payload);
    expect(store.size).toBe(0);
    expect(store.consume(minted.token, 60_999)).toBeUndefined();
  });

  it("deletes a ticket without redeeming it or reporting expiry", () => {
    const onExpire = vi.fn();
    const store = createOneTimeTicketStore<string>({ ttlMs: 100, onExpire });
    const minted = store.mint("observer");

    expect(store.delete(minted.token)).toBe(true);
    expect(store.delete(minted.token)).toBe(false);
    expect(store.size).toBe(0);
    vi.advanceTimersByTime(100);
    expect(onExpire).not.toHaveBeenCalled();
    expect(store.consume(minted.token)).toBeUndefined();
  });

  it.each(["", " ", "a".repeat(47), "a".repeat(49), "A".repeat(48), "g".repeat(48)])(
    "rejects malformed token %j without consuming another ticket",
    (token) => {
      const store = createOneTimeTicketStore<string>({ ttlMs: 60_000 });
      const minted = store.mint("observer");

      expect(store.consume(token)).toBeUndefined();
      expect(store.size).toBe(1);
      expect(store.consume(minted.token)).toBe("observer");
    },
  );

  it("honors the injected clock and per-ticket TTL and clock overrides", () => {
    let nowMs = 1_000;
    const store = createOneTimeTicketStore<string>({ ttlMs: 60_000, now: () => nowMs });
    const defaultTicket = store.mint("default");
    const override = store.mint("override", { ttlMs: 100, nowMs: 2_000 });

    expect(defaultTicket.expiresAtMs).toBe(61_000);
    expect(override.expiresAtMs).toBe(2_100);
    nowMs = 2_099;
    expect(store.consume(override.token)).toBe("override");
    expect(store.consume(defaultTicket.token, 61_000)).toBeUndefined();
    expect(store.consume(defaultTicket.token, 1_000)).toBeUndefined();
  });

  it("expires unconsumed tickets by timer even when the clock has not advanced", () => {
    const onExpire = vi.fn();
    const store = createOneTimeTicketStore<string>({ ttlMs: 100, now: () => 1_000, onExpire });
    const minted = store.mint("observer");

    vi.advanceTimersByTime(100);

    expect(store.size).toBe(0);
    expect(onExpire).toHaveBeenCalledExactlyOnceWith("observer", minted.token);
    expect(store.consume(minted.token, 1_000)).toBeUndefined();
    store.clear();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("clears pending tickets and cancels their expiry callbacks", () => {
    const onExpire = vi.fn();
    const store = createOneTimeTicketStore<string>({ ttlMs: 100, onExpire });
    const consumed = store.mint("consumed");
    const first = store.mint("first");
    const second = store.mint("second");
    expect(store.consume(consumed.token)).toBe("consumed");

    store.clear();

    expect(store.size).toBe(0);
    expect(onExpire.mock.calls).toEqual([
      ["first", first.token],
      ["second", second.token],
    ]);
    expect(store.consume(first.token)).toBeUndefined();
    expect(store.consume(second.token)).toBeUndefined();
    vi.advanceTimersByTime(100);
    expect(onExpire).toHaveBeenCalledTimes(2);
  });
});
